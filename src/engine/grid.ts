import { RNG } from './rng';
import { DX, DY } from './types';

/**
 * 地图：格子用一维索引 idx = y*W + x 表示。
 * blocked[idx] = 1 表示固定障碍。
 */
export class Grid {
  readonly w: number;
  readonly h: number;
  readonly n: number;
  readonly blocked: Uint8Array;
  /** 每个格子的 4 邻接（-1 表示越界或障碍），预处理一次以加速所有搜索 */
  readonly nbr: Int32Array;
  freeCount = 0;

  constructor(w: number, h: number, blocked?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.blocked = blocked ?? new Uint8Array(this.n);
    this.nbr = new Int32Array(this.n * 4);
    this.rebuildNeighbors();
  }

  rebuildNeighbors() {
    this.freeCount = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.blocked[i]) this.freeCount++;
      const x = i % this.w;
      const y = (i / this.w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        let v = -1;
        if (nx >= 0 && ny >= 0 && nx < this.w && ny < this.h) {
          const j = ny * this.w + nx;
          if (!this.blocked[j]) v = j;
        }
        this.nbr[i * 4 + d] = v;
      }
    }
  }

  idx(x: number, y: number) {
    return y * this.w + x;
  }
  x(i: number) {
    return i % this.w;
  }
  y(i: number) {
    return (i / this.w) | 0;
  }
  inBounds(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  /** 自由邻居数量（不含障碍/越界） */
  degree(i: number) {
    let c = 0;
    for (let d = 0; d < 4; d++) if (this.nbr[i * 4 + d] >= 0) c++;
    return c;
  }
}

/** 从 start 出发洪水填充，返回可达自由格数量（blocked 视为不可通行） */
function reachableCount(blocked: Uint8Array, w: number, h: number, start: number): number {
  const seen = new Uint8Array(w * h);
  const q: number[] = [start];
  seen[start] = 1;
  let c = 0;
  while (q.length) {
    const i = q.pop()!;
    c++;
    const x = i % w;
    const y = (i / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (blocked[j] || seen[j]) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return c;
}

function freeDegree(blocked: Uint8Array, w: number, h: number, i: number) {
  const x = i % w;
  const y = (i / w) | 0;
  let c = 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    if (!blocked[ny * w + nx]) c++;
  }
  return c;
}

/**
 * 受规则约束的随机障碍生成算法（可复现）：
 * 1. 使用 seed 驱动的 RNG 依次随机抽取候选格；
 * 2. 保护区：蛇的初始区域（左上 3×1 + 周边一圈）不放障碍；
 * 3. 拒绝规则 A：放置后任一自由格的自由邻居数 < 2（避免产生死胡同——蛇无法倒退，死胡同意味着必然无法覆盖）；
 * 4. 拒绝规则 B：放置后自由区域不连通；
 * 5. 直到达到 density×N 个障碍或候选耗尽（最多尝试 20×目标数）。
 * 由于规则拒绝了死胡同与孤岛，“覆盖全部可通行格”在理论上仍有可能。
 */
/**
 * 宏格（2×2 对齐）障碍生成算法（可复现）：
 * - 地图边长须为偶数；宏格坐标 (mx,my) 对应格子 (2mx..2mx+1, 2my..2my+1)；
 * - 保护宏格 (0,0)、(1,0)（蛇初始位置）；
 * - 以 seed 驱动的 RNG 抽取宏格，放置后要求宏格图仍连通，否则拒绝；
 * - 目标数量 = round(density × 宏格总数)（等价于格子密度 ≈ density）。
 * 由于宏格图连通且每个宏格是 2×2 方块，“宏格生成树 → 哈密顿回路”构造总能成立。
 */
export function generateBlockObstacles(w: number, h: number, density: number, rng: RNG): Uint8Array {
  const n = w * h;
  const blocked = new Uint8Array(n);
  if (w % 2 !== 0 || h % 2 !== 0) return generateObstacles(w, h, density, rng, [0, 1, 2]);
  const mw = w / 2,
    mh = h / 2;
  const mblocked = new Uint8Array(mw * mh);
  const target = Math.round(density * mw * mh);
  let placed = 0,
    attempts = 0;
  while (placed < target && attempts < target * 20) {
    attempts++;
    const m = rng.int(mw * mh);
    if (mblocked[m] || m === 0 || m === 1) continue;
    mblocked[m] = 1;
    if (reachableCount(mblocked, mw, mh, 0) !== mw * mh - placed - 1) {
      mblocked[m] = 0;
      continue;
    }
    placed++;
  }
  for (let my = 0; my < mh; my++)
    for (let mx = 0; mx < mw; mx++)
      if (mblocked[my * mw + mx]) {
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) blocked[(2 * my + dy) * w + 2 * mx + dx] = 1;
      }
  return blocked;
}

export function generateObstacles(
  w: number,
  h: number,
  density: number,
  rng: RNG,
  protectedCells: number[],
): Uint8Array {
  const n = w * h;
  const blocked = new Uint8Array(n);
  const target = Math.round(density * n);
  if (target <= 0) return blocked;
  const prot = new Uint8Array(n);
  for (const c of protectedCells) {
    prot[c] = 1;
    const x = c % w;
    const y = (c / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx,
          ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) prot[ny * w + nx] = 1;
      }
  }
  let placed = 0;
  let attempts = 0;
  const maxAttempts = target * 20;
  while (placed < target && attempts < maxAttempts) {
    attempts++;
    const c = rng.int(n);
    if (blocked[c] || prot[c]) continue;
    blocked[c] = 1;
    // 规则 A：所有自由格度数 >= 2（只需检查邻域即可，但为简洁检查邻居）
    let ok = true;
    const x = c % w;
    const y = (c / w) | 0;
    for (let d = 0; d < 4 && ok; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!blocked[j] && freeDegree(blocked, w, h, j) < 2) ok = false;
    }
    // 规则 B：连通性
    if (ok) {
      const start = protectedCells[0];
      const reach = reachableCount(blocked, w, h, start);
      if (reach !== n - placed - 1) ok = false;
    }
    if (!ok) {
      blocked[c] = 0;
      continue;
    }
    placed++;
  }
  return blocked;
}
