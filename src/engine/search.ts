import { Grid } from './grid';

/** 每次决策期间累计的搜索节点数（用作时间/内存代理指标） */
export const searchStats = { nodes: 0 };

/* ---------- 复用缓冲区，避免每次搜索分配（增量/缓存手段之一） ---------- */
let bufN = 0;
let distBuf = new Int32Array(0);
let parentBuf = new Int32Array(0);
let queueBuf = new Int32Array(0);
let markBuf = new Uint8Array(0);
let stampBuf = new Int32Array(0);
let stamp = 1;

function ensure(n: number) {
  if (n > bufN) {
    bufN = n;
    distBuf = new Int32Array(n);
    parentBuf = new Int32Array(n);
    queueBuf = new Int32Array(n);
    markBuf = new Uint8Array(n);
    stampBuf = new Int32Array(n);
  }
  stamp++;
  if (stamp > 2_000_000_000) {
    stampBuf.fill(0);
    stamp = 1;
  }
}

function reconstruct(start: number, goal: number): number[] {
  const path: number[] = [];
  let c = goal;
  while (c !== start) {
    path.push(c);
    c = parentBuf[c];
  }
  path.push(start);
  path.reverse();
  return path;
}

/**
 * BFS 最短路径。occ[i]=1 表示被蛇身占用。allowGoalOcc 允许终点被占用（用于追尾：终点是蛇尾）。
 * 返回包含起点与终点的路径；找不到返回 null。
 */
export function bfs(
  grid: Grid,
  occ: Uint8Array,
  start: number,
  goal: number,
  allowGoalOcc = false,
): number[] | null {
  ensure(grid.n);
  let qh = 0,
    qt = 0;
  queueBuf[qt++] = start;
  stampBuf[start] = stamp;
  parentBuf[start] = -1;
  const nbr = grid.nbr;
  while (qh < qt) {
    const c = queueBuf[qh++];
    searchStats.nodes++;
    if (c === goal) return reconstruct(start, goal);
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const j = nbr[base + d];
      if (j < 0 || stampBuf[j] === stamp) continue;
      if (occ[j] && !(allowGoalOcc && j === goal)) continue;
      stampBuf[j] = stamp;
      parentBuf[j] = c;
      queueBuf[qt++] = j;
    }
  }
  return null;
}

/* ---------- 二叉堆（A* 开放集） ---------- */
class Heap {
  keys: number[] = [];
  vals: number[] = [];
  get size() {
    return this.vals.length;
  }
  push(key: number, val: number) {
    const k = this.keys,
      v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys,
      v = this.vals;
    const top = v[0];
    const lk = k.pop()!,
      lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let m = i;
        if (l < n && k[l] < k[m]) m = l;
        if (r < n && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* 最短路径（曼哈顿启发式，单位代价下可采纳，结果与 BFS 同为最短，但扩展节点更少）。
 * f = g + h，key 编码为 f*1024 + h 以便在 f 相等时优先扩展 h 小者（更快收敛到目标）。
 */
export function astar(
  grid: Grid,
  occ: Uint8Array,
  start: number,
  goal: number,
  allowGoalOcc = false,
): number[] | null {
  ensure(grid.n);
  const w = grid.w;
  const gx = goal % w,
    gy = (goal / w) | 0;
  const h = (i: number) => Math.abs((i % w) - gx) + Math.abs(((i / w) | 0) - gy);
  const heap = new Heap();
  distBuf[start] = 0;
  stampBuf[start] = stamp;
  markBuf[start] = 0;
  parentBuf[start] = -1;
  heap.push(h(start) * 1024 + h(start), start);
  const nbr = grid.nbr;
  while (heap.size) {
    const c = heap.pop();
    if (markBuf[c] === 1 && stampBuf[c] === stamp) continue; // 已关闭
    markBuf[c] = 1;
    searchStats.nodes++;
    if (c === goal) return reconstruct(start, goal);
    const g = distBuf[c] + 1;
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const j = nbr[base + d];
      if (j < 0) continue;
      if (occ[j] && !(allowGoalOcc && j === goal)) continue;
      if (stampBuf[j] === stamp) {
        if (markBuf[j] === 1 || distBuf[j] <= g) continue;
      }
      stampBuf[j] = stamp;
      markBuf[j] = 0;
      distBuf[j] = g;
      parentBuf[j] = c;
      const hj = h(j);
      heap.push((g + hj) * 1024 + hj, j);
    }
  }
  return null;
}

/** 洪水填充：从 start 可达的自由格数量（start 本身不计占用）。可选目标 goal（如蛇尾）是否可达。 */
export function floodFill(
  grid: Grid,
  occ: Uint8Array,
  start: number,
  goal = -1,
): { count: number; reachGoal: boolean } {
  ensure(grid.n);
  let qh = 0,
    qt = 0;
  queueBuf[qt++] = start;
  stampBuf[start] = stamp;
  let reachGoal = false;
  const nbr = grid.nbr;
  while (qh < qt) {
    const c = queueBuf[qh++];
    searchStats.nodes++;
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const j = nbr[base + d];
      if (j < 0 || stampBuf[j] === stamp) continue;
      if (j === goal) reachGoal = true;
      if (occ[j]) continue;
      stampBuf[j] = stamp;
      queueBuf[qt++] = j;
    }
  }
  return { count: qt, reachGoal };
}

/**
 * 时间感知的追尾可达性检测（融合自 5.1 A 的 canReachTailInTime）：
 * body 为尾→头序列，第 k 节身体在第 k+1 步移动时让开（到达步数 s 满足 k < s 时可进入）。
 * 头以最早到达时间 BFS 扩展；一旦能在某时刻进入一个已让开的身体格（k < s），
 * 之后即可沿尾迹无限跟随 ⇒ 安全。假设途中不再进食。
 * 比静态「BFS 到尾」更宽松且同样可靠：静态判定通过的时间感知判定必然也通过。
 */
export function canReachTailInTime(grid: Grid, body: number[]): boolean {
  const L = body.length;
  if (L <= 1) return true;
  const head = body[L - 1];
  ensure(grid.n);
  // bodyIdx[c] = c 是身体第几节（0 = 尾）；-1 = 非身体
  const bodyIdx = new Int32Array(grid.n).fill(-1);
  for (let k = 0; k < L; k++) bodyIdx[body[k]] = k;
  let qh = 0,
    qt = 0;
  queueBuf[qt++] = head;
  stampBuf[head] = stamp;
  distBuf[head] = 0;
  const nbr = grid.nbr;
  while (qh < qt) {
    const c = queueBuf[qh++];
    const t = distBuf[c] + 1;
    const base = c * 4;
    for (let d = 0; d < 4; d++) {
      const j = nbr[base + d];
      if (j < 0 || stampBuf[j] === stamp) continue;
      const k = bodyIdx[j];
      if (k >= 0) {
        if (k < t) return true; // 到达时该身体节已让开
        continue;
      }
      stampBuf[j] = stamp;
      distBuf[j] = t;
      queueBuf[qt++] = j;
    }
  }
  return false;
}

/**
 * 最长路径（启发式，借鉴 stevennl/Snake）：
 * 1. 先用 BFS 求 start→goal 最短路径；
 * 2. 反复扫描路径上相邻两点 (a,b)，若在其同侧存在两个相邻自由格 (c1,c2) 且均不在路径上，
 *    则把 a→b 扩展为 a→c1→c2→b（路径长度 +2）；
 * 3. 直到无法扩展。结果是一条尽量“铺满”可用空间的简单路径。
 * 严格最长路径是 NP-hard，此法为多项式时间近似，配合追尾策略即可保证安全。
 */
export function longestPath(
  grid: Grid,
  occ: Uint8Array,
  start: number,
  goal: number,
  allowGoalOcc = false,
): number[] | null {
  const path = bfs(grid, occ, start, goal, allowGoalOcc);
  if (!path) return null;
  const inPath = new Uint8Array(grid.n);
  for (const c of path) inPath[c] = 1;
  const nbr = grid.nbr;
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10000) {
    changed = false;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i],
        b = path[i + 1];
      // 找 a→b 的方向
      let dir = -1;
      for (let d = 0; d < 4; d++) if (nbr[a * 4 + d] === b) dir = d;
      if (dir < 0) continue;
      const perps = [(dir + 1) & 3, (dir + 3) & 3];
      for (const p of perps) {
        const c1 = nbr[a * 4 + p];
        const c2 = nbr[b * 4 + p];
        if (c1 < 0 || c2 < 0) continue;
        if (occ[c1] || occ[c2] || inPath[c1] || inPath[c2]) continue;
        path.splice(i + 1, 0, c1, c2);
        inPath[c1] = 1;
        inPath[c2] = 1;
        searchStats.nodes += 2;
        changed = true;
        i += 2;
        break;
      }
    }
  }
  return path;
}
