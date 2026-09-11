# Perfect Snake AI Lab | Hamiltonian Snake Algorithm

<p align="right"><a href="README.md">简体中文</a> · <strong>English</strong></p>

[![CI](https://github.com/heimixieb/perfect-snake-ai-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/heimixieb/perfect-snake-ai-lab/actions/workflows/ci.yml)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-10b981?logo=github)](https://heimixieb.github.io/perfect-snake-ai-lab/)
[![GitHub stars](https://img.shields.io/github/stars/heimixieb/perfect-snake-ai-lab?style=flat&logo=github)](https://github.com/heimixieb/perfect-snake-ai-lab/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An interactive **Snake AI** lab for comparing food-seeking, **pathfinding**, **Hamiltonian-cycle**, and **dynamic-obstacle** strategies. It shows how a snake can safely fill a regular board—and where that claim stops being true.

[![A Snake AI follows a board-covering cycle and grows until it fills the grid](docs/assets/snake-fill.gif)](https://heimixieb.github.io/perfect-snake-ai-lab/)

<p align="center">
  <a href="https://heimixieb.github.io/perfect-snake-ai-lab/"><strong>▶ Try the live demo</strong></a>
  ·
  <a href="docs/RESEARCH.md">Read the full research report (Chinese)</a>
</p>

## What is this?

It is a browser lab where several computer-controlled snakes face the same board. You can compare which one is safer, faster, or able to eat more food.

- Compare greedy food seeking, safety-aware pathfinding, fixed cycles, automatic strategy selection, and manual play.
- See why the basic cycle-following method is safe on regular boards that admit a complete cycle.
- Watch obstacle warnings, route rebuilding, and attempts to avoid dangerous changes.
- Run fair benchmarks and automatic checks instead of judging one hand-picked game.
- Recreate every random board from the same seed so other people can verify the result.

## How does it fill the board?

Imagine a circular running track that visits every square exactly once before returning to the start. If the snake keeps following that track, its tail moves away before its head reaches the same place, so it does not suddenly trap itself.

The program builds this track first. The snake may take a shortcut when the shortcut is proven safe; otherwise, it stays on the track.

## How do we know it works?

This project does more than record one successful video. It checks the idea in four ways:

1. **Check the route:** it must cover every target square, and every step must move to a neighboring square.
2. **Test changes before using them:** a changing board gets a candidate route first; the live route changes only after validation succeeds.
3. **Use an independent checker:** a separate implementation recalculates the result so the main code is not merely grading itself.
4. **Create failures on purpose:** automated tests generate random changes, force route rebuilds to fail, and simulate slow decisions to confirm that the engine remains valid or stops safely.

Every code change runs these checks on GitHub. The published verification snapshot includes 10,001 randomized route checks, 200 fault-injection games, and 20 dynamic-board games. See the [verification snapshot](docs/benchmarks.md) for commands and exact boundaries.

![Win-rate comparison between Snake AI strategies](docs/assets/strategy-comparison.svg)

![Dynamic-obstacle verification summary](docs/assets/dynamic-verification.svg)

## What are the limits?

- “Safely fills the board” applies only to regular boards where a complete cycle can be built. It is not a promise for every possible map.
- Random single-cell obstacles can split the board into a shape that cannot be fully covered.
- Dynamic obstacles must be announced before they appear, and the current engine may reject changes that are too dangerous.
- Winning all 20 published dynamic games describes those samples; it does not prove that every dynamic board will succeed.
- Timing depends on the computer, browser, and background activity, so performance numbers will vary across machines.

## Start in 30 seconds

Node.js 20 or newer is required.

```bash
git clone https://github.com/heimixieb/perfect-snake-ai-lab.git
cd perfect-snake-ai-lab
npm ci
npm run dev
```

Run all automated checks:

```bash
npm run verify
```

Regenerate the hero GIF and charts:

```bash
npm run assets
```

## Screenshots

| Regular board: following a cycle | Dynamic board: obstacles announced ahead of time |
|---|---|
| ![Snake following a Hamiltonian cycle on a regular board](docs/assets/static-demo.png) | ![Snake AI on a dynamic-obstacle board](docs/assets/dynamic-demo.png) |

![In-browser benchmark panel comparing Snake AI strategies](docs/assets/benchmark-panel.png)

<details>
<summary><strong>Want the algorithms, evidence, and exact definitions?</strong></summary>

The deeper material covers graph search, Hamiltonian cycles, order-preserving shortcuts, transactional route rebuilding, a 2-factor experimental engine, property testing, fault injection, and shadow verification.

- [Full research report](docs/RESEARCH.md) (Chinese): the original in-app report, sections 0–10.
- [Verification semantics](docs/verification.md): what each metric can and cannot prove.
- [Architecture](docs/architecture.md): how the engine, browser UI, and scripts are separated.
- [Verification snapshot](docs/benchmarks.md): hardware, commands, sample sizes, and published results.

</details>

## Contributing

New strategies, counterexamples, tests, and interface improvements are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before starting. Please use [SECURITY.md](SECURITY.md) for security reports.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=heimixieb/perfect-snake-ai-lab&type=Date)](https://star-history.com/#heimixieb/perfect-snake-ai-lab&Date)

## Acknowledgments

- John Tapsell's work on Hamiltonian Snake
- Graph-search strategy ideas from `chuyangliu/snake`
- Classic papers on grid traversal and surveys of dynamic graphs

## License

[MIT](LICENSE) © Perfect Snake AI Lab contributors
