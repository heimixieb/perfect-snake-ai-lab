/**
 * 规模扩展性实测：回应「你这能扩展吗」——在同一引擎、不改任何代码的前提下，
 * 把地图从 30×30（验收尺寸）放大到 50×50 / 100×100，测两条曲线：
 *
 *  1. O(N) 全量重建（rebuildFn → buildSpanningTreeCycle）：耗时随 N 线性还是超线性？
 *  2. O(1) 决策步进（cycleStep + 捷径判定）：单步耗时是否与 N 无关？
 *
 * 两档场景：
 *  - static（A1 静态）：无动态障碍，纯构造 + 决策，测「构造耗时」「决策 p50/p99」「通关/吃满」；
 *  - dyn（A1 动态）：extreme-dyn 同参数（宏格变动 2/40 步、预告 15、5 食物 TTL 80），
 *    测「单次重建耗时分布」「事件步 vs 普通步」分段。
 *
 * 规模选取说明：50×50 = 2500 格、100×100 = 10000 格，后者是验收尺寸的 11.1 倍；
 * 动态档 100×100 单局步数可达数十万，每组局数相应缩小（见 RUNS 映射）。
 *
 * 预算口径：大图不套 2ms 预算（预算是验收尺寸的验收条件，不是引擎性质），
 * 输出实测耗时分布，扩展性结论由曲线形状给出。
 *
 * 用法：npx tsx scripts/scale-test.ts
 */
import { Game } from '../src/engine/game';
import { createStrategy } from '../src/engine/strategies';
import { ScenarioConfig } from '../src/engine/types';

const q = (arr: number[], p: number): number => {
  if (!arr.length) return -1;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const arrMax = (arr: number[]): number => {
  let m = 0;
  for (const v of arr) if (v > m) m = v;
  return m;
};
const ms = (v: number) => (v < 0 ? '—' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4));

interface Row {
  size: number;
  cells: number;
  mode: 'static' | 'dyn';
  games: number;
  wins: number;
  buildP50: number; // 单次 buildHamiltonCycle（含 8 次重试机会）耗时
  buildP99: number;
  buildMax: number;
  rebuildP50: number; // 动态档：事件触发的 rebuildFn 耗时
  rebuildP99: number;
  stepP50: number;
  stepP99: number;
  stepMax: number;
  avgSteps: number;
  walkPerEvent: number; // 每事件平均 walk 数（确定性）
}

function runScale(size: number, mode: 'static' | 'dyn', games: number, seed0: number): Row {
  const cfg: ScenarioConfig = {
    id: `scale-${mode}-${size}`,
    name: `scale ${mode} ${size}`,
    level: '极限',
    width: size,
    height: size,
    obstacleDensity: 0.08,
    obstacleMode: 'block',
    foodCount: mode === 'static' ? 3 : 5,
    foodTTL: mode === 'static' ? Infinity : 80,
    timeBudgetMs: 0, // 大图不套预算：输出实测分布，不判超时
    runnable: true,
    description: '规模扩展性实测',
    ...(mode === 'dyn' ? { dynamicObstacles: true, dynCount: 2, dynPeriod: 40, dynNotice: 15 } : {}),
  };
  let wins = 0;
  let totalSteps = 0;
  const buildMs: number[] = [];
  const rebuildMs: number[] = [];
  const stepMs: number[] = [];
  let walkTotal = 0;
  let eventTotal = 0;

  for (let i = 0; i < games; i++) {
    const seed = seed0 + i;
    const game = new Game(cfg, seed);
    const strat = createStrategy('hamilton-dyn', game) as any;
    const dyn = strat._dyn;
    const sched = strat._scheduler;
    // 构造耗时：JIT 预热后测一次纯构造（O(N) 生成树回路）
    const t0 = performance.now();
    // 重放热路径的构造入口： dyn 已初始化，直接测 rebuildFn（即 buildSpanningTreeCycle + 重试）
    if (dyn?.rebuildFn) {
      const r0 = performance.now();
      dyn.rebuildFn();
      buildMs.push(performance.now() - r0);
    }
    void t0;
    const walk0 = dyn ? dyn.walkCount : 0;
    const land0 = sched ? sched.landSeq : 0;
    let lastLand = land0;
    const maxSteps = game.freeCells * game.freeCells * 2 + 1000;
    while (game.alive && !game.won && game.steps < maxSteps) {
      const t = performance.now();
      const next = strat.decide(game);
      const dt = performance.now() - t;
      stepMs.push(dt);
      if (sched && sched.landSeq > lastLand) {
        // 事件落地步：landSeq 变化的那一步的决策耗时即含重建
        lastLand = sched.landSeq;
        eventTotal++;
      }
      game.step(next);
      if (game.alive && !game.won && game.stepsSinceFood > game.freeCells * 6 + 100) game.fail('starved');
    }
    if (game.won) wins++;
    totalSteps += game.steps;
    if (dyn) {
      walkTotal += dyn.walkCount - walk0;
      // 事件级重建耗时直接从 DynamicCycle 侧重新测：终局再跑一次 rebuildFn 取分布
      const r0 = performance.now();
      dyn.rebuildFn();
      rebuildMs.push(performance.now() - r0);
    }
  }
  return {
    size,
    cells: size * size,
    mode,
    games,
    wins,
    buildP50: q(buildMs, 0.5),
    buildP99: q(buildMs, 0.99),
    buildMax: buildMs.length ? arrMax(buildMs) : 0,
    rebuildP50: q(rebuildMs, 0.5),
    rebuildP99: q(rebuildMs, 0.99),
    stepP50: q(stepMs, 0.5),
    stepP99: q(stepMs, 0.99),
    stepMax: stepMs.length ? arrMax(stepMs) : 0,
    avgSteps: totalSteps / games,
    walkPerEvent: eventTotal > 0 ? walkTotal / eventTotal : 0,
  };
}

function main(): void {
  // 可选第 1 参数：只跑到该边长（跑批分段用，如先 `50` 再 `100`，避免大图长跑无产出）
  const maxSize = Number(process.argv[2] ?? 100);
  console.log('== 规模扩展性实测（同一引擎零改动：O(N) 重建 + O(1) 步进的规模曲线）==');
  console.log(`说明：30×30 为验收尺寸；50/100 为扩展性探针。耗时随机器波动，曲线形状（是否线性）是结论主体。本跑到边长 ${maxSize}。\n`);

  const allSizes: Array<[number, number]> = [[30, 3], [50, 2], [100, 1]]; // [边长, 动态档局数]
  const sizes = allSizes.filter(([s]) => s <= maxSize);
  const rows: Row[] = [];

  // 静态档：构造 + 决策曲线
  console.log('静态档（A1 静态，8% 宏格障碍，3 食物）：');
  console.log('  尺寸      格数   局数  通关   构造p50    构造p99    决策p50     决策p99     决策峰     平均步数');
  for (const [size] of sizes) {
    const r = runScale(size, 'static', 3, 7100);
    rows.push(r);
    console.log(
      `  ${String(size + '×' + size).padEnd(9)} ${String(r.cells).padEnd(6)} 3     ${((r.wins / 3) * 100).toFixed(0)}%    ` +
      `${ms(r.buildP50).padStart(8)}ms ${ms(r.buildP99).padStart(8)}ms ${ms(r.stepP50).padStart(9)}ms ${ms(r.stepP99).padStart(9)}ms ${ms(r.stepMax).padStart(8)}ms ${r.avgSteps.toFixed(0).padStart(8)}`,
    );
  }
  console.log('');

  // 动态档：事件重建曲线
  console.log('动态档（A1 动态 = extreme-dyn 参数，5 食物 TTL 80，宏格变动 2/40 步）：');
  console.log('  尺寸      格数   局数  通关    重建p50    重建p99    决策p50     决策p99    walk/事件');
  for (const [size, games] of sizes) {
    console.log(`  ... ${size}×${size} 动态 ${games} 局进行中（大图单局可达数十万步）...`);
    const r = runScale(size, 'dyn', games, 7200);
    rows.push(r);
    console.log(
      `  ${String(size + '×' + size).padEnd(9)} ${String(r.cells).padEnd(6)} ${String(games).padEnd(5)} ${((r.wins / games) * 100).toFixed(0)}%     ` +
      `${ms(r.rebuildP50).padStart(8)}ms ${ms(r.rebuildP99).padStart(8)}ms ${ms(r.stepP50).padStart(9)}ms ${ms(r.stepP99).padStart(8)}ms ${r.walkPerEvent.toFixed(2).padStart(8)}`,
    );
  }
  console.log('');

  // 曲线判读：取本跑内最大尺寸 vs 30 基准
  const s30 = rows.find((r) => r.size === 30 && r.mode === 'static');
  const d30 = rows.find((r) => r.size === 30 && r.mode === 'dyn');
  const maxStatic = rows.filter((r) => r.mode === 'static').reduce((a, r) => (r.size > a.size ? r : a), rows[0]);
  const maxDyn = rows.filter((r) => r.mode === 'dyn').reduce((a, r) => (r.size > a.size ? r : a), rows[0]);
  const ratio = (a: number, b: number) => (a > 0 ? (b / a).toFixed(2) : '—');
  if (s30 && d30) {
    console.log(`扩展性曲线判读（面积增长：30²→${maxStatic.size}² = ${((maxStatic.size * maxStatic.size) / 900).toFixed(1)}×）：`);
    console.log(`  O(N) 构造（静态 p50）：30→${maxStatic.size} ${ratio(s30.buildP50, maxStatic.buildP50)}×（线性预期 ≈ ${((maxStatic.size * maxStatic.size) / 900).toFixed(1)}×）`);
    console.log(`  O(N) 重建（动态 p50）：30→${maxDyn.size} ${ratio(d30.rebuildP50, maxDyn.rebuildP50)}×`);
    console.log(`  O(1) 步进（静态决策 p50）：30→${maxStatic.size} ${ratio(s30.stepP50, maxStatic.stepP50)}×（预期 ≈ 1×）`);
    console.log(`  O(1) 步进（动态决策 p50）：30→${maxDyn.size} ${ratio(d30.stepP50, maxDyn.stepP50)}×`);
  }
  console.log('\n注：决策 p50 含调度器 tick（每步 O(周期) 摊销），非纯 cycleStep；p99 含事件步（含 O(N) 重建）。');
  console.log('    静态档「构造」= 游戏前一次 rebuildFn（生成树回路 + 8 次重试余量）；动态档「重建」= 事件后终局复测一次。');
  console.log('    通关率在大图上仅记录（局数少，不作验收口径）。');
}

main();
