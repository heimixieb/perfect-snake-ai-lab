/** 可复现的伪随机数生成器（mulberry32）。所有随机行为（障碍、食物）均由 seed 决定。 */
export class RNG {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** [0,1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** 整数 [0, n) */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** 把字符串/数字混合成 32 位种子 */
export function mixSeed(base: number, salt: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (salt + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
