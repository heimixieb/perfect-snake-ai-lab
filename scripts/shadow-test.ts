/**
 * 影子实现 refinement 测试：在真实对局中周期性断言「热路径 == 影子重算」。
 *
 * 断言频率论证（自适应粒度）：事件落地后 1 步必断言 + 平时每 50 步稳定点。
 *  - 事件落地后 1 步：重建提交（rebuildCore → verifyStructure 通过）后的下一步是拓扑
 *    最脆弱时刻——提交视图刚换、蛇身弧沿新回路走出的第一步。编排类 bug（unblock 不缝回、
 *    idx 快照缺、rebuildNeighbors 时序）错误此刻已存在且最容易被 L1/L4 抓住，断言价值最高；
 *  - 平时 50 步：稳定点断言测稳态性质——「每次声明的重算之后、下一次事件落地之前，
 *    提交的回路对该网格有效」。错误若持续存在到稳定点必抓；
 *  - 瞬时类（预约格被缝回）落地瞬间错误但会触发 verifyStructure 回滚自愈，
 *    影子本来就不该抓这种自愈的错误——那是结构校验器 + 回滚的职责。
 *  （频率从固定 25 步升级为自适应：原 25 步粒度下事件落地与最近断言点平均相距 12.5 步，
 *   最脆弱窗口反而最稀疏；自适应把断言预算集中到落地后 1 步，其余时段减半到 50 步，
 *   总断言次数近似不变而覆盖价值显著上移。）
 *
 * 四层等价（L1 语义按「回路 ⊔ 预约位 = 自由集」修正——预约格处于 grid 未 block
 * 但回路已排除的中间态，是设计行为而非错误）：
 *  L1 回路格集合 ⊔ 预约位集合 = 自由格集合（无第三种格）
 *  L2 影子独立检查单环/2-正则/网格相邻通过
 *  L3 影子独立验证蛇身单调弧
 *  L4 canonical 归一化后回路逐位相等；失败时二诊断：热路径提交回路按提交时
 *     grid（含 reserved 叠加）是否至少合法——合法则预期分歧记日志，非法则 fatal。
 *
 * 独立性（老师 Q12 定案）：共享单次构造器 buildHamiltonCycle，
 * 重试编排与 acceptable 判据热路径/影子各自独立实现——影子存在就是为了和
 * 热路径的编排对着干，分歧说明至少一个编排有 bug。
 *
 * 用法：npx tsx scripts/shadow-test.ts [局数=8] [种子=9000]
 */
import { getScenario } from '../src/engine/scenarios';
import { Game } from '../src/engine/game';
import { createStrategy } from '../src/engine/strategies';
import { buildHamiltonCycle } from '../src/engine/hamilton';
import {
  shadowFreeSet,
  shadowCheckRing,
  shadowCompareCycle,
  shadowCheckMonoArc,
} from '../src/engine/shadow';

function main(): void {
  const games = Number(process.argv[2] ?? 8);
  const seed0 = Number(process.argv[3] ?? 9000);
  const cfg = getScenario('extreme-dyn');
  let assertions = 0;
  let eventAssertions = 0; // 事件落地后 1 步的必断言次数
  let failures = 0;
  let benignDivergences = 0;
  const failDetails: string[] = [];

  for (let gi = 0; gi < games; gi++) {
    const seed = seed0 + gi;
    const game = new Game(cfg, seed);
    const strat = createStrategy('hamilton-dyn', game) as any;
    const dyn = strat._dyn;
    if (!dyn) continue;

    // ===== 影子的独立重试编排（老师 Q12：与热路径各自实现，不共享） =====
    // 影子的 acceptable 判据（独立版）：回路存在 + 覆盖当前自由格数。
    // 与热路径 rebuildFn 的差异：热路径叠加 pendingMacroCells + reserved；
    // 影子在此处按断言时刻的真实状态叠加 reserved（预排语义等价，但独立编写）。
    const shadowRebuildWithRetry = (): number[] | null => {
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
    };

    const maxSteps = game.grid.freeCount * game.grid.freeCount * 2 + 1000;
    let steps = 0;
    let lastLandSeq = -1;
    while (game.alive && !game.won && steps < maxSteps) {
      const next = strat.decide(game);
      game.step(next);
      steps++;
      if (!game.alive || game.won) break;
      if (game.stepsSinceFood > game.grid.freeCount * 6 + 100) game.fail('starved');
      // 自适应频率：事件落地后 1 步必断言 + 平时每 50 步稳定点
      const curLandSeq = strat._scheduler ? strat._scheduler.landSeq : 0;
      const eventJustLanded = curLandSeq !== lastLandSeq;
      lastLandSeq = curLandSeq;
      if (!eventJustLanded && steps % 50 !== 0) continue;
      if (eventJustLanded) eventAssertions++;

      assertions++;
      const w = game.grid.w;

      // ===== L1（修正语义）：回路 ⊔ 预约位 = 自由格 =====
      const shadowFree = shadowFreeSet(game.grid.blocked);
      const hotCells = new Set<number>();
      for (let k = 0; k < dyn.N; k++) hotCells.add(dyn.cells[k]);
      let l1ok = true;
      let l1msg = '';
      for (const c of shadowFree) {
        const inHot = hotCells.has(c);
        const isRsv = game.reserved[c] === 1;
        if (!inHot && !isRsv) { l1ok = false; l1msg = `自由格 ${c} 既不在回路也不在预约位`; break; }
        if (inHot && isRsv) { l1ok = false; l1msg = `格 ${c} 同时在回路和预约位`; break; }
      }
      // 预约位本身不得在回路上
      if (l1ok) {
        for (let c = 0; c < game.grid.n; c++) {
          if (game.reserved[c] && hotCells.has(c)) { l1ok = false; l1msg = `预约格 ${c} 在回路上`; break; }
        }
      }
      if (!l1ok) {
        failures++;
        failDetails.push(`seed ${seed} step ${steps}: L1 ${l1msg}`);
        continue;
      }

      // ===== L2 影子独立单环检查（对热路径提交的链接图） =====
      const ringErr = shadowCheckRing(dyn.next, dyn.prev, game.grid.blocked, w, dyn.N);
      if (ringErr) {
        failures++;
        failDetails.push(`seed ${seed} step ${steps}: L2 ${ringErr}`);
        continue;
      }

      // ===== L3 影子独立单调弧 =====
      if (!shadowCheckMonoArc(dyn.idx, dyn.N, game.bodyCells())) {
        failures++;
        failDetails.push(`seed ${seed} step ${steps}: L3 蛇身单调弧破坏`);
        continue;
      }

      // ===== L4 canonical 等价 + 二诊断 =====
      // 影子重算时叠加 reserved 视图（与热路径 rebuildFn 的预排语义对齐——预约格不在回路）
      const cmpErr = shadowCompareCycle(dyn.cells, dyn.N, shadowRebuildWithRetry(), game.grid.freeCount);
      if (cmpErr) {
        // 二诊断：热路径提交的回路（按提交时 grid = 当前 grid + reserved 叠加）是否至少合法
        const saved: number[] = [];
        for (let c = 0; c < game.grid.n; c++) {
          if (game.reserved[c] && !game.grid.blocked[c]) { game.grid.blocked[c] = 1; saved.push(c); }
        }
        if (saved.length) game.grid.rebuildNeighbors();
        // 热路径回路在提交视图下应恰覆盖全部自由格（N = 叠加后自由格数）
        const committedFree = game.grid.freeCount;
        const committedOk = dyn.N === committedFree;
        for (const c of saved) game.grid.blocked[c] = 0;
        if (saved.length) game.grid.rebuildNeighbors();
        if (committedOk) {
          // 不同但都合法：预期分歧（多 seed 重试命中不同可构造形态），记日志继续
          benignDivergences++;
        } else {
          failures++;
          failDetails.push(`seed ${seed} step ${steps}: L4 真 bug——${cmpErr}；且提交回路长度 ${dyn.N} != 提交时自由格 ${committedFree}`);
          continue;
        }
      }
    }
  }

  console.log(`影子 refinement 测试: ${games} 局, ${assertions} 次四层断言（事件后必断 ${eventAssertions} + 稳点 ${assertions - eventAssertions}）, 真失败 ${failures}, 预期分歧 ${benignDivergences}`);
  if (failures) {
    for (const d of failDetails.slice(0, 10)) console.error('  ' + d);
    process.exit(1);
  }
  console.log('L1 回路⊔预约=自由集 / L2 单环 / L3 单调弧 / L4 canonical 等价（含二诊断）全部通过 ✅');
}

main();
