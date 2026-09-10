/**
 * 性质基随机测试：验证动态回路重建的核心不变量（报告 §8.5 引理）。
 *
 * 不变量：
 *  P1 单环性：每次重建后回路仍是覆盖 N 格的单一简单环，全部链接网格相邻（verifyStructure）；
 *  P2 序号一致性：idx 与 cells 双向一致；
 *  P3 宏格一致性：macroBlocked[m]=1 ⇔ m 的 4 格不在回路上；
 *  P4 覆盖完备：回路 N == grid 当前自由格数（重建对齐 grid）。
 *
 * 测试法：随机 seeds 构造游戏，随机执行 ≥10⁴ 次 removeBlock/insertBlock（经 scheduler 同款
 * 预排/落地时序），每步断言全部不变量。
 *
 * 用法：npx tsx scripts/property-test.ts [操作数=10000] [种子=42]
 */
import { Game } from '../src/engine/game';
import { SCENARIOS } from '../src/engine/scenarios';
import { DynamicCycle } from '../src/engine/dyn';
import { buildHamiltonCycle } from '../src/engine/hamilton';

const cfg = SCENARIOS.find((s) => s.id === 'extreme-dyn')!;

function checkAll(dyn: DynamicCycle, game: Game): string | null {
  const structErr = dyn.verifyStructure(dyn.N);
  if (structErr) return `P1: ${structErr}`;
  for (let i = 0; i < dyn.N; i++) {
    const c = dyn.cells[i];
    if (dyn.idx[c] !== i) return `P2: cells[${i}]=${c} 但 idx=${dyn.idx[c]}`;
  }
  const mw = dyn.mw;
  for (let m = 0; m < mw * dyn.mh; m++) {
    const a = (m % mw) * 2 + ((m / mw) | 0) * 2 * dyn.w;
    const cells = [a, a + 1, a + dyn.w, a + dyn.w + 1];
    const anyIn = cells.some((c) => dyn.idx[c] >= 0);
    const gridBlocked = cells.every((c) => game.grid.blocked[c]);
    if (gridBlocked && anyIn) return `P3: 宏格 ${m} grid 障碍但在回路上`;
    if (!gridBlocked && !anyIn) return `P3: 宏格 ${m} grid 自由但不在回路上`;
  }
  if (dyn.N !== game.grid.freeCount) return `P4: N=${dyn.N} != grid.freeCount=${game.grid.freeCount}`;
  return null;
}

function run(): void {
  const totalOps = Number(process.argv[2] ?? 10000);
  const seed = Number(process.argv[3] ?? 42);
  const game = new Game(cfg, seed);
  const base = buildHamiltonCycle(game.grid, seed);
  if (!base) {
    console.error('初始回路构造失败');
    process.exit(1);
  }
  const dyn = new DynamicCycle(game);
  if (!dyn.init(Array.from(base.cells.slice(0, base.length)))) {
    console.error('init 校验失败');
    process.exit(1);
  }
  // rebuild 接线（与策略同款，但不含蛇身——结构测试）
  dyn.rebuildFn = () => {
    const cyc = buildHamiltonCycle(game.grid, seed + 7919);
    return cyc ? Array.from(cyc.cells.slice(0, cyc.length)) : null;
  };

  const mw = dyn.mw;
  const macroCells = (m: number) => {
    const a = (m % mw) * 2 + ((m / mw) | 0) * 2 * dyn.w;
    return [a, a + 1, a + dyn.w, a + dyn.w + 1];
  };
  let ops = 0;
  let okR = 0;
  let okI = 0;
  let failR = 0;
  let failI = 0;
  let freeList: number[] = [];
  let blockedList: number[] = [];
  for (let m = 0; m < mw * dyn.mh; m++) (dyn.macroBlocked[m] ? blockedList : freeList).push(m);
  let seedCursor = seed + 1;
  const nextRand = (n: number) => {
    // 简单 LCG 保证可复现
    seedCursor = (seedCursor * 1103515245 + 12345) & 0x7fffffff;
    return seedCursor % n;
  };

  while (ops < totalOps) {
    const useR = freeList.length > 2 && (blockedList.length === 0 || nextRand(2) === 0);
    let ok = false;
    let m = -1;
    if (useR) {
      m = freeList[nextRand(freeList.length)];
      // 模拟 scheduler 落地时序：先 grid 更新再重建
      for (const c of macroCells(m)) game.grid.blocked[c] = 1;
      game.grid.rebuildNeighbors();
      ok = dyn.removeBlock(m, () => false);
      if (!ok) {
        // 回滚 grid（与 scheduler 一致）
        for (const c of macroCells(m)) game.grid.blocked[c] = 0;
        game.grid.rebuildNeighbors();
      }
    } else if (blockedList.length) {
      m = blockedList[nextRand(blockedList.length)];
      for (const c of macroCells(m)) game.grid.blocked[c] = 0;
      game.grid.rebuildNeighbors();
      ok = dyn.insertBlock(m, () => false);
      if (!ok) {
        for (const c of macroCells(m)) game.grid.blocked[c] = 1;
        game.grid.rebuildNeighbors();
      }
    } else break;

    ops++;
    const err = checkAll(dyn, game);
    if (err) {
      console.error(`op ${ops} (${ok ? 'ok' : 'fail'} ${useR ? 'remove' : 'insert'} ${m}) 后违例: ${err}`);
      process.exit(1);
    }
    if (ok) {
      if (useR) { okR++; freeList = freeList.filter((x) => x !== m); blockedList.push(m); }
      else { okI++; blockedList = blockedList.filter((x) => x !== m); freeList.push(m); }
    } else if (useR) failR++;
    else failI++;
  }
  console.log(`性质基随机测试: ${ops} 次操作（remove ✓${okR} ✗${failR} / insert ✓${okI} ✗${failI}）`);
  console.log(`不变量断言 ${ops + 1} 次全部通过；walk 总数 ${dyn.walkCount}`);
  console.log('全部不变量（P1 单环 / P2 序号 / P3 宏格一致 / P4 覆盖完备）验证通过 ✅');
}

run();
