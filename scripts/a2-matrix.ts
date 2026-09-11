/**
 * A2-like 档压力矩阵：允许近头候选，并公开“候选→公平性→策略→提交”的完整漏斗。
 * 崩溃边界标定到与 A1 压力矩阵同等的严谨度。
 *
 * 8 组合 = 预告期 5/15 × 变动数 2/4 × 密度 0.08/0.12（与 A1 矩阵同轴同值），
 * 其余参数与 extreme-dyn-a2 相同（30×30 宏格障碍、5 食物、TTL 80、2ms 预算）。
 *
 * 验收口径（与 A1 矩阵一致，另加 A2 特有的事件链计数）：
 *  - 通关率：仅记录，不预设 100%（A2 对手可落蛇头正前方）；
 *  - 合法终态：won 或 die 且 failReason ≠ none——无条件要求，非法终态 = 崩溃；
 *  - 结构完好：终局 verifyStructure 通过——无条件要求，违反 = 引擎被污染；
 *  - 崩溃边界定义：通关率 <100% 的组合须给出失败原因分布；任何组合出现
 *    非法终态/结构污染/死锁（步数爆表且 alive）即为崩溃。
 *
 * 重要：当前实现仍允许维护器拒绝公平候选，所以它不是严格“事件必须落地”的 A2。
 * 脚本把策略拒绝显式列出，防止只展示成功落地数而隐藏前置筛选。
 *  注：d-3 设计中的「逃逸承诺模式」未实装（引擎只有接受时刻公平性三条件），
 *  故本脚本不统计逃逸模式启用面——A2 的 100% 由三条件 + 常规回路步进支撑。
 *
 * 用法：npx tsx scripts/a2-matrix.ts [每组局数=100] [起始种子=7000]
 */
import { getScenario } from '../src/engine/scenarios';
import { Game } from '../src/engine/game';
import { createStrategy } from '../src/engine/strategies';

interface ComboResult {
  notice: number;
  count: number;
  density: number;
  games: number;
  wins: number;
  legalEnds: number;
  structureOk: number;
  deadlock: number;
  cRate: number;
  p50: number;
  p99: number;
  max: number;
  overBudgetSteps: number;
  totalSteps: number;
  failDist: Record<string, number>;
  landings: number;
  landRollbacks: number;
  sampledCandidates: number;
  fairnessRejects: number;
  strategyRejects: number;
  reservations: number;
  committedEvents: number;
}

function runCombo(notice: number, count: number, density: number, games: number, seed0: number): ComboResult {
  const base = getScenario('extreme-dyn-a2');
  const cfg = {
    ...base,
    id: `a2-matrix-n${notice}-c${count}-d${density}`,
    name: `A2 矩阵 预告${notice}/变动${count}/密度${density}`,
    obstacleDensity: density,
    dynNotice: notice,
    dynCount: count,
  };
  let wins = 0;
  let legalEnds = 0;
  let structureOk = 0;
  let deadlock = 0;
  let cRateSum = 0;
  let landings = 0;
  let landRollbacks = 0;
  let sampledCandidates = 0;
  let fairnessRejects = 0;
  let strategyRejects = 0;
  let reservations = 0;
  let committedEvents = 0;
  let overBudgetSteps = 0;
  let totalSteps = 0;
  const allDecideMs: number[] = [];
  const failDist: Record<string, number> = {};

  for (let i = 0; i < games; i++) {
    const seed = seed0 + i;
    const game = new Game(cfg, seed);
    const strat = createStrategy('hamilton-dyn', game) as any;
    const dyn = strat._dyn;
    const sched = strat._scheduler as (import('../src/engine/dyn').DynScheduler) | undefined;
    const land0 = sched ? sched.landSeq : 0;
    // 包装落地回调统计「落地后回滚」：onBlocked 返回 false → 调度器 applyUnblock 放弃事件
    if (sched) {
      const origOnBlocked = sched.onBlocked;
      sched.onBlocked = (macro: number) => {
        const ok = origOnBlocked(macro);
        if (!ok) landRollbacks++;
        return ok;
      };
    }
    const maxSteps = game.freeCells * game.freeCells * 2 + 1000;
    while (game.alive && !game.won && game.steps < maxSteps) {
      const t0 = performance.now();
      const next = strat.decide(game);
      const dt = performance.now() - t0;
      allDecideMs.push(dt);
      if (dt > cfg.timeBudgetMs) overBudgetSteps++;
      game.step(next);
      if (game.alive && !game.won && game.stepsSinceFood > game.freeCells * 6 + 100) game.fail('starved');
    }
    if (game.alive && !game.won) game.fail('step-limit');
    // 事件链计数：landSeq = grid 被对手真实触碰次数（含落地后回滚）；landRollbacks 由
    // onBlocked 包装统计（A2 中放弃 = 优雅降级，回滚 grid 保证安全，非崩溃）。
    if (sched) {
      landings += sched.landSeq - land0;
      sampledCandidates += sched.stats.sampledCandidates;
      fairnessRejects += sched.stats.fairnessRejects;
      strategyRejects += sched.stats.strategyRejects;
      reservations += sched.stats.reservations;
      committedEvents += sched.stats.committedEvents;
    }
    totalSteps += game.steps;
    if (game.won) wins++;
    if (game.won || (!game.alive && game.failReason !== 'none')) legalEnds++;
    else failDist['非法终态'] = (failDist['非法终态'] ?? 0) + 1;
    if (!game.won) failDist[game.failReason] = (failDist[game.failReason] ?? 0) + 1;
    if (game.failReason === 'step-limit') deadlock++;
    if (dyn) {
      const support = new Uint8Array(game.grid.n);
      for (let c = 0; c < game.grid.n; c++) support[c] = !game.grid.blocked[c] && !game.reserved[c] ? 1 : 0;
      const err = dyn.verifyStructure(dyn.N, support);
      if (!err) structureOk++;
      else console.error(`  seed ${seed} 结构污染: ${err}`);
    }
    cRateSum += game.length / game.initialFreeCount;
  }

  const s = [...allDecideMs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0);
  return {
    notice, count, density, games, wins, legalEnds, structureOk, deadlock,
    cRate: cRateSum / games,
    p50: q(0.5), p99: q(0.99), max: s.length ? s[s.length - 1] : 0,
    overBudgetSteps, totalSteps, failDist, landings, landRollbacks,
    sampledCandidates, fairnessRejects, strategyRejects, reservations, committedEvents,
  };
}

function main(): void {
  const games = Number(process.argv[2] ?? 100);
  const seed0 = Number(process.argv[3] ?? 7000);
  console.log(`== A2-like 过滤对手压力矩阵（extreme-dyn-a2 · 每组合 ${games} 局，seed ${seed0}..）==`);
  console.log('注意：维护器仍可拒绝公平候选；本脚本公开拒绝数，不把它包装成严格“事件必须落地”。');
  console.log('轴：预告期 5/15 × 变动数 2/4 × 密度 0.08/0.12（与 A1 矩阵同轴）\n');

  const combos: Array<[number, number, number]> = [];
  for (const notice of [5, 15]) for (const count of [2, 4]) for (const density of [0.08, 0.12]) combos.push([notice, count, density]);

  const results: ComboResult[] = [];
  for (const [notice, count, density] of combos) {
    const r = runCombo(notice, count, density, games, seed0);
    results.push(r);
    const winPct = ((r.wins / r.games) * 100).toFixed(0);
    const collapsed = r.legalEnds !== r.games || r.structureOk !== r.games || r.deadlock > 0;
    console.log(
      `预告${String(notice).padStart(2)} 变动${count} 密度${density.toFixed(2)}`,
      `通关 ${winPct.padStart(3)}%`,
      `合法终态 ${r.legalEnds}/${r.games}`,
      `结构完好 ${r.structureOk}/${r.games}`,
      `死锁 ${r.deadlock}`,
      `初始容量 ${(r.cRate * 100).toFixed(1)}%`,
      `p50 ${r.p50.toFixed(3)} p99 ${r.p99.toFixed(3)} 峰 ${r.max.toFixed(2)}ms`,
      `超预算 ${(r.overBudgetSteps / Math.max(1, r.totalSteps) * 100).toFixed(3)}%`,
      `提交 ${r.committedEvents}（grid触碰 ${r.landings} / 策略拒绝 ${r.strategyRejects} / 回滚 ${r.landRollbacks}）`,
      collapsed ? '❌' : (r.wins === r.games ? '✅' : '⚠'),
    );
    const dist = Object.entries(r.failDist).map(([k, v]) => `${k}×${v}`).join(' ');
    if (dist) console.log(`    失败分布: ${dist}`);
  }

  console.log('\n崩溃边界标定（与 A1 矩阵同口径）：');
  const perfect = results.filter((r) => r.wins === r.games);
  const degraded = results.filter((r) => r.wins < r.games);
  const collapsed = results.filter((r) => r.legalEnds !== r.games || r.structureOk !== r.games || r.deadlock > 0);
  console.log(`  100% 通关组合：${perfect.length}/8 ｜ 降级组合（<100% 但终态合法）：${degraded.length} ｜ 崩溃组合（非法终态/结构污染/死锁）：${collapsed.length}`);
  for (const r of degraded) {
    const dist = Object.entries(r.failDist).map(([k, v]) => `${k}×${v}`).join(' ');
    console.log(`  边界组合 预告${r.notice}/变动${r.count}/密度${r.density.toFixed(2)}: 通关 ${((r.wins / r.games) * 100).toFixed(0)}%，失败模式 ${dist || '—'}`);
  }
  const worstP99 = Math.max(...results.map((r) => r.p99));
  console.log(`  全矩阵 p99 峰值 ${worstP99.toFixed(3)}ms（预算 2ms）`);
  const landTotal = results.reduce((a, r) => a + r.landings, 0);
  const rollbackTotal = results.reduce((a, r) => a + r.landRollbacks, 0);
  const sampledTotal = results.reduce((a, r) => a + r.sampledCandidates, 0);
  const fairnessTotal = results.reduce((a, r) => a + r.fairnessRejects, 0);
  const strategyTotal = results.reduce((a, r) => a + r.strategyRejects, 0);
  const reservedTotal = results.reduce((a, r) => a + r.reservations, 0);
  const committedTotal = results.reduce((a, r) => a + r.committedEvents, 0);
  console.log(`  候选漏斗：抽样 ${sampledTotal} → 公平性过滤 ${fairnessTotal} → 策略拒绝 ${strategyTotal} → 预约 ${reservedTotal} → 提交 ${committedTotal}`);
  console.log(`  grid 触碰 ${landTotal}（含回滚触碰；事件回滚 ${rollbackTotal}）`);
  if (collapsed.length) process.exit(1);
  console.log('\n判定：✅ 全组合终态合法 + 结构完好 + 无死锁（崩溃边界 = 无崩溃；通关率边界见上）');
}

main();
