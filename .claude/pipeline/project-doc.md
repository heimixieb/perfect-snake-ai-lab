# Project Documentation
> Generated: 2026-09-11T16:44:24+08:00 | Mode: FULL

## Tech Stack
- Runtime: Node.js 20+
- Language: TypeScript 5.9 (strict)
- Framework: React 19 + Vite 7
- Rendering: HTML Canvas + CSS/Tailwind CSS 4
- State: local React state; core engine uses typed arrays
- Packaging: `vite-plugin-singlefile` produces a standalone `dist/index.html`

## Dependencies
- Core: React 19.2.6, React DOM 19.2.6, clsx 2.1.1, tailwind-merge 3.4.0
- Build: Vite 7.3.2, TypeScript 5.9.3, Tailwind CSS 4.1.17
- Script runtime: tsx 4.23.x
- Testing: executable TypeScript verification scripts; no unit-test framework

## Architecture Pattern
Headless simulation engine plus presentation layer. `src/engine` owns deterministic game state, algorithms, dynamic maintenance and verification. React components consume the engine but the engine never imports DOM APIs, so Node scripts and the browser share behavior.

Dynamic maintenance follows a candidate/validate/commit pattern. `DynScheduler` owns event lifecycle, `DynamicCycle` owns the committed Hamiltonian representation, and `DegradeController` owns performance-mode transitions. `TwoFactorCycle` is an optional experimental replacement behind a feature flag.

## Folder Structure
- `src/engine/`: grid, state machine, strategies, search, Hamiltonian construction, dynamic cycles, 2-factor and shadow verification
- `src/components/`: live demo, benchmark UI and research report
- `src/content/`: captured static baseline data
- `src/workers/`: browser benchmark worker
- `scripts/`: deterministic benchmarks, property checks, fault injection and scale experiments
- `docs/`: public architecture and verification contracts
- `.github/`: CI, issue forms and PR template
- `tla/`: user-owned TLA+ protocol model and generated TLC state artifacts; currently untracked

## Code Style Conventions
- ES modules with explicit relative imports
- Two-space indentation and semicolons
- Classes for stateful engine components; plain functions for algorithms and strategy factories
- `Int32Array`/`Uint8Array` for hot grid state
- Fixed seeds are mixed into separate random streams for obstacles, food and scheduling
- Comments are primarily Chinese and explain invariants and measurement semantics

## Modularity Practices
- `Game` is the authoritative game state machine.
- Strategies return moves through the `Strategy` interface and do not own rendering.
- Scenario configuration is centralized in `src/engine/scenarios.ts`.
- Verification logic is split between trusted hot-path checks and the independent `shadow.ts` reference implementation.
- CLI scripts import production engine modules directly rather than duplicating simulation logic.

## Data Architecture
No database or network persistence. A game is an in-memory deterministic state graph. Grid occupancy, reservations, visits, links and cycle indices use typed arrays indexed by cell id. Snake body storage is a circular buffer.

## Cross-Cutting Concerns
- Determinism: fixed seeds and separated RNG streams
- Errors: explicit `FailReason` values, including collision, starvation, step limit and maintenance failure
- Validation: bounds checks in `Game.step`, transactional cycle candidates, exact optional support-set checks
- Performance: pooled latency metrics; shared CI reports but does not gate on wall clock
- Security: no secrets or remote service dependencies

## Service Communication
No remote services. The browser can use a Web Worker for benchmarks; messages carry scenario and result data between UI and worker.

## Test Coverage
- Overall line coverage: not instrumented
- Framework: executable TypeScript scripts via `tsx`
- Patterns: property-based operation sequences, shadow/refinement checks, fault injection, seeded scenario benchmarks, 2-factor differential checks
- Key gaps: strict A2 committed-adversary semantics, formal liveness proof for expiring food, browser end-to-end regression tests

## Entry Points
- Web: `src/main.tsx` → `src/App.tsx`
- Build: `vite.config.ts`
- Static benchmark: `scripts/bench.ts`
- Dynamic benchmark: `scripts/bench-dyn.ts`
- Full documented verification: `npm run verify`

## Last Scanned
2026-09-11T16:44:24+08:00
