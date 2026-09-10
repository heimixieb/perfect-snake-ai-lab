import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Game } from '../engine/game';
import { SCENARIOS } from '../engine/scenarios';
import { searchStats } from '../engine/search';
import { Strategy, clearManualQueue, createStrategy, pushManualDir } from '../engine/strategies';
import { cycleFeasibility } from '../engine/hamilton';
import { STRATEGIES, StrategyId } from '../engine/types';
import Board from './Board';

const KEY_DIRS: Record<string, 0 | 1 | 2 | 3> = {
  ArrowUp: 0,
  KeyW: 0,
  ArrowRight: 1,
  KeyD: 1,
  ArrowDown: 2,
  KeyS: 2,
  ArrowLeft: 3,
  KeyA: 3,
};

const FAIL_TEXT: Record<string, string> = {
  none: '—',
  wall: '撞墙',
  self: '撞到自身',
  obstacle: '撞到障碍',
  starved: '长期未进食（死循环）',
  'no-move': '无可行移动（被困）',
  'step-limit': '超过步数上限',
};

export default function LivePanel() {
  const runnable = useMemo(() => SCENARIOS.filter((s) => s.runnable), []);
  const [scenarioId, setScenarioId] = useState('basic');
  const [strategyId, setStrategyId] = useState<StrategyId>('hybrid');
  const [seed, setSeed] = useState(1000);
  const [speed, setSpeed] = useState(30); // 步/秒；> 200 表示每帧多步
  const [showCycle, setShowCycle] = useState(true);
  const [showPath, setShowPath] = useState(true);
  const [showInvariant, setShowInvariant] = useState(false);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [stats, setStats] = useState({ lastMs: 0, totalMs: 0, maxMs: 0, peakNodes: 0, lastNodes: 0 });

  const gameRef = useRef<Game | null>(null);
  const stratRef = useRef<Strategy | null>(null);
  const statsRef = useRef({ lastMs: 0, totalMs: 0, maxMs: 0, peakNodes: 0, lastNodes: 0 });

  const reset = useCallback(() => {
    const cfg = SCENARIOS.find((s) => s.id === scenarioId)!;
    const g = new Game(cfg, seed);
    gameRef.current = g;
    clearManualQueue();
    stratRef.current = createStrategy(strategyId, g);
    statsRef.current = { lastMs: 0, totalMs: 0, maxMs: 0, peakNodes: 0, lastNodes: 0 };
    setStats(statsRef.current);
    setRunning(false);
    setTick((t) => t + 1);
  }, [scenarioId, strategyId, seed]);

  useEffect(() => {
    reset();
  }, [reset]);

  // 手动模式键盘输入（融合自 3.1 的手动控制）
  useEffect(() => {
    if (strategyId !== 'manual') return;
    const onKey = (e: KeyboardEvent) => {
      const d = KEY_DIRS[e.code] ?? KEY_DIRS[e.key];
      if (d === undefined) return;
      e.preventDefault();
      pushManualDir(d);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [strategyId]);

  const stepOnce = useCallback(() => {
    const g = gameRef.current,
      s = stratRef.current;
    if (!g || !s || !g.alive || g.won) return false;
    searchStats.nodes = 0;
    const t0 = performance.now();
    const next = s.decide(g);
    const dt = performance.now() - t0;
    const st = statsRef.current;
    st.lastMs = dt;
    st.totalMs += dt;
    st.maxMs = Math.max(st.maxMs, dt);
    st.lastNodes = searchStats.nodes;
    st.peakNodes = Math.max(st.peakNodes, searchStats.nodes);
    g.step(next);
    const N = g.grid.freeCount;
    if (g.alive && !g.won && g.stepsSinceFood > N * 6 + 100) g.fail('starved');
    return g.alive && !g.won;
  }, []);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      const g = gameRef.current;
      if (!g) return;
      let alive = true;
      if (speed > 200) {
        const per = speed > 1000 ? 200 : 25;
        for (let i = 0; i < per && alive; i++) alive = stepOnce();
      } else {
        acc += ((now - last) / 1000) * speed;
        last = now;
        while (acc >= 1 && alive) {
          alive = stepOnce();
          acc -= 1;
        }
      }
      setStats({ ...statsRef.current });
      setTick((t) => t + 1);
      if (!alive) {
        setRunning(false);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, stepOnce]);

  const g = gameRef.current;
  const s = stratRef.current;
  const cfg = SCENARIOS.find((x) => x.id === scenarioId)!;
  const feas = useMemo(() => (g ? cycleFeasibility(g.grid) : null), [g, g?.grid]);
  const status = !g ? '' : g.won ? '✅ 完美通关' : g.alive ? (running ? '运行中' : '暂停') : `❌ 失败：${FAIL_TEXT[g.failReason]}`;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col items-center gap-4">
        {g && <Board game={g} debug={s?.debug ?? null} showCycle={showCycle} showPath={showPath} tick={tick} />}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => setRunning((r) => !r)}
            disabled={!g || !g.alive || g.won}
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-400 disabled:opacity-40"
          >
            {running ? '暂停' : '运行'}
          </button>
          <button
            onClick={() => {
              stepOnce();
              setStats({ ...statsRef.current });
              setTick((t) => t + 1);
            }}
            disabled={running || !g || !g.alive || g.won}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600 disabled:opacity-40"
          >
            单步
          </button>
          <button onClick={reset} className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-600">
            重置
          </button>
          <label className="ml-2 flex items-center gap-2 text-xs text-slate-300">
            速度
            <input type="range" min={1} max={2000} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-32 accent-emerald-500" />
            <span className="w-16 tabular-nums">{speed > 1000 ? '极速' : speed > 200 ? '快速' : `${speed} 步/s`}</span>
          </label>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">环境参数</h3>
          <div className="space-y-3 text-sm">
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">难度场景</span>
              <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100">
                {runnable.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.name} · {sc.width}×{sc.height}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">AI 策略</span>
              <select value={strategyId} onChange={(e) => setStrategyId(e.target.value as StrategyId)} className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100">
                {STRATEGIES.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-slate-400">随机种子（障碍 + 食物序列）</span>
              <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100" />
            </label>
            <div className="flex gap-4 text-xs text-slate-300">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={showCycle} onChange={(e) => setShowCycle(e.target.checked)} className="accent-violet-500" /> 显示回路
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} className="accent-sky-400" /> 显示规划路径
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={showInvariant} onChange={(e) => setShowInvariant(e.target.checked)} className="accent-amber-400" /> 不变量监控
              </label>
            </div>
            <p className="text-xs leading-relaxed text-slate-400">{cfg.description}</p>
          </div>
        </div>

        {g && (
          <div className="rounded-xl border border-slate-700/60 bg-slate-800/60 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-200">实时指标</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <Stat k="状态" v={status} wide />
              <Stat k="决策模式" v={s?.debug.mode || '—'} wide />
              <Stat k="步数" v={g.steps} />
              <Stat k="蛇长 / 可通行格" v={`${g.length} / ${g.grid.freeCount}`} />
              <Stat k="吃满率" v={(g.fillRate * 100).toFixed(1) + '%'} />
              <Stat k="格子覆盖率" v={(g.coverage * 100).toFixed(1) + '%'} />
              <Stat k="已吃食物" v={g.foodsEaten} />
              <Stat k="过期食物" v={g.expiredFoods} />
              <Stat k="本步耗时" v={stats.lastMs.toFixed(3) + ' ms'} />
              <Stat k="平均耗时" v={(g.steps ? stats.totalMs / g.steps : 0).toFixed(3) + ' ms'} />
              <Stat k="最大耗时" v={stats.maxMs.toFixed(2) + ' ms'} />
              <Stat k="峰值搜索节点" v={stats.peakNodes} />
              <Stat k="回路类型" v={s?.debug.cycle ? s.debug.cycle.kind : '无（搜索策略）'} wide />
              <Stat
                k="回路可行性预诊断"
                v={feas ? `${feas.ok ? '✓ ' : '✗ '}${feas.reason}${feas.deadEnds ? ` · 死胡同格 ${feas.deadEnds}` : ''}` : '—'}
                wide
              />
              {strategyId === 'manual' && (
                <Stat k="操作提示" v="方向键 / WASD 控制（最多缓存 3 步）" wide />
              )}
              {showInvariant && g && strategyId === 'hamilton-dyn' && s && (
                (() => {
                  const dyn = (s as any)._dyn as import('../engine/dyn').DynamicCycle | undefined;
                  const ctrl = (s as any)._controller as import('../engine/dyn').DegradeController | undefined;
                  if (!dyn) return <Stat k="不变量监控" v="该策略无可观测回路" wide />;
                  // P1: 结构（verifyStructure）；P2: 序号一致性；P3': 蛇身单调弧
                  const structErr = dyn.verifyStructure(dyn.N);
                  let monoOk = true;
                  const body = g.bodyCells();
                  const L = body.length;
                  if (L > 1) {
                    const hIdx = dyn.idx[body[L - 1]];
                    let prevDist = -1;
                    for (let i = 0; i < L; i++) {
                      if (dyn.idx[body[i]] < 0) { monoOk = false; break; }
                      const dist = (hIdx - dyn.idx[body[i]] + dyn.N) % dyn.N;
                      if (i > 0 && dist >= prevDist) { monoOk = false; break; }
                      prevDist = dist;
                    }
                  }
                  const nRsv = g.reservedCount;
                  return (
                    <>
                      <Stat k="不变量 P1 单环" v={structErr ? `❌ ${structErr}` : '✓'} wide />
                      <Stat k="不变量 P3 蛇身单调弧" v={monoOk ? '✓' : '❌ 破坏'} wide />
                      <Stat k="回路 N / 自由格" v={`${dyn.N} / ${g.grid.freeCount}`} />
                      <Stat k="预约位数量" v={nRsv} />
                      <Stat k="重建 walk 总数" v={dyn.walkCount} />
                      <Stat k="降级状态" v={ctrl ? (ctrl.degraded ? `${ctrl.reason} @ step ${ctrl.degradeStep}` : '未降级') : '—'} wide />
                    </>
                  );
                })()
              )}
            </dl>
          </div>
        )}
      </aside>
    </div>
  );
}

function Stat({ k, v, wide }: { k: string; v: string | number; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <dt className="text-slate-500">{k}</dt>
      <dd className="font-mono text-slate-100">{v}</dd>
    </div>
  );
}
