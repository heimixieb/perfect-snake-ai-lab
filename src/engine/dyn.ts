/**
 * 动态障碍下的可维护哈密顿回路（极限难度 extreme-dyn）。
 *
 * 表示：回路 = 提交支持集上的 2-正则连通环，{next, prev} 双向映射，所有链接均为网格相邻格。
 *
 * 经典维护路径在宏格预约、落地和解除时执行 O(N) 生成树全量重建。新回路先写入候选数组，
 * 完成唯一性、邻接、单环与蛇身单调弧检查后才原子提交；失败保留旧状态。
 * 可选的 TwoFactorCycle 实验引擎在另一个模块中探索局部增广修复，不改变本类的事务语义。
 */
import { Game } from './game';
import { RNG, mixSeed } from './rng';

/** 宏格左上角格子索引 */
function macroTL(w: number, mw: number, m: number): number {
  const mx = m % mw;
  const my = (m - (m % mw)) / mw;
  return 2 * my * w + 2 * mx;
}

export class DynamicCycle {
  readonly w: number;
  readonly mw: number;
  readonly mh: number;
  next: Int32Array;
  prev: Int32Array;
  idx: Int32Array;
  cells: Int32Array;
  N = 0;
  /** 每宏格已张开侧位掩码（bit0..3 = 上右下左） */
  opened: Uint8Array;
  macroBlocked: Uint8Array;
  /** 累计重编号 walk 次数（确定性性能指标，供降级判定） */
  walkCount = 0;
  /** 全量重建回调：对当前 grid 跑生成树回路构造，返回新回路序（null = 失败）。由策略注入。 */
  rebuildFn: (() => number[] | null) | null = null;
  /** 单调弧校验回调：新回路序上蛇身是否仍是尾→头单调弧（蛇身格集合由闭包捕获）。 */
  monoArcChecker: ((order: number[]) => boolean) | null = null;

  /** 累计回滚次数（观测/故障注入验证用） */
  rollbackCount = 0;

  constructor(game: Game) {
    this.w = game.grid.w;
    this.mw = this.w / 2;
    this.mh = game.grid.h / 2;
    const n = game.grid.n;
    this.next = new Int32Array(n).fill(-1);
    this.prev = new Int32Array(n).fill(-1);
    this.idx = new Int32Array(n).fill(-1);
    this.cells = new Int32Array(n);
    this.opened = new Uint8Array(this.mw * this.mh);
    this.macroBlocked = new Uint8Array(this.mw * this.mh);
    for (let m = 0; m < this.mw * this.mh; m++) {
      const a = macroTL(this.w, this.mw, m);
      if (game.grid.blocked[a]) this.macroBlocked[m] = 1;
    }
  }
  /**
   * 结构校验器：2-正则、单环、网格相邻、cells/idx/next/prev 互相一致。
   * expectedSupport 可选；传入时还会逐格验证回路支持集完全相等。
   */
  verifyStructure(expectedN: number, expectedSupport?: Uint8Array): string | null {
    if (!Number.isInteger(expectedN) || expectedN <= 0 || expectedN > this.next.length) {
      return `非法期望长度 ${expectedN}`;
    }
    if (expectedSupport && expectedSupport.length !== this.next.length) return '支持集长度不匹配';
    // 1) 单环：从任一链接格沿 next 走一圈
    let start = -1;
    for (let c = 0; c < this.next.length; c++) {
      if (this.next[c] >= 0) {
        start = c;
        break;
      }
    }
    if (start < 0) return '无链接格';
    let c = start;
    let count = 0;
    const seen = new Uint8Array(this.next.length);
    do {
      if (c < 0 || c >= this.next.length) return `后继越界 ${c}`;
      if (seen[c]) return `提前重复格 ${c}`;
      seen[c] = 1;
      const nx = this.next[c];
      if (nx < 0 || nx >= this.next.length) return `格 ${c} 后继越界 ${nx}`;
      // 2) 链接网格相邻
      const dx = Math.abs((c % this.w) - (nx % this.w));
      const dy = Math.abs(((c / this.w) | 0) - ((nx / this.w) | 0));
      if (dx + dy !== 1) return `传送边 ${c}→${nx}`;
      if (this.prev[nx] !== c) return `prev 不一致 ${nx}`;
      count++;
      if (count > expectedN) return '环过长或未回到起点';
      c = nx;
    } while (c !== start);
    // 3) 覆盖与字段一致性：不能存在环外链接、悬空 prev/idx 或错误序号。
    let linked = 0;
    for (let x = 0; x < this.next.length; x++) {
      const hasNext = this.next[x] >= 0;
      const hasPrev = this.prev[x] >= 0;
      const hasIdx = this.idx[x] >= 0;
      if (hasNext !== hasPrev || hasNext !== hasIdx) return `格 ${x} 链接字段不完整`;
      if (expectedSupport && hasNext !== (expectedSupport[x] === 1)) return `支持集不一致 ${x}`;
      if (hasNext) {
        linked++;
        if (!seen[x]) return `格 ${x} 在环外（第二环）`;
        const pos = this.idx[x];
        if (pos < 0 || pos >= expectedN) return `格 ${x} 序号越界 ${pos}`;
        if (this.cells[pos] !== x) return `cells/idx 不互逆 ${x}`;
      }
    }
    if (count !== expectedN || linked !== expectedN) return `覆盖 ${count}/${expectedN}`;
    if (this.cells.length < expectedN) return `cells 长度 ${this.cells.length} < ${expectedN}`;
    for (let i = 0; i < expectedN; i++) {
      const x = this.cells[i];
      if (x < 0 || x >= this.next.length) return `cells[${i}] 越界 ${x}`;
      if (this.idx[x] !== i) return `序号错乱 cells[${i}]=${x}, idx=${this.idx[x]}`;
      if (this.next[x] !== this.cells[(i + 1) % expectedN]) return `idx 与 next 不一致 ${x}`;
      if (this.prev[x] !== this.cells[(i - 1 + expectedN) % expectedN]) return `idx 与 prev 不一致 ${x}`;
    }
    return null;
  }

  /** 用初始回路序初始化链接并推导 opened 掩码 */
  init(order: number[]): boolean {
    const candidate = this.makeCandidate(order);
    if (!candidate) return false;
    this.commitCandidate(candidate);
    this.walkCount++;
    return true;
  }

  private makeCandidate(order: number[]): {
    N: number;
    cells: Int32Array;
    idx: Int32Array;
    next: Int32Array;
    prev: Int32Array;
    opened: Uint8Array;
    macroBlocked: Uint8Array;
  } | null {
    const N = order.length;
    if (N <= 0 || N > this.next.length) return null;
    const cells = Int32Array.from(order);
    const idx = new Int32Array(this.next.length).fill(-1);
    const next = new Int32Array(this.next.length).fill(-1);
    const prev = new Int32Array(this.next.length).fill(-1);
    for (let i = 0; i < N; i++) {
      const c = order[i];
      const nx = order[(i + 1) % N];
      if (!Number.isInteger(c) || c < 0 || c >= this.next.length || idx[c] >= 0) return null;
      const dx = Math.abs((c % this.w) - (nx % this.w));
      const dy = Math.abs(((c / this.w) | 0) - ((nx / this.w) | 0));
      if (dx + dy !== 1) return null;
      idx[c] = i;
      next[c] = nx;
      prev[c] = order[(i - 1 + N) % N];
    }
    const opened = new Uint8Array(this.mw * this.mh);
    const macroBlocked = new Uint8Array(this.mw * this.mh);
    // 推导 opened：环向序对 (u,v)，若 next[u]===v 或 next[v]===u 则该侧闭合。
    for (let m = 0; m < this.mw * this.mh; m++) {
      const a = macroTL(this.w, this.mw, m);
      macroBlocked[m] = idx[a] < 0 ? 1 : 0;
      if (macroBlocked[m]) continue;
      let mask = 0;
      for (let s = 0; s < 4; s++) {
        const [u, v] = this.sideCells(m, s);
        if (next[u] !== v && next[v] !== u) mask |= 1 << s;
      }
      opened[m] = mask;
    }
    return { N, cells, idx, next, prev, opened, macroBlocked };
  }

  private commitCandidate(candidate: NonNullable<ReturnType<DynamicCycle['makeCandidate']>>): void {
    this.N = candidate.N;
    this.cells = candidate.cells;
    this.idx = candidate.idx;
    this.next = candidate.next;
    this.prev = candidate.prev;
    this.opened = candidate.opened;
    this.macroBlocked = candidate.macroBlocked;
  }

  /** 宏格 m 的 side 侧两格（环向序对 u→v） */
  private sideCells(m: number, side: number): [number, number] {
    const a = macroTL(this.w, this.mw, m);
    switch (side) {
      case 0: return [a, a + 1]; // 上: a→b
      case 1: return [a + 1, a + 1 + this.w]; // 右: b→d
      case 2: return [a + 1 + this.w, a + this.w]; // 下: d→c
      default: return [a + this.w, a]; // 左: c→a
    }
  }

  /**
   * 摘除宏格 m（调用方提供目标 grid/预约视图）：全量重建回路（O(N)）。
   * 为何不用 O(1) 段折叠：2×2 宏格被环穿越的段，其两端外侧格在 4-邻接下必不相邻
   * （直边穿 1 格 → 两端列差 3；对角穿 2 格 → 对角），直连必产生传送边（实测多次）。
   * 具体耗时由运行环境决定；正确性由候选校验与 verifyStructure 把关。
   */
  removeBlock(m: number, isSnakeCell: (c: number) => boolean): boolean {
    const cells = this.macroCellListOf(m);
    for (const c of cells) if (isSnakeCell(c)) return false;
    return this.rebuildCore(isSnakeCell);
  }

  insertBlock(m: number, isSnakeCell: (c: number) => boolean): boolean {
    const cells = this.macroCellListOf(m);
    for (const c of cells) if (isSnakeCell(c)) return false;
    return this.rebuildCore(isSnakeCell);
  }

  private macroCellListOf(m: number): number[] {
    const a = macroTL(this.w, this.mw, m);
    return [a, a + 1, a + this.w, a + this.w + 1];
  }

  /** 全量重建：经 rebuildFn 对当前 grid 跑生成树回路；失败返回 false（调用方回滚）。
   *  蛇身约束：新回路上蛇身必须仍是尾→头单调弧（monoArcChecker 校验，不满足即拒绝重建）。
   */
  private rebuildCore(_isSnakeCell: (c: number) => boolean): boolean {
    if (!this.rebuildFn) return false;
    const order = this.rebuildFn();
    if (!order || order.length === 0) return false;
    if (this.monoArcChecker && !this.monoArcChecker(order)) {
      this.rollbackCount++;
      return false;
    }
    // 先在候选数组上完成全部校验，再一次性替换正式状态；失败不会污染旧回路。
    const candidate = this.makeCandidate(order);
    if (!candidate) {
      this.rollbackCount++;
      return false;
    }
    this.commitCandidate(candidate);
    this.walkCount++;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 降级控制器（双判据）                                                 */
/* ------------------------------------------------------------------ */
export type DegradeReason = 'none' | 'walks' | 'wall' | 'anomaly' | 'forced';

export class DegradeController {
  readonly budgetMs: number;
  readonly windowSize: number;
  /** 判据 A（确定性，主判据）：窗口内「单步最大 walk 数」超过 budgetWalks 的步数占比超阈即降级。
   * walk 语义：一次缝合操作（removeBlock/insertBlock）= 1 次重编号 walk，合法事件步为 1–4 次；
   * 失败重试风暴会让单步 walk 显著超限（实测 insertBlock 重试单步可达 6+ 且每 5 步复发）。
   * 墙钟受机器负载抖动影响会导致同 seed 不可复现（实测），故主判据用操作数。 */
  readonly budgetWalks: number;
  /** 判据 B（实时性保险丝）：窗口 p99 墙钟 > wallBudgetMs 即降级（默认 5×budget、下限 5ms）。 */
  readonly wallBudgetMs: number;
  /** 判据 A 的触发占比阈值：窗口内超限步 ≥ 该比例即降级（默认 20%） */
  readonly spikeRatio: number;
  degraded = false;
  degradeStep = -1;
  reason: DegradeReason = 'none';
  /** 墙钟判据的连续超标窗口计数（去抖：连续 2 窗口才降级） */
  private wallOverStreak = 0;
  /** 自上次墙钟窗口判定后新增的样本数；墙钟只比较互不重叠的完整窗口。 */
  private wallSamplesSinceCheck = 0;
  private walks: number[] = [];
  private wall: number[] = [];

  constructor(budgetMs: number, windowSize = 50, budgetWalks = 6, spikeRatio = 0.2) {
    this.budgetMs = budgetMs;
    this.windowSize = windowSize;
    this.budgetWalks = budgetWalks;
    this.spikeRatio = spikeRatio;
    this.wallBudgetMs = Math.max(budgetMs * 5, 5);
  }
  sample(ms: number, walks = 0) {
    if (this.degraded) {
      // 恢复使用连续干净样本，而不是“降级以来从未出现过 spike”的永久锁死条件。
      if (walks <= this.budgetWalks / 2) this.recoveryCleanSteps++;
      else this.recoveryCleanSteps = 0;
      return;
    }
    this.wall.push(ms);
    if (this.wall.length > this.windowSize) this.wall.shift();
    this.wallSamplesSinceCheck++;
    this.walks.push(walks);
    if (this.walks.length > this.windowSize) this.walks.shift();
  }
  private static p99(arr: number[]): number {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
  }
  /** 每步决策后调用；step 为当前游戏步数（记录降级时刻） */
  check(step: number): boolean {
    if (this.degraded) return true;
    if (this.walks.length < this.windowSize) return false;
    const spikes = this.walks.filter((w) => w > this.budgetWalks).length;
    if (spikes > this.spikeRatio * this.windowSize) return this.trip('walks', step);
    // 只在收满一个新的、互不重叠的窗口后更新墙钟连续超标计数。
    // 这样一个尖峰不会因为仍留在滑动窗口里而被重复计算两次。
    if (this.wallSamplesSinceCheck >= this.windowSize) {
      this.wallSamplesSinceCheck = 0;
      if (DegradeController.p99(this.wall) > this.wallBudgetMs) {
        this.wallOverStreak++;
        if (this.wallOverStreak >= 2) return this.trip('wall', step);
        return false;
      }
      this.wallOverStreak = 0;
    }
    return false;
  }
  private trip(r: DegradeReason, step: number): boolean {
    this.degraded = true;
    this.reason = r;
    this.degradeStep = step;
    this.recoveryCleanSteps = 0;
    return true;
  }
  /** 外部强制降级（拓扑连续异常 / 验收自检） */
  force(reason: DegradeReason, step: number) {
    if (!this.degraded) {
      this.degraded = true;
      this.reason = reason;
      this.degradeStep = step;
      this.recoveryCleanSteps = 0;
    }
  }
  /**
   * 滞回恢复（d-4）：降级后若连续 recoverySteps 个样本的确定性判据（walks）
   * 全部低于预算的 1/2，则恢复捷径——防止长对抗局永久禁捷径把步数推到饥饿阈值附近。
   * 墙钟不参与恢复判定（不可复现）。恢复后 re-degrade 仍可能发生（滞回对称）。
   */
  tryRecover(_step: number): boolean {
    if (!this.degraded || this.reason === 'anomaly' || this.reason === 'forced') return false;
    // 滞回：连续 recoverySteps 个样本低于 walk 预算的一半后恢复。
    if (this.recoveryCleanSteps >= this.recoverySteps) {
      this.degraded = false;
      this.reason = 'none';
      this.degradeStep = -1;
      this.walks = [];
      this.wall = [];
      this.wallOverStreak = 0;
      this.wallSamplesSinceCheck = 0;
      this.recoveryCleanSteps = 0;
      this.recovered = true;
      return true;
    }
    return false;
  }
  /** 降级后需保持的恢复步数（滞回带宽度） */
  readonly recoverySteps = 200;
  /** 恢复观察期内连续低负载样本数。 */
  recoveryCleanSteps = 0;
  /** 是否发生过恢复（观测用） */
  recovered = false;
  /** 恢复后仍需记录 spike：sample 在非 degraded 时正常工作，恢复后自动重新累积 */
  /** 窗口内墙钟 p99（观测用） */
  get wallP99(): number {
    return DegradeController.p99(this.wall);
  }
}

/* ------------------------------------------------------------------ */
/* 动态障碍调度器（策略每步 tick；block 预约→落地，unblock 立即生效）     */
/* ------------------------------------------------------------------ */
export interface SchedulerStats {
  sampledCandidates: number;
  environmentRejects: number;
  fairnessRejects: number;
  strategyRejects: number;
  reservations: number;
  gridTouches: number;
  committedEvents: number;
  landRollbacks: number;
  bodyConflicts: number;
  unblockRetries: number;
  unblockAbandons: number;
}

export class DynScheduler {
  private pending: Array<{ atStep: number; kind: 'block' | 'unblock'; macro: number; cells: number[]; tries: number; backoff: number }> = [];
  private rng: RNG;
  /** 预约回调：策略把宏格从回路拆除；false = 拒绝预约 */
  onReserve: (macro: number) => boolean = () => true;
  /** 解除回调：策略把宏格缝回回路；false = 推迟重试（保持障碍，直到缝回成功才恢复通行） */
  onUnblock: (macro: number) => boolean = () => true;
  /** block 正式落地后回调（grid 已更新）：策略重建回路对齐；false = 回滚 grid 放弃事件 */
  onBlocked: (macro: number) => boolean = () => true;
  /** unblock 正式落地后回调（grid 已自由）：策略重建回路对齐 */
  onUnblocked: (macro: number) => boolean = () => true;

  /** 事件落地计数：grid 拓扑每被 applyBlock/applyUnblock 触碰一次即 +1（含落地后回滚）。
   *  纯观测计数器，零行为影响；影子断言自适应频率据此在「落地后 1 步」必断言——
   *  重建提交后的第一步是拓扑最脆弱时刻，断言价值最高。 */
  landSeq = 0;
  readonly stats: SchedulerStats = {
    sampledCandidates: 0,
    environmentRejects: 0,
    fairnessRejects: 0,
    strategyRejects: 0,
    reservations: 0,
    gridTouches: 0,
    committedEvents: 0,
    landRollbacks: 0,
    bodyConflicts: 0,
    unblockRetries: 0,
    unblockAbandons: 0,
  };

  /** A2-like 过滤档：启用近头候选与公平性检查；策略拒绝会被 stats 显式记录。 */
  readonly forceLand: boolean;
  constructor(
    private game: Game,
    seed: number,
    private dynCount: number,
    private period: number,
    private notice: number,
  ) {
    this.rng = new RNG(mixSeed(seed, 7));
    this.forceLand = !!(game.cfg as { forceLand?: boolean }).forceLand;
  }

  tick(): void {
    const g = this.game;
    // 到期事件
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      if (g.steps < e.atStep) continue;
      if (e.kind === 'block') {
        // 预约位保证蛇身不会进入；若已在其上（理论不可能）则丢弃事件
        if (e.cells.some((c) => g.occ[c])) {
          this.stats.bodyConflicts++;
          for (const c of e.cells) g.unreserveCell(c);
          this.pending.splice(i, 1);
          if (this.forceLand) g.fail('maintenance');
          continue;
        }
        // 时序：applyBlock（grid 更新）→ onBlocked 重排回路 → 失败则回滚 grid 放弃事件
        g.applyBlock(e.cells);
        this.landSeq++;
        this.stats.gridTouches++;
        if (!this.onBlocked(e.macro)) {
          this.stats.landRollbacks++;
          g.applyUnblock(e.cells);
          this.landSeq++;
          this.stats.gridTouches++;
          // block 前的预排已把宏格移出回路；grid 回滚后必须把回路也恢复到完整支持集。
          if (!this.onUnblocked(e.macro)) g.fail('maintenance');
          this.pending.splice(i, 1);
          continue;
        }
        this.stats.committedEvents++;
      } else {
        // unblock 时序：onUnblock 预排（grid 未变，重建包含将恢复的宏格）→ applyUnblock → onUnblocked 对齐
        e.tries++;
        if (!this.onUnblock(e.macro)) {
          this.stats.unblockRetries++;
          if (e.tries > 8) {
            this.stats.unblockAbandons++;
            for (const c of e.cells) g.unreserveCell(c);
            this.pending.splice(i, 1);
            continue;
          }
          e.backoff = Math.min(e.backoff * 2, 320);
          e.atStep = g.steps + e.backoff;
          continue;
        }
        g.applyUnblock(e.cells);
        this.landSeq++;
        this.stats.gridTouches++;
        if (!this.onUnblocked(e.macro)) {
          // 正式对齐失败：恢复 grid，并把回路恢复到旧的 blocked 视图；事件保留以便重试。
          this.stats.landRollbacks++;
          g.applyBlock(e.cells);
          this.landSeq++;
          this.stats.gridTouches++;
          if (!this.onBlocked(e.macro)) g.fail('maintenance');
          e.backoff = Math.min(e.backoff * 2, 320);
          e.atStep = g.steps + e.backoff;
          continue;
        }
        this.stats.committedEvents++;
      }
      this.pending.splice(i, 1);
    }
    // 周期性新事件：偶数位 block（带预约），奇数位 unblock
    if (g.steps > 0 && g.steps % this.period === 0) {
      const k = Math.max(1, Math.floor(this.dynCount));
      for (let j = 0; j < k; j++) {
        if (j % 2 === 0) this.tryNewBlock();
        else this.tryNewUnblock();
      }
    }
  }

  private tryNewBlock(): void {
    const g = this.game;
    const mw = this.mwOf();
    // 候选先按「距蛇头曼哈顿距离 ≥ 8」预筛：距离过近的宏格拆除后极易因蛇身弧位置被
    // monoArcChecker/连通性拒绝——每次拒绝都是一次完整 O(N) 重建（实测 31 次 × 0.35ms = 11ms）。
    // 预筛是 O(1)/候选，把昂贵的重建留给高概率成功的候选。
    const head = g.head;
    const hx = g.grid.x(head),
      hy = g.grid.y(head);
    // 昂贵尝试预算：onReserve 失败 = 一次完整 O(N) 重建（~0.3ms），32 次全试可能 10ms+
    // 远超 2ms 预算。限制每周期最多 3 次重建尝试，超限放弃本周期（下个周期再试）。
    let expensiveTries = 0;
    const MAX_EXPENSIVE = 3;
    // 割点预筛（O(宏格数) BFS，远便宜于 O(N) 重建）：拆除后自由宏格图不连通的宏格
    // 必然被生成树法拒绝（rebuildFn 返回 null）——实测全部 28 次失败皆源于此。
    // 宏格图邻接在 mw×mh 网格上，BFS 判「去掉 m 后起点所在连通分量 = 总自由宏格数」。
    const freeMacroTotal = (() => {
      let n = 0;
      for (let mm = 0; mm < mw * (g.grid.h / 2); mm++) {
        const a = macroTL(g.grid.w, mw, mm);
        if (!g.grid.blocked[a]) n++;
      }
      return n;
    })();
    const isCutVertex = (m: number): boolean => {
      // 从任意一个非 m 的自由宏格 BFS，若可达数 < 自由宏格总数 − 1 则 m 是割点
      const mh = g.grid.h / 2;
      let start = -1;
      for (let mm = 0; mm < mw * mh && start < 0; mm++) {
        if (mm === m) continue;
        const a = macroTL(g.grid.w, mw, mm);
        if (!g.grid.blocked[a]) start = mm;
      }
      if (start < 0) return true; // 无其他自由宏格，拆了图就空
      const seen = new Uint8Array(mw * mh);
      const queue = [start];
      seen[start] = 1;
      let reach = 1;
      while (queue.length) {
        const cur = queue.pop()!;
        const cmx = cur % mw;
        const cmy = (cur / mw) | 0;
        for (let d = 0; d < 4; d++) {
          const nx = cmx + (d === 1 ? 1 : d === 3 ? -1 : 0);
          const ny = cmy + (d === 2 ? 1 : d === 0 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
          const nm = ny * mw + nx;
          if (nm === m || seen[nm]) continue;
          const na = macroTL(g.grid.w, mw, nm);
          if (g.grid.blocked[na]) continue;
          seen[nm] = 1;
          reach++;
          queue.push(nm);
        }
      }
      return reach < freeMacroTotal - 1;
    };
    for (let tries = 0; tries < 32 && expensiveTries < MAX_EXPENSIVE; tries++) {
      const m = this.rng.int(mw * (g.grid.h / 2));
      this.stats.sampledCandidates++;
      if (this.macroIsBlockedOrReserved(m)) { this.stats.environmentRejects++; continue; }
      const cells = this.macroCellList(m);
      if (cells.some((c) => g.grid.blocked[c] || g.occ[c] || g.foodAt[c] >= 0 || g.reserved[c])) {
        this.stats.environmentRejects++;
        continue;
      }
      const cx = cells.reduce((s, c) => s + g.grid.x(c), 0) / 4;
      const cy = cells.reduce((s, c) => s + g.grid.y(c), 0) / 4;
      const nearHead = Math.abs(hx - cx) + Math.abs(hy - cy) < 8;
      // A1 档（可拒绝候选）：距蛇头过近或割点 → 跳过（零重建成本）
      if (!this.forceLand) {
        if (nearHead) { this.stats.environmentRejects++; continue; }
        if (isCutVertex(m)) { this.stats.environmentRejects++; continue; }
      } else {
        // A2-like 档：允许近头候选，并在交给维护器前检查公平性三条件：
        // ① 预约集不得覆盖蛇头现阶段全部合法后继（逃逸集非空且 ≥ 2）
        // ② 预告期 T ≥ 2（构造保证 notice=15）
        // ③ 落地后自由区保持连通（isCutVertex 在宏格粒度检查；连通即接受）
        if (nearHead) {
          // 距离 <8 时逐格检查条件①：蛇头合法后继（非障碍/非预约/非蛇身）至少 2 个在预约后仍可用
          let escape = 0;
          const baseH = head * 4;
          for (let d = 0; d < 4; d++) {
            const c = g.grid.nbr[baseH + d];
            if (c < 0 || g.occ[c] || g.grid.blocked[c]) continue;
            if (cells.includes(c)) continue; // 预约会覆盖它
            if (g.reserved[c]) continue;
            escape++;
          }
          if (escape < 2) { this.stats.fairnessRejects++; continue; }
        }
        if (isCutVertex(m)) { this.stats.fairnessRejects++; continue; }
      }
      expensiveTries++;
      if (!this.onReserve(m)) { this.stats.strategyRejects++; continue; }
      for (const c of cells) g.reserveCell(c);
      this.pending.push({ atStep: g.steps + this.notice, kind: 'block', macro: m, cells, tries: 0, backoff: 5 });
      this.stats.reservations++;
      return;
    }
  }

  private tryNewUnblock(): void {
    const g = this.game;
    const mw = this.mwOf();
    for (let tries = 0; tries < 32; tries++) {
      const m = this.rng.int(mw * (this.game.grid.h / 2));
      const cells = this.macroCellList(m);
      if (!cells.every((c) => g.grid.blocked[c])) continue;
      if (this.pending.some((e) => e.macro === m)) continue;
      this.pending.push({ atStep: g.steps, kind: 'unblock', macro: m, cells, tries: 0, backoff: 5 });
      return;
    }
  }

  private mwOf(): number {
    return this.game.grid.w / 2;
  }
  private macroCellList(m: number): number[] {
    const a = macroTL(this.game.grid.w, this.mwOf(), m);
    return [a, a + 1, a + this.game.grid.w, a + this.game.grid.w + 1];
  }
  private macroIsBlockedOrReserved(m: number): boolean {
    return this.macroCellList(m).some((c) => this.game.grid.blocked[c] || this.game.reserved[c]);
  }

  clearPending(): void {
    for (const e of this.pending) if (e.kind === 'block') for (const c of e.cells) this.game.unreserveCell(c);
    this.pending = [];
  }
  get pendingCount(): number {
    return this.pending.length;
  }
}
