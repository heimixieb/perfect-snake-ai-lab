# Verification snapshot

> Candidate working tree, 2026-09-11. Re-run on a release commit before citing these numbers externally.

## Environment

- OS: Windows 10.0.19043
- CPU: Intel Core i5-9600KF @ 3.70GHz
- Node.js: v24.19.0
- Command: `npx tsx scripts/bench-dyn.ts 20 7000 --correctness-only`
- Scenario: `extreme-dyn` (A1), seeds 7000–7019

## Dynamic correctness run

| Metric | Result |
|---|---:|
| Wins | 20/20 |
| Safety failures | 0/20 |
| Mean steps | 55,298 |
| Mean initial-capacity ratio | 99.9% |
| Mean V coverage | 100.0% |
| Pooled decision p99 | 0.8927 ms |
| Worst per-episode p99 | 1.0383 ms |
| Over-budget samples | 296 / 1,105,960 (0.027%) |

Event funnel: 484,137 candidates sampled; 424,048 environment-filtered; 56,422 rejected by the maintenance strategy; 3,667 reservations; 7,330 committed block/unblock events; zero landing rollbacks.

The candidate rejection count is part of the result, not noise. This A1 run does not support a strict committed-adversary claim.

## Verification suite

`npm run verify` completed with:

- strict TypeScript check and single-file production build;
- 10,001 property assertions after 10,000 random topology operations;
- 8 shadow games, 11,944 four-layer assertions, zero failures;
- 40 games for each of five fault-injection modes (200 games total), all legal terminal states and no committed-structure corruption;
- 20-seed dynamic correctness gate, 20/20 wins and zero safety failures.

`npm run test:twofactor` additionally completed 8,659 structural checkpoints with zero failures. Its differential acceptance result was 1,757 exact agreements, 6 events accepted only by 2-factor, and 232 events accepted only by full rebuild; the experimental engine is therefore not claimed to have the same acceptance set.

Wall-clock results are measurements, not deterministic guarantees. Fixed seeds reproduce logical inputs and outcomes, while timing depends on hardware, JIT, GC and system load.
