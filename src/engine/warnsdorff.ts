/**
 * 一般网格图哈密顿回路搜索（Warnsdorff 启发式 + 回溯，节点预算限制）。
 *
 * 用途：extreme-dyn-B（单格动态障碍）。单格障碍图一般不满足宏格对齐，
 * 生成树法不可用；本搜索在 O(N) 可行性预检（黑白平衡 + 无死胡同）通过后尝试构造回路。
 *
 * 算法：DFS 回溯。每步候选按 Warnsdorff 度（后续自由邻格数）升序排序——
 * 「先走难走的」经典启发式。连通性剪枝：剩余格必须从当前格可达（过桥检测）。
 * 节点预算（默认 200k）超限即放弃——搜索是尽力而为，失败由调用方退化到安全搜索。
 */
/** 四方向（与 types.ts DX/DY 一致）：右、左、下、上 */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface WarnsdorffResult {
  order: number[] | null;
  nodesExplored: number;
  budgetExhausted: boolean;
}

/**
 * 在 grid（w×h，blocked 位图）上搜哈密顿回路。
 * @param blocked     障碍位图
 * @param w           宽
 * @param start       起点格（回路从这里开始）
 * @param nodeBudget  搜索节点预算
 * @returns 回路序（长度 = 自由格数）或 null
 */
export function warnsdorffCycle(
  blocked: Uint8Array,
  w: number,
  start: number,
  nodeBudget = 200_000,
): WarnsdorffResult {
  const h = blocked.length / w;
  const n = w * h;
  const free: number[] = [];
  for (let c = 0; c < n; c++) if (!blocked[c]) free.push(c);
  const freeCount = free.length;
  const order: number[] = [start];
  const visited = new Uint8Array(n);
  visited[start] = 1;
  // 每格的剩余自由邻格数（动态更新：已访问的格使邻格度 -1）
  const degree = new Int8Array(n);
  for (const c of free) {
    const x = c % w;
    const y = (c - x) / w;
    let d = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && !blocked[ny * w + nx]) d++;
    }
    degree[c] = d;
  }
  let nodes = 0;
  let budgetExhausted = false;
  // 可达性剪枝缓冲（避免每次分配）
  const reachStamp = new Int32Array(n);
  let stamp = 0;
  const reachQueue = new Int32Array(n);

  /** 从 from 出发（不含 from）能否到达所有未访问格；顺带检测度 ≤1 的未访问死格（除终点外） */
  const reachOk = (from: number, remaining: number): boolean => {
    stamp++;
    let qh = 0,
      qt = 0;
    reachQueue[qt++] = from;
    reachStamp[from] = stamp;
    let reach = 0;
    while (qh < qt) {
      const c = reachQueue[qh++];
      const x = c % w;
      const y = (c - x) / w;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (blocked[j] || visited[j] || reachStamp[j] === stamp) continue;
        reachStamp[j] = stamp;
        reach++;
        if (qt < n) reachQueue[qt++] = j;
      }
    }
    return reach >= remaining;
  };

  const dfs = (cur: number, remaining: number): boolean => {
    if (remaining === 0) return true;
    if (++nodes > nodeBudget) {
      budgetExhausted = true;
      return false;
    }
    // 收集候选邻格（未访问）
    const x = cur % w;
    const y = (cur - x) / w;
    const cands: Array<{ c: number; deg: number }> = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const j = ny * w + nx;
      if (blocked[j] || visited[j]) continue;
      cands.push({ c: j, deg: degree[j] });
    }
    // Warnsdorff：度升序（度 0 且 remaining>1 直接剪枝）
    cands.sort((a, b) => a.deg - b.deg);
    for (const { c } of cands) {
      if (remaining > 1 && degree[c] === 0) continue; // 死格（非终点）
      visited[c] = 1;
      order.push(c);
      // 邻格度 -1
      const cx = c % w;
      const cy = (c - cx) / w;
      let decOk = true;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (!blocked[j]) degree[j]--;
      }
      void decOk;
      if (remaining > 1 && !reachOk(c, remaining - 1)) {
        // 连通性剪枝失败，回溯
        visited[c] = 0;
        order.pop();
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const j = ny * w + nx;
          if (!blocked[j]) degree[j]++;
        }
        if (budgetExhausted) return false;
        continue;
      }
      if (dfs(c, remaining - 1)) return true;
      // 回溯
      visited[c] = 0;
      order.pop();
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (!blocked[j]) degree[j]++;
      }
      if (budgetExhausted) return false;
    }
    return false;
  };

  const ok = reachOk(start, freeCount - 1) && dfs(start, freeCount - 1);
  return { order: ok ? order : null, nodesExplored: nodes, budgetExhausted };
}
