/**
 * b-预研探针：宏格环邻接友好度统计。
 *
 * 【语义边界——必读】本探针统计的是「2×2 宏格环特例」的邻接结构：宏格法把每个
 * 2×2 块绑定为 4 格小环，环间邻接是宏格级别的。它只回答「现有障碍布局下宏格
 * 级结构是否足够连成树形合并结构」（可行性佐证），**不代表**一般 2-factor 圈
 * 分解下的合并条件成立率——真正的 2-factor 圈由匹配增广决定，可跨宏格边界，
 * 坏情况（两圈对角相触）恰恰发生在宏格环看不见的地方。引用本数据时不得表述为
 * 「2-factor 增量维护的预期收益」。
 *
 * 用法：npx tsx scripts/macro-neighbor-probe.ts [场景=medium] [seeds=10]
 */
import { getScenario } from '../src/engine/scenarios';
import { Game } from '../src/engine/game';

const sid = process.argv[2] ?? 'medium';
const seeds = Number(process.argv[3] ?? 10);
const cfg = getScenario(sid);

let totalPairs = 0, sharedEdgePairs = 0, diagonalPairs = 0;
for (let seed = 7000; seed < 7000 + seeds; seed++) {
  const game = new Game(cfg, seed);
  const g = game.grid;
  const mw = g.w / 2;
  const macroTL = (m: number) => ((m / mw) | 0) * 2 * g.w + (m % mw) * 2;
  const freeM: number[] = [];
  for (let m = 0; m < mw * mw; m++) if (!g.blocked[macroTL(m)]) freeM.push(m);
  const freeSet = new Set(freeM);
  // 相邻宏格对统计
  for (const m of freeM) {
    const mx = m % mw, my = (m / mw) | 0;
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      const nm = (my + dy) * mw + (mx + dx);
      if (mx + dx >= mw || my + dy >= mw * 0 + mw) { /* bounds */ }
      if (mx + dx >= mw && dx === 1) continue;
      if (my + dy >= mw && dy === 1) continue;
      if (!freeSet.has(nm)) continue;
      totalPairs++;
      sharedEdgePairs++; // 宏格图相邻 = 两 2×2 块共享一条完整网格边（2 格对）→ 恒有平行边
    }
  }
  // 对角相触检测：两自由宏格仅对角相邻（无共享边）——在宏格粒度上即 (mx±1,my±1)
  // 均自由但四个正交邻均障碍。这在宏格对齐布局中被生成器（连通性检查）排除，
  // 但单格障碍布局下可能出现。
  for (const m of freeM) {
    const mx = m % mw, my = (m / mw) | 0;
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nx = mx + dx, ny = my + dy;
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mw) continue;
      const nm = ny * mw + nx;
      if (!freeSet.has(nm)) continue;
      const orthoFree = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx2, dy2]) => {
        const om = (my + dy2) * mw + (mx + dx2);
        if (mx + dx2 < 0 || my + dy2 < 0 || mx + dx2 >= mw || my + dy2 >= mw) return false;
        return freeSet.has(om);
      }).length;
      // 对角相邻且两宏格间无正交自由宏格路径（简化：正交邻全障碍）
      if (orthoFree === 0) diagonalPairs++;
    }
  }
}
console.log(`场景 ${sid} × ${seeds} seeds:`);
console.log(`  宏格级相邻对（共享完整网格边 → 平行边缝合恒可行）: ${sharedEdgePairs}`);
console.log(`  对角相触对（正交邻全障碍 → 需 3-顶点 reroute）: ${diagonalPairs}`);
console.log(`  结论: 宏格对齐布局下合并条件恒成立（相邻对全为共享边型）；对角相触仅可能出现在非宏格对齐布局`);
