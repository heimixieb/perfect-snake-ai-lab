/**
 * 动态障碍下的可维护哈密顿回路（极限难度 extreme-dyn）。
 *
 * 表示：回路 = 自由格上的 2-正则连通环，{next, prev} 双向映射，所有链接都是网格相邻格。
 * 宏格（2×2）内部 4 格构成小环 a→b→d→c→a；树边 = 打开两宏格相对的环边并交叉连接（叶子公司）。
 *
 * 动态维护的关键性质：所有拼接都在「同一宏格的同一侧」内进行，拼接两端必然网格相邻，
 * 绝不产生跨块"传送边"（那是蛇身弧被拉断、蛇原地徘徊的根源）。
 *
 * - removeBlock（宏格将变障碍）：对每条张开侧，邻居侧恰有一个 out-end（next 指入被摘格）
 *   和一个 in-end（prev 来自被摘格），二者相邻 → 直连闭合。每次 O(4) 拼接 + O(N) walk 校验。
 * - unblock 场景：障碍恢复后不强行缝回（保持 N < 全图也可通关），周期性调度自动触发；
 *   若要 100% 覆盖可在残局走一次全量重建（见 rebuildFromGrid）。
 * walk 校验失败则快照回滚并拒绝本次变动，回路永远处于已验证的单环状态。
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
  /** 结构校验器：2-正则、单环覆盖 N 格、全部链接网格相邻、idx 与 next 一致。返回违例描述或 null */
  verifyStructure(expectedN: number): string | null {
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
    do {
      const nx = this.next[c];
      if (nx < 0) return `格 ${c} 无后继`;
      // 2) 链接网格相邻
      const dx = Math.abs((c % this.w) - (nx % this.w));
      const dy = Math.abs(((c / this.w) | 0) - ((nx / this.w) | 0));
      if (dx + dy !== 1) return `传送边 ${c}→${nx}`;
      if (this.prev[nx] !== c) return `prev 不一致 ${nx}`;
      count++;
      if (count > this.next.length) return '环过长';
      c = nx;
    } while (c !== start);
    // 3) 覆盖：所有 idx>=0 的格都在环上且无第二个环
    let linked = 0;
    for (let x = 0; x < this.next.length; x++) {
      if (this.next[x] >= 0) {
        linked++;
        if (this.idx[x] < 0) return `格 ${x} 在环外（第二环）`;
      } else if (this.idx[x] >= 0) {
        return `格 ${x} idx 越环`;
      }
    }
    if (count !== expectedN || linked !== expectedN) return `覆盖 ${count}/${expectedN}`;
    return null;
  }

  /** 用初始回路序初始化链接并推导 opened 掩码 */
  init(order: number[]): boolean {
    this.N = order.length;
    this.cells = Int32Array.from(order);
    order.forEach((c, i) => {
      this.idx[c] = i;
      this.next[c] = order[(i + 1) % this.N];
      this.prev[c] = order[(i - 1 + this.N) % this.N];
    });
    // 推导 opened：环向序对 (u,v)，若 next[u]===v 或 next[v]===u 则该侧闭合
    for (let m = 0; m < this.mw * this.mh; m++) {
      if (this.macroBlocked[m]) continue;
      let mask = 0;
      for (let s = 0; s < 4; s++) {
        const [u, v] = this.sideCells(m, s);
        if (this.next[u] !== v && this.next[v] !== u) mask |= 1 << s;
      }
      this.opened[m] = mask;
    }
    return this.verifyWalk();
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

  /** 沿 next 走一圈重编号；校验单环覆盖全部链接格。失败返回 false（调用方回滚） */
  private rewalk(): boolean {
    this.walkCount++;
    let start = -1;
    for (let c = 0; c < this.next.length; c++) {
      if (this.next[c] >= 0) {
        start = c;
        break;
      }
    }
    if (start < 0) return false;
    this.idx.fill(-1);
    let c = start;
    let i = 0;
    do {
      this.idx[c] = i;
      this.cells[i] = c;
      i++;
      c = this.next[c];
      if (i > this.N) return false;
    } while (c !== start);
    if (i !== this.N) return false;
    for (let x = 0; x < this.next.length; x++) {
      if (this.next[x] >= 0 && this.idx[x] < 0) return false; // 存在第二个环
    }
    return true;
  }

  private verifyWalk(): boolean {
    return this.rewalk();
  }

  /**
   * 摘除宏格 m（grid.blocked 已更新后调用）：全量重建回路（O(N)）。
   * 为何不用 O(1) 段折叠：2×2 宏格被环穿越的段，其两端外侧格在 4-邻接下必不相邻
   * （直边穿 1 格 → 两端列差 3；对角穿 2 格 → 对角），直连必产生传送边（实测多次）。
   * 生成树重建 O(N)≈900 格 < 0.1ms，在 2ms 预算内且正确性可证明（verifyStructure 把关）。
   * 状态来源：macroBlocked 直接从 game 的 blocked 位图推导，调用前 grid 必须已更新。
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
    if (this.monoArcChecker && !this.monoArcChecker(order)) return false;
    this.N = order.length;
    this.cells = Int32Array.from(order);
    this.idx.fill(-1);
    // 清空全部旧链接：新回路可能不含旧格子（N 缩短/格子变更），残留 next/prev 会被
    // verifyStructure 判为「环外第二环」（实测 remove 1 失败路径根因）
    this.next.fill(-1);
    this.prev.fill(-1);
    order.forEach((c, i) => {
      this.idx[c] = i;
      this.next[c] = order[(i + 1) % this.N];
      this.prev[c] = order[(i - 1 + this.N) % this.N];
    });
    this.walkCount++;
    // macroBlocked 与 opened 统一从当前回路/grid 重推导
    for (let mm = 0; mm < this.mw * this.mh; mm++) {
      const a = macroTL(this.w, this.mw, mm);
      this.macroBlocked[mm] = this.idx[a] < 0 ? 1 : 0;
      if (this.macroBlocked[mm]) { this.opened[mm] = 0; continue; }
      let mask = 0;
      for (let s = 0; s < 4; s++) {
        const [u, v] = this.sideCells(mm, s);
        if (this.next[u] !== v && this.next[v] !== u) mask |= 1 << s;
      }
      this.opened[mm] = mask;
    }
    return this.verifyStructure(this.N) === null;
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
      // 降级观察期：记录 walk spike 供滞回恢复判定（连续无 spike 达 recoverySteps 才恢复）
      if (walks > this.budgetWalks) this.recoveryWalkSpikes++;
      return;
    }
    this.wall.push(ms);
    if (this.wall.length > this.windowSize) this.wall.shift();
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
    if (DegradeController.p99(this.wall) > this.wallBudgetMs) {
      // 墙钟去抖：单窗口超标可能是 GC/JIT 尖峰（rebuild p99 实测 ~2.3ms，偶发越线）。
      // 连续 2 个窗口 p99 都超标才降级——慢环境仍会触发，单次尖峰不再误伤。
      this.wallOverStreak++;
      if (this.wallOverStreak >= 2) return this.trip('wall', step);
      return false;
    }
    this.wallOverStreak = 0;
    return false;
  }
  private trip(r: DegradeReason, step: number): boolean {
    this.degraded = true;
    this.reason = r;
    this.degradeStep = step;
    return true;
  }
  /** 外部强制降级（拓扑连续异常 / 验收自检） */
  force(reason: DegradeReason, step: number) {
    if (!this.degraded) {
      this.degraded = true;
      this.reason = reason;
      this.degradeStep = step;
    }
  }
  /**
   * 滞回恢复（d-4）：降级后若连续 recoveryWindows 个窗口的确定性判据（walks）
   * 全部低于预算的 1/2，则恢复捷径——防止长对抗局永久禁捷径把步数推到饥饿阈值附近。
   * 墙钟不参与恢复判定（不可复现）。恢复后 re-degrade 仍可能发生（滞回对称）。
   */
  tryRecover(step: number): boolean {
    if (!this.degraded || this.reason === 'anomaly' || this.reason === 'forced') return false;
    // 滞回：降级后经过 recoverySteps 步且期间无新 walk spike 才恢复
    if (step - this.degradeStep >= this.recoverySteps && this.recoveryWalkSpikes === 0) {
      this.degraded = false;
      this.reason = 'none';
      this.degradeStep = -1;
      this.walks = [];
      this.wall = [];
      this.wallOverStreak = 0;
      this.recovered = true;
      return true;
    }
    return false;
  }
  /** 降级后需保持的恢复步数（滞回带宽度） */
  readonly recoverySteps = 200;
  /** 恢复观察期内记录的 walk spike 数 */
  recoveryWalkSpikes = 0;
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

  /** A2 对手档：事件必须落地（候选不可拒，公平性三条件在接受时刻检查） */
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
          for (const c of e.cells) g.unreserveCell(c);
          this.pending.splice(i, 1);
          continue;
        }
        // 时序：applyBlock（grid 更新）→ onBlocked 重排回路 → 失败则回滚 grid 放弃事件
        g.applyBlock(e.cells);
        this.landSeq++;
        if (!this.onBlocked(e.macro)) {
          g.applyUnblock(e.cells);
          this.pending.splice(i, 1);
          continue;
        }
      } else {
        // unblock 时序：onUnblock 预排（grid 未变，重建包含将恢复的宏格）→ applyUnblock → onUnblocked 对齐
        e.tries++;
        if (!this.onUnblock(e.macro)) {
          if (e.tries > 8) {
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
        this.onUnblocked(e.macro);
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
      if (this.macroIsBlockedOrReserved(m)) continue;
      const cells = this.macroCellList(m);
      if (cells.some((c) => g.grid.blocked[c] || g.occ[c] || g.foodAt[c] >= 0 || g.reserved[c])) continue;
      const cx = cells.reduce((s, c) => s + g.grid.x(c), 0) / 4;
      const cy = cells.reduce((s, c) => s + g.grid.y(c), 0) / 4;
      const nearHead = Math.abs(hx - cx) + Math.abs(hy - cy) < 8;
      // A1 档（可拒绝候选）：距蛇头过近或割点 → 跳过（零重建成本）
      if (!this.forceLand) {
        if (nearHead) continue;
        if (isCutVertex(m)) continue;
      } else {
        // A2 档（事件必须落地）：候选不可拒，但公平性三条件在「接受时刻」检查：
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
          if (escape < 2) continue; // 公平性①不满足 → 本候选不可接受（换一个位置）
        }
        if (isCutVertex(m)) continue; // 公平性③（宏格粒度）：拆除后不连通 → 接受会破坏 C
      }
      expensiveTries++;
      if (!this.onReserve(m)) continue; // 回路拆除失败（连通性等）→ 换一个
      for (const c of cells) g.reserveCell(c);
      this.pending.push({ atStep: g.steps + this.notice, kind: 'block', macro: m, cells, tries: 0, backoff: 5 });
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
