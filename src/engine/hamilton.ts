import { Grid } from './grid';
import { RNG } from './rng';

export interface HamiltonCycle {
  /** 回路长度（覆盖的格数） */
  length: number;
  /** cell -> 回路序号 */
  index: Int32Array;
  /** 回路序号 -> cell */
  cells: Int32Array;
  /** 奇×奇地图时被跳过的角格（通过“别名序号”并入回路），否则 -1 */
  aliasCell: number;
  kind: 'zigzag-rows' | 'zigzag-cols' | 'odd-corner-skip' | 'spanning-tree';
}

/**
 * 哈密顿回路存在性的必要条件检测（融合自 5.1 A 的 cycleFeasibility，O(N)）：
 * 网格是二分图 ⇒ 回路要求可通行格数为偶数且黑白格数相等；死胡同格（度数 ≤ 1）使回路不可能。
 * 不满足 ⇒ 任何回路方案都注定失败，UI 直接给出原因（不必等构造失败才发现）。
 */
export function cycleFeasibility(grid: Grid): { ok: boolean; reason: string; deadEnds: number } {
  let deadEnds = 0;
  for (let i = 0; i < grid.n; i++) {
    if (!grid.blocked[i] && grid.degree(i) <= 1) deadEnds++;
  }
  if (grid.freeCount % 2 !== 0) {
    return { ok: false, reason: `可通行格数 ${grid.freeCount} 为奇数`, deadEnds };
  }
  let black = 0;
  for (let i = 0; i < grid.n; i++) {
    if (!grid.blocked[i] && (grid.x(i) + grid.y(i)) % 2 === 0) black++;
  }
  if (black * 2 !== grid.freeCount) {
    return { ok: false, reason: `黑白格数不等 (${black} vs ${grid.freeCount - black})`, deadEnds };
  }
  if (deadEnds > 0) {
    return { ok: false, reason: `存在 ${deadEnds} 个死胡同格`, deadEnds };
  }
  return { ok: true, reason: '满足回路存在的必要条件', deadEnds: 0 };
}

/**
 * 为无障碍矩形地图构造哈密顿回路。
 * - 任一边为偶数：经典 zigzag（第 0 行/列作为回程通道），覆盖全部 W×H 格；
 * - 两边均为奇数：由二分图奇偶性可证不存在哈密顿回路（格数为奇数），
 *   本实现构造覆盖 W×H−1 格的回路并跳过角格 (0,H−1)，
 *   该角格被赋予与 (1,H−2) 相同的“别名序号”，蛇在经过 (1,H−1)→(0,H−2) 一段时可绕行经过它，
 *   因此仍能吃到落在该格的食物，并可实现 100% 格子覆盖与吃满。
 * - 有障碍：返回 null（一般图上的哈密顿回路是 NP-完全问题，交由安全搜索策略处理）。
 */
export function buildHamiltonCycle(grid: Grid, seed = 1): HamiltonCycle | null {
  const { w, h, n } = grid;
  if (w < 3 || h < 3) return null;
  let hasObstacle = false;
  for (let i = 0; i < n; i++) if (grid.blocked[i]) hasObstacle = true;
  if (hasObstacle) return buildSpanningTreeCycle(grid, seed);

  const order: number[] = [];
  const push = (x: number, y: number) => order.push(y * w + x);

  if (h % 2 === 0) {
    // 行 zigzag，第 0 列回程
    for (let x = 0; x < w; x++) push(x, 0);
    for (let y = 1; y < h; y++) {
      if (y % 2 === 1) for (let x = w - 1; x >= 1; x--) push(x, y);
      else for (let x = 1; x < w; x++) push(x, y);
    }
    for (let y = h - 1; y >= 1; y--) push(0, y);
    return finish(order, n, -1, -1, 'zigzag-rows');
  }
  if (w % 2 === 0) {
    // 列 zigzag，第 0 行回程
    for (let y = 0; y < h; y++) push(0, y);
    for (let x = 1; x < w; x++) {
      if (x % 2 === 1) for (let y = h - 1; y >= 1; y--) push(x, y);
      else for (let y = 1; y < h; y++) push(x, y);
    }
    for (let x = w - 1; x >= 1; x--) push(x, 0);
    return finish(order, n, -1, -1, 'zigzag-cols');
  }
  // 奇×奇：跳过 (0,h-1)
  for (let x = 0; x < w; x++) push(x, 0);
  for (let y = 1; y <= h - 3; y++) {
    if (y % 2 === 1) for (let x = w - 1; x >= 1; x--) push(x, y);
    else for (let x = 1; x < w; x++) push(x, y);
  }
  // 梳状覆盖最后两行，从 x=w-1 向左
  for (let x = w - 1; x >= 1; x--) {
    if ((w - 1 - x) % 2 === 0) {
      push(x, h - 2);
      push(x, h - 1);
    } else {
      push(x, h - 1);
      push(x, h - 2);
    }
  }
  for (let y = h - 2; y >= 1; y--) push(0, y);
  const alias = (h - 1) * w + 0;
  const aliasOf = (h - 2) * w + 1; // (1,h-2)
  return finish(order, n, alias, aliasOf, 'odd-corner-skip');
}

/**
 * 宏格生成树法（借鉴 J. Tapsell 的 Nokia Snake AI 思路，并推广到带宏格障碍的地图）：
 * 1. 把地图划分为 2×2 宏格；被障碍占据的宏格移除（要求障碍恰好对齐宏格，否则返回 null）；
 * 2. 在自由宏格图上用随机化 Prim 构造一棵生成树（seed 可复现）；
 * 3. 每个宏格初始为一个 4 格小环；对每条树边，删除两宏格相对的一对边、加入两条跨宏格边，
 *    把两个环“缝合”为一个环。树无环且连通 ⇒ 最终得到唯一一个覆盖全部自由格的哈密顿回路。
 * 4. 从 (0,0) 出发沿 (1,0) 方向遍历回路并编号，保证与蛇初始体序一致。
 */
function buildSpanningTreeCycle(grid: Grid, seed: number): HamiltonCycle | null {
  const { w, h, n } = grid;
  if (w % 2 !== 0 || h % 2 !== 0) return null;
  const mw = w / 2,
    mh = h / 2;
  const mfree = new Uint8Array(mw * mh);
  for (let my = 0; my < mh; my++)
    for (let mx = 0; mx < mw; mx++) {
      const cells = [
        (2 * my) * w + 2 * mx,
        (2 * my) * w + 2 * mx + 1,
        (2 * my + 1) * w + 2 * mx,
        (2 * my + 1) * w + 2 * mx + 1,
      ];
      const b = cells.map((c) => grid.blocked[c]);
      const sum = b[0] + b[1] + b[2] + b[3];
      if (sum !== 0 && sum !== 4) return null; // 障碍未对齐宏格
      mfree[my * mw + mx] = sum === 0 ? 1 : 0;
    }
  if (!mfree[0]) return null;

  // 格子级邻接（每格最终恰好 2 个邻居）
  const adj: number[][] = Array.from({ length: n }, () => []);
  const link = (a: number, b: number) => {
    adj[a].push(b);
    adj[b].push(a);
  };
  const unlink = (a: number, b: number) => {
    adj[a] = adj[a].filter((x) => x !== b);
    adj[b] = adj[b].filter((x) => x !== a);
  };
  const tl = (m: number) => (2 * ((m / mw) | 0)) * w + 2 * (m % mw);
  for (let m = 0; m < mw * mh; m++) {
    if (!mfree[m]) continue;
    const a = tl(m),
      b = a + 1,
      c = a + w,
      d = a + w + 1;
    link(a, b);
    link(b, d);
    link(d, c);
    link(c, a);
  }

  // 随机化 Prim 生成树
  const rng = new RNG(seed);
  const inTree = new Uint8Array(mw * mh);
  const frontier: Array<[number, number]> = [];
  const addFrontier = (m: number) => {
    const mx = m % mw,
      my = (m / mw) | 0;
    const cand = [
      [mx + 1, my],
      [mx - 1, my],
      [mx, my + 1],
      [mx, my - 1],
    ];
    for (const [nx, ny] of cand) {
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
      const k = ny * mw + nx;
      if (mfree[k] && !inTree[k]) frontier.push([m, k]);
    }
  };
  inTree[0] = 1;
  addFrontier(0);
  let treeCount = 1;
  while (frontier.length) {
    const i = rng.int(frontier.length);
    const [from, to] = frontier[i];
    frontier[i] = frontier[frontier.length - 1];
    frontier.pop();
    if (inTree[to]) continue;
    inTree[to] = 1;
    treeCount++;
    addFrontier(to);
    // 缝合 from 与 to 两个宏格的环
    const A = tl(from),
      B = tl(to);
    const fx = from % mw,
      fy = (from / mw) | 0,
      tx = to % mw,
      ty = (to / mw) | 0;
    if (ty === fy) {
      const L = tx > fx ? A : B; // 左侧宏格
      const R = tx > fx ? B : A;
      unlink(L + 1, L + w + 1); // 左宏格右边
      unlink(R, R + w); // 右宏格左边
      link(L + 1, R);
      link(L + w + 1, R + w);
    } else {
      const T = ty > fy ? A : B; // 上方宏格
      const D = ty > fy ? B : A;
      unlink(T + w, T + w + 1); // 上宏格底边
      unlink(D, D + 1); // 下宏格顶边
      link(T + w, D);
      link(T + w + 1, D + 1);
    }
  }
  let freeMacro = 0;
  for (let m = 0; m < mw * mh; m++) if (mfree[m]) freeMacro++;
  if (treeCount !== freeMacro) return null; // 宏格图不连通

  // 遍历回路：从 (0,0) 出发，先走向 (1,0)。
  // 遍历失败（提前回起点/长度不符）时换起点与首方向重试：
  // 2-正则环上每个格恰好 2 邻居，从任意格沿任一方向走都应覆盖全环；但从 (0,0)+(1,0) 起步
  // 遇到特定树形态时 adj 邻序会使 `nb[0]===prev` 判断选错分支（实测宏格 8+196 组合恒失败）。
  // 环游本质与起点无关，换起点必能成功（O(N)×4 上界）。
  for (const [startCell, firstStep] of [
    [0, 1],
    [1, 0],
    [0, w],
    [w, 0],
  ] as Array<[number, number]>) {
    if (grid.blocked[startCell] || grid.blocked[firstStep]) continue;
    const order: number[] = [];
    let prev = startCell,
      cur = firstStep;
    order.push(startCell);
    let failed = false;
    while (cur !== startCell) {
      order.push(cur);
      const nb = adj[cur];
      const nxt = nb[0] === prev ? nb[1] : nb[0];
      prev = cur;
      cur = nxt;
      if (order.length > n) {
        failed = true;
        break;
      }
    }
    if (!failed && order.length === grid.freeCount) {
      return finish(order, n, -1, -1, 'spanning-tree');
    }
  }
  return null;
}

function finish(
  order: number[],
  n: number,
  alias: number,
  aliasOf: number,
  kind: HamiltonCycle['kind'],
): HamiltonCycle {
  const index = new Int32Array(n).fill(-1);
  const cells = new Int32Array(order.length);
  order.forEach((c, i) => {
    index[c] = i;
    cells[i] = c;
  });
  if (alias >= 0) index[alias] = index[aliasOf];
  return { length: order.length, index, cells, aliasCell: alias, kind };
}
