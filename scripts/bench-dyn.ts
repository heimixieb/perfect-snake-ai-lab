/**
 * 极限难度（extreme-dyn）验收脚本：动态宏格障碍 + 5 食物 + TTL 80 + 2ms 预算。
 *
 * 验收目标（goal）：通关 ≥90% @ 2ms；p99 超标立刻降级「安全优先」（宁可绕远，不做复杂重缝合）。
 *
 * 本脚本包含：
 * 1. 主验收：默认 100 seeds，通关率 / 吃满率 / 单步 p50·p99（决策侧分段：降级前 vs 降级后）；
 * 2. 双判据降级单元自检：
 *    a) walk 判据（确定性）：预算压到 0 → 触发 reason=walks；
 *    b) 墙钟判据（保险丝）：wallBudgetMs 压到极小 → 触发 reason=wall；
 *    c) anomaly 判据：拓扑连续异常 ≥5 → 触发 reason=anomaly；
 * 3. 降级后行为观测：降级时刻之后的步仍在跑，验证安全优先模式不撞、p99 收敛。
 *
 * 用法：npx tsx scripts/bench-dyn.ts [局数=100] [起始种子=7000]
 */
import { getScenario } from '../src/engine/scenarios';
import { Game } from '../src/engine/game';
import { createStrategy } from '../src/engine/strategies';
import { OVERFOOD_SHORTCUT, ENDGAME_MARGIN } from '../src/engine/strategies';
import { buildHamiltonCycle } from '../src/engine/hamilton';
import { StrategyId } from '../src/engine/types';

import { shadowFreeSet, shadowCheckRing, shadowCheckMonoArc, shadowCheckOrder, shadowCompareCycle } from '../src/engine/shadow';
import { TWOFACTOR_ENGINE } from '../src/engine/twofactor';

interface Row {
  seed: number;
  won: boolean;
  failReason: string;
  steps: number;
  fill: number;
  /** 初始容量达成比例；没有 structural_L 证书时不能单独宣称 C 已满足。 */
  cRate: number;
  /** 新口径 V：visited ∩ 当前自由集 / 当前自由集（≤100%） */
  vRate: number;
  expiredReachableSnapshot: number;
  expiredUnreachableSnapshot: number;
  foodsRemovedByObstacle: number;
  coverage: number;
  /** 决策侧全程 p50/p99 */
  p50: number;
  p99: number;
  max: number;
  overBudget: number;
  /** 降级信息 */
  degraded: boolean;
  degradeStep: number;
  degradeReason: string;
  /** 分段观测：降级前/后的决策 p99 */
  p99BeforeDegrade: number;
  p99AfterDegrade: number;
  /** 降级后步数占比 */
  afterDegradeSteps: number;
  /** b 引擎统计（--twofactor 时） */
  tfEventP99: number;
  tfFallbacks: number;
  tfRepairFails: number;
  tfEventMax: number;
  tfSlowEvents: number;
  tfSlowMax: string;
  /** 用于汇总真正的 pooled p99；不再对“逐局 p99”二次取分位数。 */
  decisionMs: number[];
  normalDecisionMs: number[];
  degradedDecisionMs: number[];
  degradeTransitions: number;
  recoveries: number;
  schedulerStats?: import('../src/engine/dyn').SchedulerStats;
}

let withTFRun = false;
function runOne(scenarioId: string, strategy: StrategyId, seed: number, budgetOverrideMs = 0, withShadow = false): Row {
  const cfg = { ...getScenario(scenarioId) };
  if (budgetOverrideMs > 0) cfg.timeBudgetMs = budgetOverrideMs;
  const game = new Game(cfg, seed);
  const strat = createStrategy(strategy, game) as any;
  // 影子 refinement 断言（--shadow 终检模式）：自适应频率——事件落地后 1 步必断言
  // （重建提交后的下一步是拓扑最脆弱时刻，断言价值最高）+ 平时每 50 步稳定点断言。
  const dyn = strat._dyn as import('../src/engine/dyn').DynamicCycle | undefined;
  // 影子独立重建（Q12：与热路径 rebuildFn 各自实现）：叠加 reserved 视图 + 8 seed 重试，
  // 与 shadow-test.ts 的独立编排同语义——预告期内热路径回路排除预约格，影子必须同视图。
  const shadowRebuild = withShadow && dyn
    ? () => {
        const blocked = game.grid.blocked;
        const reservedNow: number[] = [];
        for (let c = 0; c < blocked.length; c++) {
          if (game.reserved[c] && !blocked[c]) reservedNow.push(c);
        }
        for (const c of reservedNow) blocked[c] = 1;
        if (reservedNow.length) game.grid.rebuildNeighbors();
        try {
          for (let attempt = 0; attempt < 8; attempt++) {
            const cyc = buildHamiltonCycle(game.grid, seed + 7919 + attempt * 104729);
            if (cyc && cyc.length === game.grid.freeCount) {
              return Array.from(cyc.cells.slice(0, cyc.length));
            }
          }
          return null;
        } finally {
          for (const c of reservedNow) blocked[c] = 0;
          if (reservedNow.length) game.grid.rebuildNeighbors();
        }
      }
    : null;
  let shadowFailures = 0;
  let shadowAssertions = 0;
  let shadowEventAssertions = 0; // 事件落地后 1 步的必断言次数
  let lastLandSeq = 0; // 0 是初始化状态，不误记为落地事件
  // 决策侧按实际执行模式分段；恢复后的正常样本重新进入 normal。
  const normal: number[] = [];
  const degradedSamples: number[] = [];
  const all: number[] = [];
  let overBudget = 0;
  let degradedAt = -1;
  let degradeReason = 'none';
  let degradeTransitions = 0;
  let recoveries = 0;
  let previousControllerState = !!strat._controller?.degraded;
  const maxSteps = game.freeCells * game.freeCells * 2 + 1000;
  while (game.alive && !game.won && game.steps < maxSteps) {
    const t0 = performance.now();
    const next = strat.decide(game);
    const dt = performance.now() - t0;
    all.push(dt);
    // 记录降级触发（策略在本步末把 mode 置为「触发降级(reason)」）
    if (strat.debug.mode.startsWith('触发降级(') && degradedAt < 0) {
      degradedAt = game.steps;
      degradeReason = strat.debug.mode.slice('触发降级('.length).split(')')[0];
    }
    const controllerState = !!strat._controller?.degraded;
    if (controllerState && degradedAt < 0) {
      degradedAt = game.steps;
      degradeReason = strat._controller?.reason ?? 'unknown';
    }
    if (controllerState && !previousControllerState) degradeTransitions++;
    if (!controllerState && previousControllerState) recoveries++;
    previousControllerState = controllerState;
    const usedDegradedMode = strat.debug.mode.startsWith('降级·安全优先');
    if (usedDegradedMode) degradedSamples.push(dt);
    else normal.push(dt);
    if (dt > (budgetOverrideMs || cfg.timeBudgetMs)) overBudget++;
    game.step(next);
    if (game.alive && !game.won && game.stepsSinceFood > game.freeCells * 6 + 100) game.fail('starved');
    // 影子四层断言（自适应频率）：事件落地后 1 步必断言 + 平时每 50 步稳定点。
    // 落地判定 = 本步决策前调度器推进过（sync 在 decide 内，landSeq 比对步前步后）。
    if (withShadow && dyn) {
      const curLandSeq = strat._scheduler ? strat._scheduler.landSeq : 0;
      const eventJustLanded = curLandSeq !== lastLandSeq;
      lastLandSeq = curLandSeq;
      const due = eventJustLanded || game.steps % 50 === 0;
      if (due) {
        if (eventJustLanded) shadowEventAssertions++;
        shadowAssertions++;
        const body = game.bodyCells();
        // L1: 回路 ⊔ 预约位 = 自由集
        const shadowFree = shadowFreeSet(game.grid.blocked);
        const hotCells = new Set<number>();
        for (let k = 0; k < dyn.N; k++) hotCells.add(dyn.cells[k]);
        let l1ok = true;
        for (const c of shadowFree) {
          if (!hotCells.has(c) && game.reserved[c] !== 1) { l1ok = false; break; }
          if (hotCells.has(c) && game.reserved[c] === 1) { l1ok = false; break; }
        }
        if (l1ok) {
          for (let c = 0; c < game.grid.n; c++) {
            if (game.reserved[c] === 1 && hotCells.has(c)) { l1ok = false; break; }
          }
        }
        if (!l1ok) { shadowFailures++; continue; }
        // L2
        const ringErr = shadowCheckRing(dyn.next, dyn.prev, game.grid.blocked, game.grid.w, dyn.N);
        if (ringErr) { shadowFailures++; continue; }
        // L3
        if (!shadowCheckMonoArc(dyn.idx, dyn.N, body)) { shadowFailures++; continue; }
        // L4：独立重建必须在同一提交视图上产生一条合法回路；不同合法形态只作观测。
        const reference = shadowRebuild?.() ?? null;
        const saved: number[] = [];
        for (let c = 0; c < game.grid.n; c++) {
          if (game.reserved[c] === 1 && !game.grid.blocked[c]) { game.grid.blocked[c] = 1; saved.push(c); }
        }
        if (saved.length) game.grid.rebuildNeighbors();
        const refErr = shadowCheckOrder(reference, game.grid.blocked, game.grid.w);
        const committedFree = game.grid.freeCount;
        const committedOk = dyn.N === committedFree;
        void shadowCompareCycle(dyn.cells, dyn.N, reference, committedFree); // 仅记录形态可比性，不作正确性门
        for (const c of saved) game.grid.blocked[c] = 0;
        if (saved.length) game.grid.rebuildNeighbors();
        if (refErr || !committedOk) shadowFailures++;
      }
    }
  }
  if (game.alive && !game.won) game.fail('step-limit');
  if (withShadow && shadowFailures > 0) {
    console.error(`seed ${seed}: 影子断言失败 ${shadowFailures} 次`);
    process.exitCode = 1;
  }
  const q = (arr: number[], p: number) => {
    if (!arr.length) return -1; // -1 = 该段无样本
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  const degraded = degradedAt >= 0;
  const row: Row = {
    seed,
    won: game.won,
    failReason: game.won ? 'none' : game.failReason,
    steps: game.steps,
    fill: game.fillRate,
    cRate: game.length / game.initialFreeCount,
    vRate: game.coverageCurrent,
    expiredReachableSnapshot: game.expiredReachableSnapshot,
    expiredUnreachableSnapshot: game.expiredUnreachableSnapshot,
    foodsRemovedByObstacle: game.foodsRemovedByObstacle,
    coverage: game.coverage,
    p50: q(all, 0.5),
    p99: q(all, 0.99),
    max: all.reduce((m, x) => Math.max(m, x), 0),
    overBudget,
    degraded,
    degradeStep: degradedAt,
    degradeReason,
    p99BeforeDegrade: q(normal, 0.99),
    p99AfterDegrade: q(degradedSamples, 0.99),
    afterDegradeSteps: degradedSamples.length,
    tfEventP99: -1,
    tfFallbacks: -1,
    tfRepairFails: -1,
    tfEventMax: -1,
    tfSlowEvents: -1,
    tfSlowMax: '',
    decisionMs: all,
    normalDecisionMs: normal,
    degradedDecisionMs: degradedSamples,
    degradeTransitions,
    recoveries,
    schedulerStats: strat._scheduler?.stats,
  };
  if (withTFRun) {
    const tfs = (strat as any)._tf?.stats;
    if (tfs) {
      const ev = [...tfs.eventMs].sort((a, b) => a - b);
      row.tfEventP99 = ev.length ? ev[Math.min(ev.length - 1, Math.floor(ev.length * 0.99))] : 0;
      row.tfEventMax = ev.length ? ev[ev.length - 1] : 0;
      row.tfSlowEvents = tfs.eventMs.filter((x: number) => x > 10).length;
      row.tfSlowMax = tfs.eventMs.filter((x: number) => x > 10).map((x: number) => Math.round(x)).sort((a: number, b: number) => b - a).slice(0, 3).join(',');
      row.tfFallbacks = tfs.fallbacks;
      row.tfRepairFails = tfs.repairFails;
    }
  }
  if (withShadow) {
    (row as Row & { shadowAssertions: number; shadowEventAssertions: number }).shadowAssertions = shadowAssertions;
    (row as Row & { shadowEventAssertions: number }).shadowEventAssertions = shadowEventAssertions;
  }
  return row;
}

const pctl = (arr: number[], p: number) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

function summarize(rows: Row[]): void {
  const n = rows.length;
  const degradedRows = rows.filter((r) => r.degraded);
  const pooledDecisionMs: number[] = [];
  const pooledNormalMs: number[] = [];
  const pooledDegradedMs: number[] = [];
  for (const r of rows) {
    for (const x of r.decisionMs) pooledDecisionMs.push(x);
    for (const x of r.normalDecisionMs) pooledNormalMs.push(x);
    for (const x of r.degradedDecisionMs) pooledDegradedMs.push(x);
  }
  const pooledP99 = pctl(pooledDecisionMs, 0.99);
  const overBudgetSteps = rows.reduce((a, r) => a + r.overBudget, 0);
  const totalSteps = rows.reduce((a, r) => a + r.steps, 0);
  console.log();
  console.log(`平均总步数 ${(totalSteps / n).toFixed(0)}  降级局数 ${degradedRows.length}/${n}`);
  console.log(`旧口径: 吃满率均值 ${(rows.reduce((a, r) => a + r.fill, 0) / n * 100).toFixed(1)}%  覆盖率均值 ${(rows.reduce((a, r) => a + r.coverage, 0) / n * 100).toFixed(1)}%（与历史数据/文献对话）`);
  console.log(`诊断口径: 初始容量达成比例均值 ${(rows.reduce((a, r) => a + r.cRate, 0) / n * 100).toFixed(1)}% (final/initial_free；非 C 证书)  V 覆盖率均值 ${(rows.reduce((a, r) => a + r.vRate, 0) / n * 100).toFixed(1)}%`);
  console.log(`食物到期快照: 可达 ${rows.reduce((a, r) => a + r.expiredReachableSnapshot, 0)} / 不可达 ${rows.reduce((a, r) => a + r.expiredUnreachableSnapshot, 0)}；障碍移除食物 ${rows.reduce((a, r) => a + r.foodsRemovedByObstacle, 0)}（均为诊断项，不宣称 N 证明）`);
  console.log(`pooled 决策 p99 ${pooledP99.toFixed(4)}ms  最差逐局 p99 ${Math.max(...rows.map((r) => r.p99)).toFixed(4)}ms  峰值 ${Math.max(...rows.map((r) => r.max)).toFixed(3)}ms  超预算步数 ${overBudgetSteps}/${totalSteps} (${(overBudgetSteps / totalSteps * 100).toFixed(3)}%)`);
  // 双判据降级观测
  const byReason: Record<string, number> = {};
  for (const r of degradedRows) byReason[r.degradeReason] = (byReason[r.degradeReason] ?? 0) + 1;
  console.log(`降级局数 ${degradedRows.length}/${n}  触发原因分布 ${JSON.stringify(byReason)}`);
  if (degradedRows.length) {
    const dSteps = degradedRows.map((r) => r.degradeStep);
    console.log(`降级时刻 step: min ${Math.min(...dSteps)}  中位 ${pctl(dSteps, 0.5).toFixed(0)}  max ${Math.max(...dSteps)}`);
  }
  // 降级后 p99 观测（分段）
  const withAfter = degradedRows.filter((r) => r.p99AfterDegrade >= 0);
  if (withAfter.length) {
    const afterVals = withAfter.map((r) => r.p99AfterDegrade);
    console.log(`按实际模式分段 pooled p99: 正常 ${pooledNormalMs.length ? pctl(pooledNormalMs, 0.99).toFixed(4) : '—'}ms → 降级 ${pooledDegradedMs.length ? pctl(pooledDegradedMs, 0.99).toFixed(4) : '—'}ms；降级逐局 p99 均值 ${(afterVals.reduce((a, b) => a + b, 0) / afterVals.length).toFixed(4)}ms`);
    console.log(`降级后步数占比均值 ${(withAfter.reduce((a, r) => a + r.afterDegradeSteps / r.steps, 0) / withAfter.length * 100).toFixed(1)}%`);
    console.log(`模式切换: 降级 ${rows.reduce((a, r) => a + r.degradeTransitions, 0)} 次 / 恢复 ${rows.reduce((a, r) => a + r.recoveries, 0)} 次`);
  } else {
    console.log('降级后分段 p99: 本次无局触发降级（p99 全程在预算内）');
  }
  const fails = rows.filter((r) => !r.won);
  const failDist: Record<string, number> = {};
  for (const r of fails) failDist[r.failReason] = (failDist[r.failReason] ?? 0) + 1;
  console.log(`失败原因 ${JSON.stringify(failDist)}`);
  const funnel = rows.reduce((a, r) => {
    const s = r.schedulerStats;
    if (!s) return a;
    for (const key of Object.keys(s) as Array<keyof typeof s>) a[key] = (a[key] ?? 0) + s[key];
    return a;
  }, {} as Partial<import('../src/engine/dyn').SchedulerStats>);
  if (Object.keys(funnel).length) {
    console.log(`事件漏斗: 抽样 ${funnel.sampledCandidates ?? 0} / 环境过滤 ${funnel.environmentRejects ?? 0} / 公平性过滤 ${funnel.fairnessRejects ?? 0} / 策略拒绝 ${funnel.strategyRejects ?? 0} / 预约 ${funnel.reservations ?? 0} / 提交 ${funnel.committedEvents ?? 0} / 回滚 ${funnel.landRollbacks ?? 0} / 放弃解除 ${funnel.unblockAbandons ?? 0}`);
  }
  const shadowRows = rows as Array<Row & { shadowAssertions?: number; shadowEventAssertions?: number }>;
  const sa = shadowRows.reduce((a, r) => a + (r.shadowAssertions ?? 0), 0);
  const sea = shadowRows.reduce((a, r) => a + (r.shadowEventAssertions ?? 0), 0);
  if (sa > 0) {
    console.log(`影子断言（自适应）: 总断言 ${sa} 次，其中事件落地后 1 步必断言 ${sea} 次、稳点 ${sa - sea} 次（每 50 步）`);
  }
  if (rows[0]?.tfEventP99 >= 0) {
    const p99s = rows.map((r) => r.tfEventP99);
    const fb = rows.reduce((a, r) => a + Math.max(0, r.tfFallbacks), 0);
    const rf = rows.reduce((a, r) => a + Math.max(0, r.tfRepairFails), 0);
    const pctl = (arr: number[], p: number) => { const ss = [...arr].sort((a, b) => a - b); return ss[Math.min(ss.length - 1, Math.floor(ss.length * p))]; };
    console.log(`b 引擎: 事件耗时 p99 跨局 p50 ${pctl(p99s, 0.5).toFixed(3)}ms / p99 ${pctl(p99s, 0.99).toFixed(3)}ms ｜ 兜底 ${fb} 次（repairFails ${rf}）`);
    const mx = rows.map((r) => r.tfEventMax);
    const slow = rows.map((r) => r.tfSlowEvents).reduce((a, b) => a + Math.max(0, b), 0);
    console.log(`b 引擎: 单事件最大 ${Math.max(...mx).toFixed(1)}ms ｜ >10ms 事件 ${slow} 个，样例: ${rows.map((r) => r.tfSlowMax).filter(Boolean).slice(0, 6).join(' | ')}`);
  }
}

/* ---------------------------------------------------------------- */
/* 双判据降级单元自检                                                 */
/* ---------------------------------------------------------------- */
async function unitTests(): Promise<void> {
  const { DegradeController } = await import('../src/engine/dyn');
  const mk = () => new DegradeController(2, 10, 6, 0.2); // 窗口10、单步walk预算6、spike占比20%、墙钟预算 max(10,5)=10ms
  let pass = 0;
  let total = 0;
  const t = (name: string, ok: boolean) => {
    total++;
    if (ok) pass++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  };
  // A. walks 判据（确定性）：超预算 → reason=walks，且同输入必同结果
  {
    const c = mk();
    for (let i = 0; i < 10; i++) c.sample(0.1, 9); // 每步 9 次 walk > 预算 6，spike 占比 100%
    c.check(100);
    t('walks 判据触发 (reason=walks)', c.degraded && c.reason === 'walks' && c.degradeStep === 100);
    const c2 = mk();
    for (let i = 0; i < 10; i++) c2.sample(0.1, 9);
    c2.check(100);
    t('walks 判据确定性（同输入同结果）', c2.degraded && c2.reason === 'walks' && c2.degradeStep === 100);
  }
  // A2. walks 在预算内不触发
  {
    const c = mk();
    for (let i = 0; i < 10; i++) c.sample(0.1, 2);
    c.check(50);
    t('walks 在预算内不降级', !c.degraded);
  }
  // B. 墙钟判据（保险丝）：walk 正常但墙钟 p99 超标 → reason=wall
  {
    const c = mk();
    for (let i = 0; i < 10; i++) c.sample(20, 1);
    c.check(200);
    for (let i = 0; i < 10; i++) c.sample(20, 1);
    c.check(260);
    t('墙钟保险丝触发 (reason=wall, 去抖后)', c.degraded && c.reason === 'wall');
    // B0. 去抖：单窗口超标不降级
    const c0 = mk();
    for (let i = 0; i < 10; i++) c0.sample(i === 9 ? 20 : 0.1, 1);
    c0.check(150);
    for (let i = 0; i < 10; i++) c0.sample(0.1, 1);
    c0.check(160);
    t('单次墙钟尖峰不会被重叠窗口重复计数', !c0.degraded);
  }
  // B2. 墙钟在预算内不触发（walk 也正常）
  {
    const c = mk();
    for (let i = 0; i < 10; i++) c.sample(0.5, 1);
    c.check(10);
    t('墙钟在预算内不降级', !c.degraded);
  }
  // E. 降级后出现 spike 会重置恢复进度，之后连续干净样本仍可恢复。
  {
    const c = mk();
    c.force('walks', 1);
    for (let i = 0; i < 120; i++) c.sample(0.1, 1);
    c.sample(0.1, 9);
    for (let i = 0; i < c.recoverySteps; i++) c.sample(0.1, 1);
    t('恢复按连续干净样本计算', c.tryRecover(999) && !c.degraded);
  }
  // C. anomaly 强制：reason=anomaly
  {
    const c = mk();
    c.force('anomaly', 42);
    t('anomaly 强制降级', c.degraded && c.reason === 'anomaly' && c.degradeStep === 42);
  }
  // D. 降级后 sample/check 幂等（不改变原因）
  {
    const c = mk();
    for (let i = 0; i < 10; i++) c.sample(0.1, 9);
    c.check(1);
    c.sample(99, 99);
    c.check(2);
    t('降级后状态保持（reason 不被覆盖）', c.degraded && c.reason === 'walks' && c.degradeStep === 1);
  }
  console.log(`双判据单元自检: ${pass}/${total} 通过\n`);
  if (pass !== total) process.exit(1);
}

/* ---------------------------------------------------------------- */
async function main() {
  await unitTests();

  const runs = Number(process.argv[2] ?? 100);
  const seed0 = Number(process.argv[3] ?? 7000);
  // A/B 开关：第 4 参数 "noopt" 关闭越食捷径 + 终局收窄（基线对照）
  const abMode = process.argv[4] ?? 'opt';
  OVERFOOD_SHORTCUT.enabled = abMode !== 'noopt';
  ENDGAME_MARGIN.enabled = abMode !== 'noopt';
  // 第 5 参数 "--shadow"：主验收同步跑影子 refinement 断言（终检用，拖慢约 20%）
  const withShadow = process.argv.includes('--shadow');
  // 开关 "--twofactor"：hamilton-dyn 切到 2-factor 增量维护引擎（b-主 A/B 验收）
  const withTF = process.argv.includes('--twofactor');
  if (withTF) { TWOFACTOR_ENGINE.enabled = true; withTFRun = true; }
  console.log(`== extreme-dyn 30×30 动态宏格障碍 · hamilton-dyn${withTF ? " · 2-factor 增量引擎" : ""} · ${runs} seeds (${seed0}..${seed0 + runs - 1}) ==`);
  console.log(`优化开关: 越食捷径 ${OVERFOOD_SHORTCUT.enabled ? 'ON' : 'OFF'} · 终局收窄 ${ENDGAME_MARGIN.enabled ? 'ON' : 'OFF'}${abMode === 'noopt' ? '（基线对照模式）' : ''} · 影子断言 ${withShadow ? 'ON（终检模式）' : 'OFF'}\n`);
  const rows: Row[] = [];
  // "--a2"：跑 A2-like 过滤对手档，并公开策略拒绝漏斗。
  const withA2 = process.argv.includes('--a2');
  const scenarioId = withA2 ? 'extreme-dyn-a2' : 'extreme-dyn';
  if (withA2) console.log(`场景: ${scenarioId}（A2-like：允许近头候选；维护器拒绝会显式计数）`);
  for (let i = 0; i < runs; i++) rows.push(runOne(scenarioId, 'hamilton-dyn', seed0 + i, 0, withShadow));
  summarize(rows);


  const winRate = rows.filter((r) => r.won).length / rows.length;
  const pooled: number[] = [];
  for (const r of rows) for (const x of r.decisionMs) pooled.push(x);
  const p99Cross = pctl(pooled, 0.99);
  console.log('\n验收判定：');
  console.log(`  通关率 ${winRate >= 0.9 ? '✅' : '❌'} ${(winRate * 100).toFixed(1)}% (目标 ≥90%)`);
  console.log(`  pooled 决策 p99 ${p99Cross <= 2 ? '✅' : '❌'} ${p99Cross.toFixed(4)}ms (目标 ≤2ms)`);
  const safetyReasons = new Set(['wall', 'self', 'obstacle', 'no-move', 'maintenance']);
  const safetyFailures = rows.filter((r) => safetyReasons.has(r.failReason));
  console.log(`  安全 S ${safetyFailures.length === 0 ? '✅' : '❌'} 非法终态 ${safetyFailures.length}/${rows.length}`);
  const degradedRows = rows.filter((r) => r.degraded);
  if (degradedRows.length) {
    // 降级后仍在跑的步里不撞 = 降级有效性
    const okAfter = degradedRows.every((r) => !safetyReasons.has(r.failReason));
    console.log(`  降级后行为 ${okAfter ? '✅' : '❌'} 降级局无碰撞、非法移动或维护失败`);
  } else {
    console.log(`  降级机制 ✅ 本次全程未触发（含强制自检路径，见单元自检）`);
  }
  const correctnessOnly = process.argv.includes('--correctness-only');
  if (correctnessOnly) console.log('  性能门：仅报告（--correctness-only，避免共享 CI 机器墙钟抖动造成假失败）');
  if (winRate < 0.9 || safetyFailures.length > 0 || (!correctnessOnly && p99Cross > 2)) process.exit(1);
}

main();
