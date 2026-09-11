import { Grid, generateBlockObstacles, generateObstacles } from './grid';
import { RNG, mixSeed } from './rng';
import { FailReason, FoodItem, ScenarioConfig } from './types';

export const INIT_LENGTH = 3;
const EMPTY_U8 = new Uint8Array(0);

/**
 * 贪吃蛇状态机。
 * 数据结构：
 * - body：环形缓冲区（Int32Array），tailPos..headPos 存储格子索引，O(1) 头尾操作；
 * - occ：Uint8Array 占用位图，O(1) 碰撞判断；
 * - foodAt：Int32Array，格子 -> 食物下标（-1 无），O(1) 判断是否吃到；
 * - visited：覆盖位图，用于“格子覆盖率”统计。
 */
export class Game {
  readonly cfg: ScenarioConfig;
  readonly seed: number;
  readonly grid: Grid;
  readonly occ: Uint8Array;
  readonly visited: Uint8Array;
  visitedCount = 0;
  private buf: Int32Array;
  private cap: number;
  private headPos = 0;
  private tailPos = 0;
  length = 0;
  foods: FoodItem[] = [];
  foodAt: Int32Array;
  steps = 0;
  foodsEaten = 0;
  expiredFoods = 0;
  alive = true;
  won = false;
  failReason: FailReason = 'none';
  stepsSinceFood = 0;
  private foodRng: RNG;
  /** 上一步是否吃到食物（尾巴未移动） */
  grewLastStep = false;
  /** 策略最近一次候选移动（cycleStep 的输出通道；常规策略直接返回值，动态回路策略借道传值） */
  lastCandidate = -1;
  /** 动态障碍预约位（即将变障碍的格子，预告期内视为不可通行；非动态场景恒空） */
  readonly reserved: Uint8Array;
  /** 本局是否含动态障碍（决定预约位/障碍事件逻辑是否启用） */
  readonly dynamic: boolean;

  constructor(cfg: ScenarioConfig, seed: number) {
    this.cfg = cfg;
    this.seed = seed;
    const w = cfg.width,
      h = cfg.height;
    const initCells = [0, 1, 2]; // (0,0) 尾, (1,0), (2,0) 头
    const obsRng = new RNG(mixSeed(seed, 1));
    const blocked =
      cfg.obstacleMode === 'block'
        ? generateBlockObstacles(w, h, cfg.obstacleDensity, obsRng)
        : generateObstacles(w, h, cfg.obstacleDensity, obsRng, initCells);
    this.grid = new Grid(w, h, blocked);
    this.occ = new Uint8Array(this.grid.n);
    this.visited = new Uint8Array(this.grid.n);
    this.foodAt = new Int32Array(this.grid.n).fill(-1);
    this.cap = this.grid.n + 2;
    this.buf = new Int32Array(this.cap);
    this.foodRng = new RNG(mixSeed(seed, 2));
    // 动态障碍场景：食物不可生成在预约位上（否则预告期结束、障碍落地时食物被吞，无法复现）
    this.dynamic = !!(cfg as ScenarioConfig & { dynamicObstacles?: boolean }).dynamicObstacles;
    this.reserved = this.dynamic ? new Uint8Array(this.grid.n) : EMPTY_U8;
    this.initialFreeCount = this.grid.freeCount;
    for (const c of initCells) this.pushHead(c);
    this.spawnFoods();
  }

  get head() {
    return this.buf[(this.headPos - 1 + this.cap) % this.cap];
  }
  get tail() {
    return this.buf[this.tailPos];
  }
  /** 从尾到头的格子序列（仅用于渲染/调试） */
  bodyCells(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.length; i++) out.push(this.buf[(this.tailPos + i) % this.cap]);
    return out;
  }
  /** 尾巴之后的第二节（尾巴移动后的新尾） */
  get secondTail() {
    return this.buf[(this.tailPos + 1) % this.cap];
  }
  get freeCells() {
    return this.grid.freeCount;
  }
  /** 当前预约位数量（动态障碍预告期，O(1) 维护） */
  private _reservedCount = 0;
  get reservedCount(): number {
    return this._reservedCount;
  }
  get targetGrowth() {
    return this.grid.freeCount - INIT_LENGTH;
  }
  get fillRate() {
    return this.targetGrowth <= 0 ? 1 : (this.length - INIT_LENGTH) / this.targetGrowth;
  }
  get coverage() {
    return this.visitedCount / this.grid.freeCount;
  }
  /** 开局自由格数（C 性质的分母锚点，不随对手删格变化） */
  readonly initialFreeCount: number;
  /**
   * 食物到期时，在「障碍 + 预约位 + 当前蛇身」静态快照中仍可从蛇头到达的次数。
   *
   * 这是诊断信号，不是不饿死（liveness）证明：静态可达不代表能在 TTL 内吃到，
   * 当前蛇身暂时阻断也不代表结构性不可达。
   */
  expiredReachableSnapshot = 0;
  /** 食物到期时，在同一静态快照中不可达的次数。 */
  expiredUnreachableSnapshot = 0;
  /** 因障碍落地而被移除的食物数；与自然 TTL 到期分开统计。 */
  foodsRemovedByObstacle = 0;
  /** @deprecated 兼容旧报告字段；请使用 expiredReachableSnapshot。 */
  get nViolations(): number {
    return this.expiredReachableSnapshot;
  }

  /** 新口径 V：visited ∩ 当前自由集 / 当前自由集（≤100%，被障碍覆盖的旧到访格不计入） */
  get coverageCurrent(): number {
    let vis = 0;
    let free = 0;
    for (let c = 0; c < this.grid.n; c++) {
      if (this.grid.blocked[c]) continue;
      free++;
      if (this.visited[c]) vis++;
    }
    return free === 0 ? 1 : vis / free;
  }

  /** 记录食物自然到期时的静态快照可达性（仅作诊断，不作为 N 性质证明）。 */
  private recordExpiryReachability(cell: number): void {
    if (!this.alive) return;
    // 蛇头所在分量 BFS（当前 blocked + occ + reserved 视图）
    const head = this.head;
    const seen = new Uint8Array(this.grid.n);
    const stack = [head];
    seen[head] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === cell) {
        this.expiredReachableSnapshot++;
        return;
      }
      const x = cur % this.grid.w;
      const y = (cur - x) / this.grid.w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= this.grid.w || ny < 0 || ny >= this.grid.h) continue;
        const j = ny * this.grid.w + nx;
        if (seen[j] || this.grid.blocked[j] || this.reserved[j] || this.occ[j]) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    this.expiredUnreachableSnapshot++;
  }

  private pushHead(c: number) {
    this.buf[this.headPos] = c;
    this.headPos = (this.headPos + 1) % this.cap;
    this.length++;
    this.occ[c] = 1;
    if (!this.visited[c]) {
      this.visited[c] = 1;
      this.visitedCount++;
    }
  }
  private popTail() {
    const c = this.buf[this.tailPos];
    this.tailPos = (this.tailPos + 1) % this.cap;
    this.length--;
    this.occ[c] = 0;
  }

  /** 食物生成规则：在“非障碍、非蛇身、非食物、非预约位”的格子中按 seed 驱动的 RNG 均匀抽取 */
  spawnFoods() {
    while (this.foods.length < this.cfg.foodCount) {
      const cand: number[] = [];
      for (let i = 0; i < this.grid.n; i++)
        if (!this.grid.blocked[i] && !this.occ[i] && this.foodAt[i] < 0 && !this.reserved[i]) cand.push(i);
      if (cand.length === 0) break;
      const cell = cand[this.foodRng.int(cand.length)];
      this.foodAt[cell] = this.foods.length;
      this.foods.push({
        cell,
        bornAt: this.steps,
        expiresAt: Number.isFinite(this.cfg.foodTTL) ? this.steps + this.cfg.foodTTL : Infinity,
      });
    }
  }

  /**
   * 动态障碍：宏格落地为障碍。约定调用方保证蛇身不在该宏格上（预告期 + 预约位保证）。
   * 食物恰在该宏格上时移除（结构性不可吃，统计进 expiredFoods）。
   */
  applyBlock(cells: number[]) {
    for (const c of cells) {
      if (this.reserved[c]) this._reservedCount--;
      this.reserved[c] = 0;
      const fi = this.foodAt[c];
      if (fi >= 0) {
        this.removeFood(fi);
        this.expiredFoods++;
        // 障碍删除食物不是 TTL 到期，不能混入快照可达性统计。
        this.foodsRemovedByObstacle++;
      }
      this.grid.blocked[c] = 1;
    }
    this.grid.rebuildNeighbors();
  }

  /** 动态障碍：宏格恢复为可通行（清除预约位） */
  applyUnblock(cells: number[]) {
    for (const c of cells) {
      this.grid.blocked[c] = 0;
      if (this.reserved[c]) this._reservedCount--;
      this.reserved[c] = 0;
    }
    this.grid.rebuildNeighbors();
  }

  /** 标记单个预约位（预告期内不可通行；统一入口，维护 _reservedCount） */
  reserveCell(c: number) {
    if (!this.reserved[c]) {
      this.reserved[c] = 1;
      this._reservedCount++;
    }
  }

  /** 清除单个预约位 */
  unreserveCell(c: number) {
    if (this.reserved[c]) {
      this.reserved[c] = 0;
      this._reservedCount--;
    }
  }

  private removeFood(i: number) {
    const f = this.foods[i];
    this.foodAt[f.cell] = -1;
    this.foods.splice(i, 1);
    for (let k = i; k < this.foods.length; k++) this.foodAt[this.foods[k].cell] = k;
  }

  /** 执行一步：next 为蛇头将进入的格子（-1 表示策略放弃） */
  step(next: number) {
    if (!this.alive || this.won) return;
    if (!Number.isInteger(next) || next < 0 || next >= this.grid.n) {
      this.die('no-move');
      return;
    }
    this.steps++;
    if (next < 0) return this.die('no-move');
    const head = this.head;
    const hx = this.grid.x(head),
      hy = this.grid.y(head);
    const nx = this.grid.x(next),
      ny = this.grid.y(next);
    if (Math.abs(nx - hx) + Math.abs(ny - hy) !== 1) return this.die('no-move');
    if (this.grid.blocked[next] || this.reserved[next]) return this.die('obstacle');
    const fi = this.foodAt[next];
    const eating = fi >= 0;
    if (this.occ[next] && !(next === this.tail && !eating && this.length > 1)) return this.die('self');

    if (eating) {
      this.removeFood(fi);
      this.foodsEaten++;
      this.stepsSinceFood = 0;
      this.grewLastStep = true;
    } else {
      this.popTail();
      this.stepsSinceFood++;
      this.grewLastStep = false;
    }
    this.pushHead(next);

    // 食物过期
    for (let i = this.foods.length - 1; i >= 0; i--) {
      if (this.foods[i].expiresAt <= this.steps) {
        this.recordExpiryReachability(this.foods[i].cell);
        this.removeFood(i);
        this.expiredFoods++;
      }
    }
    if (this.length >= this.grid.freeCount) {
      this.won = true;
      return;
    }
    this.spawnFoods();
    if (this.foods.length === 0 && this.length >= this.grid.freeCount) this.won = true;
  }

  private die(reason: FailReason) {
    this.alive = false;
    this.failReason = reason;
  }
  /** 外部（模拟器）判定的失败 */
  fail(reason: FailReason) {
    this.die(reason);
  }
}
