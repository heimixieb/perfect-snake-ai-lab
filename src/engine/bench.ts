import { getScenario } from './scenarios';
import { aggregate, runGame } from './simulate';
import { GameResult, ScenarioConfig, StrategyId } from './types';

export interface BenchRequest {
  type: 'run';
  scenarios: string[];
  strategies: StrategyId[];
  runs: number;
  baseSeed: number;
  overrides?: Partial<ScenarioConfig>;
}

export type BenchMessage =
  | { type: 'progress'; done: number; total: number; scenario: string; strategy: StrategyId; last: GameResult }
  | { type: 'aggregate'; scenario: string; strategy: StrategyId; agg: ReturnType<typeof aggregate> }
  | { type: 'finished' };

export function handleRequest(req: BenchRequest, post: (m: BenchMessage) => void) {
  if (req.type !== 'run') return;
  const total = req.scenarios.length * req.strategies.length * req.runs;
  let done = 0;
  for (const sid of req.scenarios) {
    const cfg: ScenarioConfig = { ...getScenario(sid), ...(req.overrides ?? {}) };
    for (const st of req.strategies) {
      const results: GameResult[] = [];
      for (let i = 0; i < req.runs; i++) {
        const r = runGame(cfg, st, req.baseSeed + i);
        results.push(r);
        done++;
        const msg: BenchMessage = { type: 'progress', done, total, scenario: sid, strategy: st, last: r };
        post(msg);
      }
      const msg: BenchMessage = { type: 'aggregate', scenario: sid, strategy: st, agg: aggregate(results) };
      post(msg);
    }
  }
  post({ type: 'finished' });
}
