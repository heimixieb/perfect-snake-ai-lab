import { useState } from 'react';
import BenchmarkPanel from './components/BenchmarkPanel';
import LivePanel from './components/LivePanel';
import Report from './components/Report';

type Tab = 'live' | 'bench' | 'report';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'live', label: '实时演示', hint: '可视化任意策略 / 难度 / 种子' },
  { id: 'bench', label: '基准测试', hint: '统一环境下的量化对比与验收' },
  { id: 'report', label: '研究报告', hint: '算法选型 · 困难场景适配 · 分级路线' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('live');
  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 text-lg shadow-lg shadow-emerald-500/20">🐍</div>
            <div>
              <h1 className="text-base font-bold leading-tight">Perfect Snake AI Lab <span className="ml-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">融合版</span></h1>
              <p className="text-[11px] text-slate-400">A* / BFS · 最长路径 · 哈密顿回路 · 时间感知安全判定 · 完美通关研究与验收</p>
            </div>
          </div>
          <nav className="ml-auto flex gap-1 rounded-lg bg-slate-800 p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.hint}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${tab === t.id ? 'bg-emerald-500 text-white shadow' : 'text-slate-300 hover:bg-slate-700'}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        {tab === 'live' && <LivePanel />}
        {tab === 'bench' && <BenchmarkPanel />}
        {tab === 'report' && <Report />}
      </main>
      <footer className="border-t border-slate-800 py-4 text-center text-[11px] text-slate-500">
        引擎：TypeScript，无 DOM 依赖 · 基准在 Web Worker 中运行 · 所有随机行为由种子决定，结果可复现
      </footer>
    </div>
  );
}
