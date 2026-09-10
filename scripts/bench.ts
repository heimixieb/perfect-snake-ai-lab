/**
 * Node 批量验收脚本（与浏览器基准使用同一引擎）。
 * 用法：npx esbuild scripts/bench.ts --bundle --platform=node --outfile=/tmp/bench.js && node /tmp/bench.js [场景id|all] [局数] [基础种子]
 */
import { SCENARIOS } from '../src/engine/scenarios';
import { aggregate, runGame } from '../src/engine/simulate';
import { STRATEGIES } from '../src/engine/types';

const which = process.argv[2] ?? 'all';
const runs = Number(process.argv[3] ?? 10);
const baseSeed = Number(process.argv[4] ?? 1000);
const scenarios = SCENARIOS.filter((s) => s.runnable && (which === 'all' || s.id === which));
// 手动控制与动态障碍策略不参与静态场景基准（hamilton-dyn 仅适用于 extreme-dyn 动态场景）
const benchStrategies = STRATEGIES.filter((s) => s.id !== 'manual' && s.id !== 'hamilton-dyn');
for (const sc of scenarios) {
  console.log(`\n== ${sc.name} (${sc.width}×${sc.height}) seeds ${baseSeed}..${baseSeed + runs - 1}`);
  for (const st of benchStrategies) {
    const res = [];
    for (let i = 0; i < runs; i++) res.push(runGame(sc, st.id, baseSeed + i));
    const a = aggregate(res);
    console.log(
      st.short.padEnd(14),
      `通关 ${(a.winRate * 100).toFixed(0)}%`.padEnd(10),
      `吃满 ${(a.avgFill * 100).toFixed(1)}%`.padEnd(12),
      `覆盖 ${(a.avgCoverage * 100).toFixed(1)}%`.padEnd(12),
      `步数 ${a.avgSteps.toFixed(0)}`.padEnd(12),
      `步/食 ${a.avgStepsPerFood.toFixed(1)}`.padEnd(11),
      `均 ${a.avgDecisionMs.toFixed(4)}ms`.padEnd(13),
      `峰 ${a.maxDecisionMs.toFixed(2)}ms`.padEnd(11),
      `节点 ${a.avgPeakNodes.toFixed(0)}`.padEnd(10),
      `内存 ${a.avgPeakMemKB.toFixed(1)}KB`.padEnd(13),
      JSON.stringify(a.failReasons),
    );
  }
}
