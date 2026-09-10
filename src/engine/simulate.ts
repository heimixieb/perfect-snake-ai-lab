import { Game, INIT_LENGTH } from './game';
import { searchStats } from './search';
import { createStrategy } from './strategies';
import { AggregateResult, GameResult, ScenarioConfig, StrategyId } from './types';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * 运行一局，直到通关或失败。
 * 终止条件：
 * - won：蛇长 == 可通行格数；
 * - wall/self/obstacle/no-move：碰撞或策略放弃；
 * - starved：连续 6×N 步未进食（判定为死循环/永久追尾）；
 * - step-limit：总步数超过 2×N²（防御性上限）。
 */
export function runGame(cfg: ScenarioConfig, strategy: StrategyId, seed: number): GameResult {
  const game = new Game(cfg, seed);
  const strat = createStrategy(strategy, game);
  const N = game.grid.freeCount;
  const starveLimit = N * 6 + 100;
  const maxSteps = N * N * 2 + 1000;
  let totalMs = 0,
    maxMs = 0,
    over = 0,
    peakNodes = 0;

  while (game.alive && !game.won) {
    searchStats.nodes = 0;
    const t0 = now();
    const next = strat.decide(game);
    const dt = now() - t0;
    totalMs += dt;
    if (dt > maxMs) maxMs = dt;
    if (dt > cfg.timeBudgetMs) over++;
    if (searchStats.nodes > peakNodes) peakNodes = searchStats.nodes;
    game.step(next);
    if (game.alive && !game.won) {
      if (game.stepsSinceFood > starveLimit) game.fail('starved');
      else if (game.steps > maxSteps) game.fail('step-limit');
    }
  }
  const steps = game.steps;
  return {
    strategy,
    scenario: cfg.id,
    seed,
    won: game.won,
    fillRate: Math.min(1, game.fillRate),
    coverage: game.coverage,
    steps,
    foods: game.foodsEaten,
    freeCells: N,
    finalLength: game.length,
    stepsPerFood: game.foodsEaten ? steps / game.foodsEaten : steps,
    totalDecisionMs: totalMs,
    avgDecisionMs: steps ? totalMs / steps : 0,
    maxDecisionMs: maxMs,
    overBudget: over,
    peakNodes,
    // 内存估算：搜索节点（dist/parent/stamp/queue 各 4B + 标记 1B ≈ 17B，取 24B 含堆开销）+ 栅格位图（占用/访问/食物索引/邻接表）
    peakMemKB: (peakNodes * 24 + game.grid.n * (1 + 1 + 4 + 16) + game.grid.n * 4) / 1024,
    failReason: game.won ? 'none' : game.failReason,
    expiredFoods: game.expiredFoods,
  };
}

export function aggregate(results: GameResult[]): AggregateResult {
  const n = results.length || 1;
  const sum = (f: (r: GameResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const failReasons: Record<string, number> = {};
  for (const r of results) if (!r.won) failReasons[r.failReason] = (failReasons[r.failReason] ?? 0) + 1;
  return {
    strategy: results[0]?.strategy ?? 'hybrid',
    scenario: results[0]?.scenario ?? '',
    runs: results.length,
    winRate: sum((r) => (r.won ? 1 : 0)) / n,
    avgFill: sum((r) => r.fillRate) / n,
    avgCoverage: sum((r) => r.coverage) / n,
    avgSteps: sum((r) => r.steps) / n,
    avgStepsPerFood: sum((r) => r.stepsPerFood) / n,
    avgDecisionMs: sum((r) => r.avgDecisionMs) / n,
    maxDecisionMs: results.reduce((a, r) => Math.max(a, r.maxDecisionMs), 0),
    avgPeakNodes: sum((r) => r.peakNodes) / n,
    avgPeakMemKB: sum((r) => r.peakMemKB) / n,
    overBudgetRate: sum((r) => (r.steps ? r.overBudget / r.steps : 0)) / n,
    failReasons,
    results,
  };
}

export { INIT_LENGTH };
