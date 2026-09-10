/**
 * 朴素影子回路校验（refinement testing）——报告 §8.5.3 的实证工具。
 *
 * 目的：热路径（DynamicCycle 增删维护 + verifyStructure/monoArcChecker）是被信任的代码，
 * 已知的六个真 bug 恰好都在这一层。本文件提供一个 ~百行的朴素参照实现：
 *  - 每次断言时从 grid.blocked **从零重算**自由格集合（无任何增量状态）；
 *  - 用**独立实现**检查「热路径维护的链接图是自由格上的 2-正则单环」（O(N²) 允许，极慢但极简）；
 *  - 用 **canonical 归一化**比对两个回路（若影子重建出另一条合法回路）：取集合中
 *    index 最小的格作起点、正/反两个遍历方向取字典序较小者，得到规范化序列后逐位比对。
 *
 * 四层等价断言（老师建议的粒度）：
 *  L1 同自由格集合：热路径 cells 集合 == 从 grid.blocked 重算的自由格集合（引擎层状态，严格）；
 *  L2 同 I1：影子独立检查「单环、2-正则、网格相邻」通过；
 *  L3 同 I2：蛇身格在环上序号尾→头严格单调；
 *  L4 cycle 语义等价：canonical 归一化后逐位相等。
 *
 * 注意：影子重算用的是**当前 grid**（含动态障碍），因此 L4 的语义是
 * 「热路径维护的回路确实是当前自由格上的一个合法哈密顿回路，且是影子唯一重建出的那条」——
 * 生成树法在自由格唯一时（同 seed 同布局）回路确定，故 L4 可逐位比对。
 */

/** 影子：从 blocked 独立重算自由格集合 */
export function shadowFreeSet(blocked: Uint8Array): Set<number> {
  const s = new Set<number>();
  for (let c = 0; c < blocked.length; c++) if (!blocked[c]) s.add(c);
  return s;
}

/** 影子：独立检查「链接图是自由格上的单一简单环」（不用 DynamicCycle 的任何字段） */
export function shadowCheckRing(
  next: Int32Array,
  prev: Int32Array,
  blocked: Uint8Array,
  w: number,
  expectedN: number,
): string | null {
  const h = blocked.length / w;
  // 收集链接格
  const linked: number[] = [];
  for (let c = 0; c < next.length; c++) if (next[c] >= 0) linked.push(c);
  if (linked.length !== expectedN) return `链接数 ${linked.length} != ${expectedN}`;
  if (linked.length === 0) return '空环';
  // 从任一格沿 next 走一圈（朴素实现：用 Set 判重，允许 O(N)）
  const start = linked[0];
  const visited = new Set<number>([start]);
  let cur = start;
  let count = 1;
  for (;;) {
    const nx = next[cur];
    if (nx < 0) return `格 ${cur} 无后继`;
    if (visited.has(nx)) {
      if (nx !== start) return `提前回到非起点格 ${nx}（多环或形状错误）`;
      break;
    }
    visited.add(nx);
    count++;
    if (count > linked.length) return '环过长';
    cur = nx;
  }
  if (visited.size !== linked.length) return `单环只覆盖 ${visited.size}/${linked.length} 格（存在第二环）`;
  // 逐格检查：在 blocked 上自由 + next/prev 对称 + 网格相邻
  for (const c of visited) {
    const nx = next[c];
    const x = c % w;
    const y = (c - x) / w;
    const nx2 = nx % w;
    const ny = (nx - nx2) / w;
    if (Math.abs(x - nx2) + Math.abs(y - ny) !== 1) return `传送边 ${c}→${nx}`;
    if (prev[nx] !== c) return `prev 不一致 ${nx}`;
    if (blocked[c]) return `格 ${c} 在障碍上`;
    void h;
  }
  return null;
}

/**
 * 影子：从 blocked 独立重建一条哈密顿回路（每次全量重跑生成树法，无增量状态），
 * 与热路径回路做 canonical 归一化比对。
 * 返回 null = 等价；字符串 = 违例描述。
 */
export function shadowCompareCycle(
  hotCells: Int32Array,
  hotN: number,
  rebuildOrder: number[] | null,
  gridFreeCount: number,
): string | null {
  if (hotN !== gridFreeCount) return `热路径 N=${hotN} != grid 自由格 ${gridFreeCount}`;
  if (!rebuildOrder) return '影子重建失败（rebuildFn 未提供或失败）';
  if (rebuildOrder.length !== hotN) return `影子回路长 ${rebuildOrder.length} != 热路径 ${hotN}`;
  // canonical 归一化：起点 = 集合中最小格；方向 = 正/反字典序取小
  const norm = (order: number[]): number[] => {
    let minIdx = 0;
    for (let i = 1; i < order.length; i++) if (order[i] < order[minIdx]) minIdx = i;
    const rot = order.slice(minIdx).concat(order.slice(0, minIdx));
    const rev = [rot[0], ...rot.slice(1).reverse()];
    return lexLess(rot, rev) ? rot : rev;
  };
  const lexLess = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  };
  const hotList = Array.from(hotCells.slice(0, hotN));
  const nHot = norm(hotList);
  const nShadow = norm(rebuildOrder);
  for (let i = 0; i < nHot.length; i++) {
    if (nHot[i] !== nShadow[i]) {
      return `canonical 序列在第 ${i} 位分歧: 热路径 ${nHot[i]} vs 影子 ${nShadow[i]}（同合法回路的不同形态，或维护错误）`;
    }
  }
  return null;
}

/** L3：独立验证「蛇身格在环上序号尾→头严格单调」（不依赖 monoArcChecker） */
export function shadowCheckMonoArc(
  idx: Int32Array,
  N: number,
  bodyCells: number[],
): boolean {
  const L = bodyCells.length;
  if (L <= 1) return true;
  const hIdx = idx[bodyCells[L - 1]];
  let prevDist = -1;
  for (let i = 0; i < L; i++) {
    if (idx[bodyCells[i]] < 0) return false;
    const dist = (hIdx - idx[bodyCells[i]] + N) % N;
    if (i > 0 && dist >= prevDist) return false;
    prevDist = dist;
  }
  return true;
}
