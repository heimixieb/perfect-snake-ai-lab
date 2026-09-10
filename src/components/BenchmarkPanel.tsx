import { useEffect, useMemo, useRef, useState } from 'react';
import { SCENARIOS } from '../engine/scenarios';
import { AggregateResult, STRATEGIES, StrategyId } from '../engine/types';
import type { BenchMessage, BenchRequest } from '../engine/bench';
import { getScenario } from '../engine/scenarios';
import { aggregate, runGame } from '../engine/simulate';
import { GameResult } from '../engine/types';
import BenchWorker from '../workers/bench.worker?worker&inline';

/** 主线程回退：无法创建 Worker 时分片异步执行，避免阻塞 UI */
async function runOnMainThread(req: BenchRequest, post: (m: BenchMessage) => void, cancelled: () => boolean) {
  const total = req.scenarios.length * req.strategies.length * req.runs;
  let done = 0;
  for (const sid of req.scenarios) {
    const cfg = getScenario(sid);
    for (const st of req.strategies) {
      const results: GameResult[] = [];
      for (let i = 0; i < req.runs; i++) {
        if (cancelled()) return;
        const r = runGame(cfg, st, req.baseSeed + i);
        results.push(r);
        done++;
        post({ type: 'progress', done, total, scenario: sid, strategy: st, last: r });
        await new Promise((res) => setTimeout(res, 0));
      }
      post({ type: 'aggregate', scenario: sid, strategy: st, agg: aggregate(results) });
    }
  }
  post({ type: 'finished' });
}

const FAIL_TEXT: Record<string, string> = {
  wall: '撞墙',
  self: '撞自身',
  obstacle: '撞障碍',
  starved: '饥饿/死循环',
  'no-move': '被困',
  'step-limit': '步数上限',
};

type Key = string; // `${scenario}|${strategy}`

export default function BenchmarkPanel() {
  const runnable = useMemo(() => SCENARIOS.filter((s) => s.runnable), []);
  const [selScen, setSelScen] = useState<string[]>(['basic', 'medium', 'medium-cell']);
  const [selStrat, setSelStrat] = useState<StrategyId[]>(STRATEGIES.filter((s) => s.id !== 'manual').map((s) => s.id));
  const [runs, setRuns] = useState(10);
  const [baseSeed, setBaseSeed] = useState(1000);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [current, setCurrent] = useState('');
  const [results, setResults] = useState<Record<Key, AggregateResult>>({});
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const cancelRef = useRef(false);

  const start = () => {
    workerRef.current?.terminate();
    cancelRef.current = false;
    setResults({});
    setBusy(true);
    setProgress({ done: 0, total: selScen.length * selStrat.length * runs });
    const onMsg = (m: BenchMessage) => {
      if (m.type === 'progress') {
        setProgress({ done: m.done, total: m.total });
        setCurrent(`${m.scenario} · ${m.strategy} · seed ${m.last.seed} → ${m.last.won ? '通关' : m.last.failReason}`);
      } else if (m.type === 'aggregate') {
        setResults((r) => ({ ...r, [`${m.scenario}|${m.strategy}`]: m.agg }));
      } else if (m.type === 'finished') {
        setBusy(false);
        workerRef.current?.terminate();
        workerRef.current = null;
      }
    };
    const req: BenchRequest = { type: 'run', scenarios: selScen, strategies: selStrat, runs, baseSeed };
    try {
      const w = new BenchWorker();
      workerRef.current = w;
      w.onmessage = (e: MessageEvent<BenchMessage>) => onMsg(e.data);
      w.onerror = () => {
        w.terminate();
        workerRef.current = null;
        void runOnMainThread(req, onMsg, () => cancelRef.current);
      };
      w.postMessage(req);
    } catch {
      void runOnMainThread(req, onMsg, () => cancelRef.current);
    }
  };

  const stop = () => {
    cancelRef.current = true;
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(false);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ baseSeed, runs, results }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `snake-benchmark-seed${baseSeed}-runs${runs}.json`;
    a.click();
  };

  const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 rounded-xl border border-slate-700/60 bg-slate-800/60 p-4 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-200">难度场景（统一复现环境）</h3>
          <div className="space-y-1.5">
            {runnable.map((sc) => (
              <label key={sc.id} className="flex items-start gap-2 text-xs text-slate-300">
                <input type="checkbox" className="mt-0.5 accent-emerald-500" checked={selScen.includes(sc.id)} onChange={() => setSelScen((s) => toggle(s, sc.id))} />
                <span>
                  <span className="font-medium text-slate-100">{sc.name}</span>
                  <span className="text-slate-500">
                    {' '}
                    · {sc.width}×{sc.height} · 障碍 {(sc.obstacleDensity * 100).toFixed(0)}%({sc.obstacleMode}) · 食物 {sc.foodCount}
                    {Number.isFinite(sc.foodTTL) ? ` · 有效期 ${sc.foodTTL} 步` : ''} · 预算 {sc.timeBudgetMs}ms
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-200">参与对比的策略</h3>
          <div className="space-y-1.5">
            {STRATEGIES.map((st) => (
              <label key={st.id} className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" className="accent-emerald-500" checked={selStrat.includes(st.id)} onChange={() => setSelStrat((s) => toggle(s, st.id))} />
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: st.color }} />
                {st.name}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-3 text-xs text-slate-300">
          <label className="block">
            每组局数
            <input type="number" min={1} max={200} value={runs} onChange={(e) => setRuns(Math.max(1, Number(e.target.value)))} className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100" />
          </label>
          <label className="block">
            基础种子（第 i 局 seed = 基础种子 + i）
            <input type="number" value={baseSeed} onChange={(e) => setBaseSeed(Number(e.target.value))} className="mt-1 w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100" />
          </label>
          <div className="flex gap-2">
            {!busy ? (
              <button onClick={start} disabled={!selScen.length || !selStrat.length} className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 font-semibold text-white hover:bg-emerald-400 disabled:opacity-40">
                开始基准测试
              </button>
            ) : (
              <button onClick={stop} className="flex-1 rounded-lg bg-rose-500 px-3 py-2 font-semibold text-white hover:bg-rose-400">
                停止
              </button>
            )}
            <button onClick={exportJson} disabled={!Object.keys(results).length} className="rounded-lg bg-slate-700 px-3 py-2 font-semibold text-white hover:bg-slate-600 disabled:opacity-40">
              导出 JSON
            </button>
          </div>
          {(busy || progress.total > 0) && (
            <div>
              <div className="h-2 w-full overflow-hidden rounded bg-slate-700">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <p className="mt-1 truncate text-[11px] text-slate-500">
                {progress.done}/{progress.total} {current}
              </p>
            </div>
          )}
        </div>
      </div>

      {selScen.map((sid) => {
        const sc = SCENARIOS.find((s) => s.id === sid)!;
        const rows = selStrat.map((st) => results[`${sid}|${st}`]).filter(Boolean) as AggregateResult[];
        if (!rows.length) return null;
        return (
          <div key={sid} className="overflow-hidden rounded-xl border border-slate-700/60 bg-slate-800/60">
            <div className="border-b border-slate-700/60 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-100">
                {sc.name} <span className="ml-2 text-xs font-normal text-slate-400">{sc.description}</span>
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900/60 text-slate-400">
                  <tr>
                    {['策略', '通关率', '平均吃满率', '平均覆盖率', '平均总步数', '步数/食物', '平均决策 ms', '最大决策 ms', '超预算比例', '峰值节点', '峰值内存 KB', '失败原因'].map((h) => (
                      <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const info = STRATEGIES.find((s) => s.id === r.strategy)!;
                    return (
                      <tr key={r.strategy} className="border-t border-slate-700/40 text-slate-200">
                        <td className="whitespace-nowrap px-3 py-2">
                          <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: info.color }} />
                          {info.short}
                        </td>
                        <td className={`px-3 py-2 font-mono ${r.winRate === 1 ? 'text-emerald-400' : r.winRate === 0 ? 'text-rose-400' : 'text-amber-300'}`}>{(r.winRate * 100).toFixed(0)}%</td>
                        <td className="px-3 py-2 font-mono">{(r.avgFill * 100).toFixed(1)}%</td>
                        <td className="px-3 py-2 font-mono">{(r.avgCoverage * 100).toFixed(1)}%</td>
                        <td className="px-3 py-2 font-mono">{r.avgSteps.toFixed(0)}</td>
                        <td className="px-3 py-2 font-mono">{r.avgStepsPerFood.toFixed(1)}</td>
                        <td className="px-3 py-2 font-mono">{r.avgDecisionMs.toFixed(3)}</td>
                        <td className="px-3 py-2 font-mono">{r.maxDecisionMs.toFixed(2)}</td>
                        <td className="px-3 py-2 font-mono">{(r.overBudgetRate * 100).toFixed(2)}%</td>
                        <td className="px-3 py-2 font-mono">{r.avgPeakNodes.toFixed(0)}</td>
                        <td className="px-3 py-2 font-mono">{r.avgPeakMemKB.toFixed(1)}</td>
                        <td className="px-3 py-2 text-slate-400">
                          {Object.entries(r.failReasons)
                            .map(([k, v]) => `${FAIL_TEXT[k] ?? k}×${v}`)
                            .join('，') || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-slate-700/40 px-4 py-2">
              <FillBars rows={rows} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FillBars({ rows }: { rows: AggregateResult[] }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => {
        const info = STRATEGIES.find((s) => s.id === r.strategy)!;
        return (
          <div key={r.strategy} className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="w-24 shrink-0">{info.short}</span>
            <div className="h-2 flex-1 overflow-hidden rounded bg-slate-700">
              <div className="h-full" style={{ width: `${r.avgFill * 100}%`, background: info.color }} />
            </div>
            <span className="w-14 text-right font-mono">{(r.avgFill * 100).toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}
