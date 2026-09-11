/**
 * b-主：2-factor + 圈合并增量维护引擎（DynamicCycle 的论证级升级，drop-in 兼容）。
 *
 * 表示：维护对象是「支持集」（当前应被回路覆盖的格子集合，宏格粒度增删）上的 2-factor——
 * 每个支持集内的格子恰好 2 条链接，链接两端必为网格相邻格。用双槽无向链接表 l0/l1 存储。
 * 单环只是 2-factor 的特例；提交给 cycleStep 前用圈合并把所有圈缝成单环，
 * 提交视图 {next, prev, idx, cells, N} 与 DynamicCycle 逐字段兼容（策略层零改动）。
 *
 * 四个组件（老师定案 Q1 路线）：
 * 1. b-matching 流求解（solveFlow）：二分图最大流（黑格→白格；S→黑容量 2、边容量 1、
 *    白→T 容量 2；Dinic）。满流 ⟺ 支持集上存在 2-factor（宏格对齐布局黑白恒平衡）。
 *    用于初始化与增量失败时的兜底。一般图 Tutte 匹配不需要——网格是二分图。
 * 2. 平行边缝合（2-switch）：两圈各断一条边、交叉重连 (c,d)+(p,r)，要求 (p,r) 网格相邻。
 *    相邻圈「对面格子对」相邻即缝合成功（宏格对齐布局高频成立，见 b-预研探针）。
 * 3. 对角 reroute（首跳强制交替路）：缝合条件不满足时，断开 (c,p) 制造一对亏格，
 *    从 c 做增广路 BFS 且首跳强制 = d（d 属于另一圈）——路径必经对方圈的已有边，
 *    Berge 翻转后 c 经对方圈接回，任意相触圈对均可合并（对角相触的兜底）。
 * 4. O(受影响区域) 增量修复（repair）：宏格摘除/缝回只切断边界链接，产生 O(1) 个亏格格
 *    （度 <2）；在亏格间找交替增广路重连（中间格去一条补一条、度数不变）。
 *    最坏 O(N)，实测受影响区域为宏格边界邻域（stats.pathVisits 记录 BFS 访问数）。
 *
 * 完备性与降级链：亏格增广找不到路 ⟹ 当前 b-matching 已是支持集上的最大基数
 * （增广路定理），不足满配 ⟹ 支持集上无 2-factor ⟹ 事件确实不可行。工程上仍逐级降级：
 * 增量修复 → 全量流求解（fresh 因子换合并形态）→ 拒绝事件（调用方回滚），与
 * DynamicCycle「重建失败放弃事件」语义一致。每次变更先快照、失败即恢复，
 * 回路永远处于已验证状态（verifyStructure 把关）。
 *
 * 与「直连折叠不可行」引理不冲突：该引理否的是 O(1) 段拼接（2×2 宏格被环穿越段两端
 * 外侧格 4-邻接必不相邻），不否 O(局部) 修复——增广路在边界邻域内重连，不直连折叠段。
 */
import { Game } from './game';

/** b 引擎开关：默认关闭 = 经典 DynamicCycle 路径完全不变；bench-dyn --twofactor 打开 */
export const TWOFACTOR_ENGINE = { enabled: false };

const TDX = [0, 1, 0, -1] as const;
const TDY = [-1, 0, 1, 0] as const;

export interface TwoFactorStats {
  /** 全量流求解次数（初始化 + 兜底） */
  flowSolves: number;
  /** 增量修复触发次数 */
  repairs: number;
  /** 增量修复失败（走兜底）次数 */
  repairFails: number;
  /** 兜底全量求解次数 */
  fallbacks: number;
  /** 平行边缝合（2-switch）成功次数 */
  twoSwitch: number;
  /** 对角 reroute 成功次数 */
  reroute: number;
  /** 合并阶段失败次数（触发全量流兜底；兜底仍失败=事件被拒绝） */
  mergeFails: number;
  /** 快照回滚次数 */
  rollbacks: number;
  /** 最近一次初始化流解的原始圈数（合并前） */
  rawCycles: number;
  /** 每条增广路 BFS 访问格数（受影响区域度量） */
  pathVisits: number[];
  /** 每条增广路边数 */
  pathLens: number[];
  /** 每次 remove/insert 事件耗时（ms） */
  eventMs: number[];
  /** 每次流求解耗时（ms） */
  flowMs: number[];
  /** 每次 rebuildFn 兜底耗时（ms） */
  rebuildMs: number[];
}

export class TwoFactorCycle {
  readonly w: number;
  readonly h: number;
  readonly mw: number;
  readonly mh: number;
  readonly n: number;
  /** 初始障碍位图（grid.blocked 会在游戏中变化，支持集语义用初始布局锚定） */
  private readonly gridBlocked: Uint8Array;
  /** 链接双槽：present[c]=1 时 l0[c]、l1[c] 恰为两条网格相邻链接（-1=空槽） */
  l0: Int32Array;
  l1: Int32Array;
  present: Uint8Array;
  presentCount = 0;
  /** 提交视图（单环），与 DynamicCycle 同名同义，cycleStep 直接消费 */
  next: Int32Array;
  prev: Int32Array;
  idx: Int32Array;
  cells: Int32Array;
  N = 0;
  /** 累计提交 walk 次数（确定性性能指标，供降级判定，语义与 DynamicCycle 一致） */
  walkCount = 0;
  /** 累计回滚次数（观测/故障注入验证用） */
  rollbackCount = 0;
  /** 接线兼容字段：策略层会赋值；b 引擎全量兜底用自己的流求解，不消费它 */
  rebuildFn: (() => number[] | null) | null = null;
  /** 单调弧校验回调：提交视图上蛇身必须仍是尾→头单调弧，不满足即拒绝本次变更 */
  monoArcChecker: ((order: number[]) => boolean) | null = null;

  readonly stats: TwoFactorStats = {
    flowSolves: 0,
    repairs: 0,
    repairFails: 0,
    fallbacks: 0,
    twoSwitch: 0,
    reroute: 0,
    mergeFails: 0,
    rollbacks: 0,
    rawCycles: -1,
    pathVisits: [],
    pathLens: [],
    eventMs: [],
    flowMs: [],
    rebuildMs: [],
  };

  // 交替路 BFS 刻痕数组（代际戳避免每次清零；格×相乘积图——每格两相各一次）
  private visitedM: Int32Array;
  private visitedE: Int32Array;
  /** 经缺失边到达的父节点 / 经已有链接到达的父节点（分相存储：同格两相到达互不覆盖） */
  private parentM: Int32Array;
  private parentE: Int32Array;
  private queue: Int32Array;
  private bfsStamp = 0;
  // 圈标记 scratch（merge 主扫描 / reroute 验证 / rawCycles 统计各自独立，不嵌套复用）
  private labels: Int32Array;
  private labelsB: Int32Array;
  // 事件级快照（removeBlock/insertBlock 原子性）
  private snapL0: Int32Array;
  private snapL1: Int32Array;
  private snapP: Uint8Array;
  private snapCnt = 0;

  constructor(game: Game) {
    const g = game.grid;
    this.w = g.w;
    this.h = g.h;
    this.mw = g.w / 2;
    this.mh = g.h / 2;
    this.n = g.n;
    this.gridBlocked = Uint8Array.from(g.blocked);
    this.l0 = new Int32Array(this.n).fill(-1);
    this.l1 = new Int32Array(this.n).fill(-1);
    this.present = new Uint8Array(this.n);
    this.next = new Int32Array(this.n).fill(-1);
    this.prev = new Int32Array(this.n).fill(-1);
    this.idx = new Int32Array(this.n).fill(-1);
    this.cells = new Int32Array(this.n);
    this.visitedM = new Int32Array(this.n);
    this.visitedE = new Int32Array(this.n);
    this.parentM = new Int32Array(this.n);
    this.parentE = new Int32Array(this.n);
    // 相乘图 BFS：每格至多两相各入队一次，队列容量必须 2n（Int32Array 越界写静默丢弃，
    // 容量不足会截断大分量的搜索——实测 78 圈场景 merge 全灭的根因）
    this.queue = new Int32Array(this.n * 2);
    this.labels = new Int32Array(this.n);
    this.labelsB = new Int32Array(this.n);
    this.snapL0 = new Int32Array(this.n);
    this.snapL1 = new Int32Array(this.n);
    this.snapP = new Uint8Array(this.n);
  }

  /* ------------------------------------------------------------ */
  /* 基础原语                                                       */
  /* ------------------------------------------------------------ */

  private macroCells(m: number): number[] {
    const a = 2 * ((m / this.mw) | 0) * this.w + 2 * (m % this.mw);
    return [a, a + 1, a + this.w, a + this.w + 1];
  }

  private deg(c: number): number {
    return (this.l0[c] >= 0 ? 1 : 0) + (this.l1[c] >= 0 ? 1 : 0);
  }

  private hasLink(a: number, b: number): boolean {
    return this.l0[a] === b || this.l1[a] === b;
  }

  /** 网格 4-邻接判定（用坐标而非 grid.nbr——预排期间邻接表与支持集视图不同步） */
  private adjacent(a: number, b: number): boolean {
    return Math.abs((a % this.w) - (b % this.w)) + Math.abs(((a / this.w) | 0) - ((b / this.w) | 0)) === 1;
  }

  /** 清除 a 侧指向 b 的槽位（单向；调用方负责对称性） */
  private clearSlot(a: number, b: number): void {
    if (this.l0[a] === b) this.l0[a] = -1;
    else if (this.l1[a] === b) this.l1[a] = -1;
  }

  /** 在 a、b 各自的空槽位间建立链接（调用前双方必有空槽） */
  private linkCells(a: number, b: number): void {
    if (this.l0[a] < 0) this.l0[a] = b;
    else this.l1[a] = b;
    if (this.l0[b] < 0) this.l0[b] = a;
    else this.l1[b] = a;
  }

  private unlinkEdge(a: number, b: number): void {
    this.clearSlot(a, b);
    this.clearSlot(b, a);
  }

  /* ------------------------------------------------------------ */
  /* 快照 / 恢复（事件原子性）                                       */
  /* ------------------------------------------------------------ */

  private snapshot(): void {
    this.snapL0.set(this.l0);
    this.snapL1.set(this.l1);
    this.snapP.set(this.present);
    this.snapCnt = this.presentCount;
  }

  /** 事件失败恢复：还原链接并重建提交视图（确定性 walk，与变更前一致） */
  private restoreFail(): void {
    this.l0.set(this.snapL0);
    this.l1.set(this.snapL1);
    this.present.set(this.snapP);
    this.presentCount = this.snapCnt;
    this.rollbackCount++;
    this.stats.rollbacks++;
    this.commit();
  }


  /* ------------------------------------------------------------ */
  /* 校验器                                                         */
  /* ------------------------------------------------------------ */

  /** 结构校验器：与 DynamicCycle.verifyStructure 同语义（单环 / 链接相邻 / prev 一致 / 覆盖） */
  verifyStructure(expectedN: number): string | null {
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
      const dx = Math.abs((c % this.w) - (nx % this.w));
      const dy = Math.abs(((c / this.w) | 0) - ((nx / this.w) | 0));
      if (dx + dy !== 1) return `传送边 ${c}→${nx}`;
      if (this.prev[nx] !== c) return `prev 不一致 ${nx}`;
      count++;
      if (count > this.next.length) return '环过长';
      c = nx;
    } while (c !== start);
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

  /** 因子校验器（测试/防御用）：支持集内每格恰 2 条链接、无平行边、链接相邻且对称 */
  verifyFactor(): string | null {
    for (let c = 0; c < this.n; c++) {
      if (!this.present[c]) {
        if (this.l0[c] >= 0 || this.l1[c] >= 0) return `格 ${c} 不在支持集却有链接`;
        continue;
      }
      if (this.l0[c] < 0 || this.l1[c] < 0) return `格 ${c} 度 ${this.deg(c)} ≠ 2`;
      if (this.l0[c] === this.l1[c]) return `格 ${c} 平行边 ${this.l0[c]}`;
      for (const v of [this.l0[c], this.l1[c]]) {
        if (!this.present[v]) return `格 ${c} 链接到支持集外 ${v}`;
        if (!this.adjacent(c, v)) return `传送边 ${c}-${v}`;
        if (!this.hasLink(v, c)) return `链接不对称 ${c}-${v}`;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ */
  /* 提交：链接结构 → 单环视图                                       */
  /* ------------------------------------------------------------ */

  /** 从链接结构走圈重建提交视图（确定性：起点=最小下标存在格，首步=l0）。失败返回 false。
   *  必须先清空 next/prev：被摘格的残留链接会被 verifyStructure 判为「环外第二环」
   *  （同 DynamicCycle.rebuildCore 的历史教训）。 */
  private commit(): boolean {
    let start = -1;
    for (let c = 0; c < this.n; c++) {
      if (this.present[c] && this.l0[c] >= 0) {
        start = c;
        break;
      }
    }
    if (start < 0) return this.presentCount === 0;
    this.idx.fill(-1);
    this.next.fill(-1);
    this.prev.fill(-1);
    let prevCell = -1;
    let cur = start;
    let i = 0;
    do {
      this.idx[cur] = i;
      this.cells[i] = cur;
      const nxt = prevCell < 0 ? this.l0[cur] : this.l0[cur] === prevCell ? this.l1[cur] : this.l0[cur];
      this.next[cur] = nxt;
      this.prev[nxt] = cur;
      prevCell = cur;
      cur = nxt;
      i++;
      if (i > this.presentCount) return false;
    } while (cur !== start);
    if (i !== this.presentCount) return false; // 多环未合并干净 / 存在度 0 格
    this.N = i;
    this.walkCount++;
    return this.verifyStructure(this.N) === null;
  }

  /** 圈标记：labels[c] = 所在圈编号；返回圈数（确定性：起点扫描序 + 首步 l0）。
   *  步数上限 n+1：链接不对称（翻转缺陷）时游走可能永不回环——labelCycles 死循环
   *  曾把事件拖到分钟级（实测 m=22）。返回 Infinity = 结构破损，调用方失败回滚。 */
  private labelCycles(labels: Int32Array): number {
    labels.fill(-1);
    let k = 0;
    for (let c = 0; c < this.n; c++) {
      if (!this.present[c] || this.l0[c] < 0 || labels[c] >= 0) continue;
      let prevCell = -1;
      let cur = c;
      let steps = 0;
      do {
        labels[cur] = k;
        const nxt = prevCell < 0 ? this.l0[cur] : this.l0[cur] === prevCell ? this.l1[cur] : this.l0[cur];
        prevCell = cur;
        cur = nxt;
        if (++steps > this.n + 1) return Infinity;
      } while (cur !== c);
      k++;
    }
    return k;
  }

  /* ------------------------------------------------------------ */
  /* 圈合并：平行边缝合 + 对角 reroute                                */
  /* ------------------------------------------------------------ */

  /** 把所有圈合并成单环并提交。两阶段循环：
   *  ① 平行边缝合（2-switch）：两圈各断一条边交叉重连，数学上保证净减一圈，优先做（零风险）；
   *  ② 对角 reroute：无缝合机会时断边制造亏格对做首跳强制增广。增广保证因子合法但
   *     不保证减圈（路径可能经弦折返产出等量新环，实测 88 圈场景 28 次），
   *     故翻转后校验圈数严格下降，否则逆翻转原路回滚（O(路径)，无快照拷贝）。
   *  失败返回 false（调用方走全量兜底）。 */
  private mergeToSingle(): boolean {
    const maxGuard = (this.presentCount >> 2) + 8;
    for (let guard = 0; guard <= maxGuard; guard++) {
      const k = this.labelCycles(this.labels);
      if (k === Infinity) { this.stats.mergeFails++; return false; } // 结构破损（防御）
      if (k <= 1) return this.commit();
      let progressed = false;
      // 阶段 ①：全表扫 2-switch 机会（labels 为本轮相位起点快照，成功即跳出重标）
      for (let c = 0; c < this.n && !progressed; c++) {
        if (!this.present[c] || this.l0[c] < 0) continue;
        const cx = c % this.w;
        const cy = (c / this.w) | 0;
        for (let dir = 0; dir < 4 && !progressed; dir++) {
          const nx = cx + TDX[dir];
          const ny = cy + TDY[dir];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const d = ny * this.w + nx;
          if (!this.present[d] || this.l0[d] < 0 || this.labels[d] === this.labels[c]) continue;
          progressed = this.tryTwoSwitch(c, d);
        }
      }
      if (progressed) continue;
      // 阶段 ②：reroute（验证 + 可逆回滚）。每轮限 K 次失败尝试——跨圈对可达 O(N)，
      // 每对 BFS O(N)，无上限时单轮 O(N²)、几十轮累积 O(N³) 把事件拖到秒级
      // （实测 medium e17 单事件 60s+ 挂点）。失败预算耗尽即 mergeFails 走兜底。
      let rerouteTries = 0;
      const MAX_REROUTE_TRIES = 12;
      for (let c = 0; c < this.n && !progressed; c++) {
        if (!this.present[c] || this.l0[c] < 0) continue;
        const cx = c % this.w;
        const cy = (c / this.w) | 0;
        for (let dir = 0; dir < 4 && !progressed; dir++) {
          const nx = cx + TDX[dir];
          const ny = cy + TDY[dir];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const d = ny * this.w + nx;
          if (!this.present[d] || this.l0[d] < 0 || this.labels[d] === this.labels[c]) continue;
          progressed = this.tryRerouteVerified(c, d, k);
          if (!progressed && ++rerouteTries >= MAX_REROUTE_TRIES) break;
        }
      }
      if (!progressed) {
        this.stats.mergeFails++;
        return false;
      }
    }
    return false; // guard 耗尽（每次成功操作至少净减一圈，不该到达）
  }

  /** 平行边缝合：p∈links(u)、r∈links(v) 且 (p,r) 网格相邻 → 断 (u,p)(v,r) 接 (u,v)(p,r)。
   *  两圈剪弦交叉重连必并成一环（c→d→绕 v 圈→r→p→绕 u 圈→c）。双向都试（条件非对称）。 */
  private tryTwoSwitch(c: number, d: number): boolean {
    for (let orient = 0; orient < 2; orient++) {
      const u = orient === 0 ? c : d;
      const v = orient === 0 ? d : c;
      for (const p of [this.l0[u], this.l1[u]]) {
        if (p < 0 || p === v) continue;
        for (const r of [this.l0[v], this.l1[v]]) {
          if (r < 0 || r === u) continue;
          if (!this.adjacent(p, r)) continue;
          this.unlinkEdge(u, p);
          this.unlinkEdge(v, r);
          this.linkCells(u, v);
          this.linkCells(p, r);
          this.stats.twoSwitch++;
          return true;
        }
      }
    }
    return false;
  }

  /** 对角 reroute（验证版）：断 (u,p) 制造亏格对 {u,p}，从 u 做首跳强制=v 的增广路并翻转；
   *  翻转后圈数严格下降才接受（labelsB 计数，不覆写扫描用 labels），否则逆翻转 + 重接断边。 */
  private tryRerouteVerified(c: number, d: number, kBefore: number): boolean {
    for (const [u, v] of [
      [c, d],
      [d, c],
    ]) {
      for (const p of [this.l0[u], this.l1[u]]) {
        if (p < 0 || p === v) continue;
        this.unlinkEdge(u, p);
        const path = this.findAugmentingPath(u, v);
        if (path && path.length >= 3 && path[path.length - 1] === p) {
          this.flipPath(path);
          if (this.labelCycles(this.labelsB) < kBefore) {
            this.stats.reroute++;
            this.stats.pathLens.push(path.length - 1);
            return true;
          }
          this.unflipPath(path);
        }
        this.linkCells(u, p);
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ */
  /* 交替增广路（Berge）：修复与 reroute 共用                          */
  /* ------------------------------------------------------------ */

  /**
   * 单源交替增广路（b-matching 残量图 BFS，repair 与 reroute 共用原语）：
   * 从亏格格 start 出发，缺失边（可新增）与已有链接（可删除）交替，
   * 终点 = 经缺失边到达的另一个亏格格（度 <2 且 ≠ start）。
   * 相乘图 BFS：每格「缺失相 / 已有相」各访问一次（交替走需要同格异相重访，
   * 单一刻痕会把可行增广走误判为无路）。
   * forcedFirst ≥ 0 时首跳只允许该邻居（reroute 用：强制路径先进入指定圈）。
   * 返回顶点路径（含两端点，path[0]===start）或 null。
   * 终点判定只依赖当前 stamp 的数据（visitedE/deg），不读 parentM——它在跨 BFS
   * 调用间是过期的（历史教训：stale -2 把合法终点永久排除，增广全灭走兜底）。
   * 每次成功翻转总亏格恰 −2（两端各 +1 度、中间格 ±0），故修复必然终止。
   */
  private findAugmentingPath(start: number, forcedFirst: number, maxVisits = Infinity): number[] | null {
    const stamp = ++this.bfsStamp;
    const { visitedM, visitedE, parentM, parentE, queue } = this;
    let qh = 0;
    let qt = 0;
    let visits = 1;
    visitedM[start] = stamp; // 源处于缺失相（下一条走缺失边）
    parentM[start] = -2; // 源标记（回溯终点；仅当前 stamp 内有效）
    queue[qt++] = start;
    queue[qt++] = 0; // 相位：0=缺失相（来路是缺失边）1=已有相（来路是已有链接）
    while (qh < qt) {
      const cur = queue[qh++];
      const phase = queue[qh++];
      if (phase === 0) {
        const cx = cur % this.w;
        const cy = (cur / this.w) | 0;
        const isStart = cur === start;
        for (let dir = 0; dir < 4; dir++) {
          const nx = cx + TDX[dir];
          const ny = cy + TDY[dir];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const w = ny * this.w + nx;
          if (!this.present[w] || visitedE[w] === stamp || this.hasLink(cur, w)) continue;
          if (isStart && forcedFirst >= 0 && w !== forcedFirst) continue;
          visitedE[w] = stamp;
          parentE[w] = cur;
          visits++;
          // 访问预算：超深搜索是事件耗时重尾的来源（成功增广 99.7% 在 len≤15 内），
          // 超限放弃 = 该亏格本轮无路 → repair 判失败走 rebuild 兜底（正确性不变）。
          if (visits > maxVisits) return null;
          // 终点 = 经缺失边到达的亏格（w===start 是奇交替环退化，翻转必撞槽位，排除）
          if (w !== start && this.deg(w) < 2) {
            this.stats.pathVisits.push(visits);
            return this.buildPath(w);
          }
          queue[qt++] = w;
          queue[qt++] = 1;
        }
      } else {
        // 已有相：沿两条已有链接走（中间格必为度 2）
        for (const u of [this.l0[cur], this.l1[cur]]) {
          if (u >= 0 && visitedM[u] !== stamp) {
            visitedM[u] = stamp;
            parentM[u] = cur;
            visits++;
            if (visits > maxVisits) return null;
            queue[qt++] = u;
            queue[qt++] = 0;
          }
        }
      }
    }
    return null;
  }

  /** 从终点回溯到源（parentM=-2，仅当前 stamp 的格子上有效）。
   *  逐边校验交替性（防御：非交替/断链一律返回空数组，调用方回滚）。
   *  长度过滤：≥2（相邻亏格对的直接缺失边 = 长度 2 的合法增广，杀掉它会让 repair
   *  大面积假失败走兜底——实测 repairFails 61/80 的根因）；退化环（首尾同格）
   *  由 ends-differ 检查排除。调用方按需加严（reroute 要 ≥3 防直连空转）。 */
  private buildPath(t: number): number[] {
    const stamp = this.bfsStamp;
    const path: number[] = [];
    let cur = t;
    let fromE = true; // 终点恒经缺失边到达
    for (let guard = 0; guard <= this.n; guard++) {
      path.push(cur);
      const p = fromE ? this.parentE[cur] : this.parentM[cur];
      if (p === -2) break; // 到达源
      if (p < 0) return []; // 断链（防御）
      // 父节点的入队相 stamp 校验：fromE ⟹ p 经已有相访问，否则经缺失相访问
      if (fromE ? this.visitedM[p] !== stamp : this.visitedE[p] !== stamp) return [];
      // 交替性校验：缺失相来路的边必须缺失、已有相来路的边必须存在
      if (fromE === this.hasLink(cur, p)) return [];
      cur = p;
      fromE = !fromE;
    }
    path.reverse();
    if (path.length < 2 || path[0] === path[path.length - 1]) return [];
    return path;
  }

  /** 翻转交替路：偶数位边（缺失）新增、奇数位边（已有）删除；中间格度数不变，两端亏格各 +1 */
  private flipPath(path: number[]): void {
    for (let i = 1; i < path.length - 1; i += 2) this.unlinkEdge(path[i], path[i + 1]);
    for (let i = 0; i < path.length - 1; i += 2) this.linkCells(path[i], path[i + 1]);
  }

  /** flipPath 的逆操作（O(路径) 无快照回滚）：先删新接的偶位边、再还原被删的奇位边 */
  private unflipPath(path: number[]): void {
    for (let i = 0; i < path.length - 1; i += 2) this.unlinkEdge(path[i], path[i + 1]);
    for (let i = 1; i < path.length - 1; i += 2) this.linkCells(path[i], path[i + 1]);
  }

  /* ------------------------------------------------------------ */
  /* 增量修复：亏格森林增广                                          */
  /* ------------------------------------------------------------ */

  /**
   * 把所有亏格格（present 且度 <2）修复到度 2：多源交替增广——所有未满亏格同时作为
   * 源扩散，任一源经缺失边碰到另一亏格即成路，翻转后总亏格 −2，循环至全满。
   * 一轮无进展 ⟹ 残量图无任何增广路 ⟹ 当前 b-matching 已最大且不足满配
   * ⟹ 支持集上无 2-factor（增广路定理，拒绝的正当性依据）。
   */
  private repair(deficits: number[]): boolean {
    this.stats.repairs++;
    const list = deficits.slice();
    for (let round = 0; round < 64; round++) {
      const active = list.filter((d) => this.present[d] && this.deg(d) < 2);
      if (active.length === 0) return true;
      // 分批单源：对每个未满亏格单独找增广路。多源版（findAugmentingMulti 传全表）
      // 的终点判定排除「w 是源」——而亏格间互连恰是修复目标（60↔32 实测 null），
      // 源间互连需要独立的端点色标记才安全；单源循环正确且同样从各亏格扩散。
      // 访问预算 60：实测成功增广 99.7% 在 len≤15（访问 ~40）内，超深搜索是
      // 事件耗时重尾来源；超限 = 本轮无路 → rebuild 兜底（O(N) 有界，正确性不变）。
      let progressed = false;
      for (const s of active) {
        // 前面的 flip 会改变本轮后续源点的图状态：源可能已被别人的增广路补满。
        // 翻转前必须重新校验源仍是亏格——否则 findAugmentingPath 从满格出发，
        // 接入「缺失边」时该格无空槽，linkCells 会覆盖另一条已有链接的槽位，
        // 产生单向链接（链接不对称，实测 s7011 e36 532-562）。
        if (!this.present[s] || this.deg(s) >= 2) continue;
        const path = this.findAugmentingPath(s, -1, 60);
        // 长度 ≥2：相邻亏格对的直接缺失边即合法增广（两端各 +1 度）
        if (!path || path.length < 2 || path[0] !== s) continue;
        // 二次防御：终点也必须仍是亏格（时序竞争：终点被先行路径补满后，翻转
        // 会让它超 2 度或覆盖槽位）。
        const t = path[path.length - 1];
        if (t !== s && this.present[t] && this.deg(t) >= 2) continue;
        this.flipPath(path);
        progressed = true;
      }
      if (!progressed) {
        // 无任何单源增广路 ⟹ b-matching 已最大且不足满配 ⟹ 支持集上无 2-factor
        return false;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ */
  /* b-matching 流求解（Dinic 二分图最大流）                          */
  /* ------------------------------------------------------------ */

  /**
   * 在当前支持集上求满配 2-factor 并重链接。黑格（x+y 偶）→白格二分图：
   * S→黑 cap2、黑→白边 cap1、白→T cap2；满流 = 2×黑格数 ⟺ 每黑 2 出、每白 2 入。
   * 宏格对齐支持集黑白恒平衡（每 2×2 宏格 2 黑 2 白）。
   * variant：确定性扰动（0..7）——邻接扫描起点旋转，改变弧插入顺序从而改变 Dinic
   * 破流点选择，产出不同因子形态。merge 失败后的兜底必须换 variant，否则同一支持集
   * 恒产出同一因子、合并恒失败，重试毫无意义。弧按「格下标 + variant 旋转」序插入。
   */
  private solveFlow(variant = 0): boolean {
    const t0 = performance.now();
    this.stats.flowSolves++;
    let blacks = 0;
    let whites = 0;
    for (let c = 0; c < this.n; c++) {
      if (!this.present[c]) continue;
      if (((c % this.w) + ((c / this.w) | 0)) % 2 === 0) blacks++;
      else whites++;
    }
    if (blacks !== whites) return false;
    if (blacks === 0) {
      this.l0.fill(-1);
      this.l1.fill(-1);
      this.stats.flowMs.push(performance.now() - t0);
      return true;
    }
    const rot = variant & 3;
    const S = 2 * this.n;
    const T = 2 * this.n + 1;
    const V = T + 1;
    const eto: number[] = [];
    const ecap: number[] = [];
    const ghead: number[][] = Array.from({ length: V }, () => [] as number[]);
    const addEdge = (u: number, v: number, cap: number) => {
      ghead[u].push(eto.length);
      eto.push(v);
      ecap.push(cap);
      ghead[v].push(eto.length);
      eto.push(u);
      ecap.push(0);
    };
    for (let c = 0; c < this.n; c++) {
      if (!this.present[c]) continue;
      const isBlack = ((c % this.w) + ((c / this.w) | 0)) % 2 === 0;
      if (isBlack) {
        addEdge(S, c, 2);
        const cx = c % this.w;
        const cy = (c / this.w) | 0;
        for (let k = 0; k < 4; k++) {
          const dir = (k + rot) & 3;
          const nx = cx + TDX[dir];
          const ny = cy + TDY[dir];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const w = ny * this.w + nx;
          if (!this.present[w]) continue;
          addEdge(c, this.n + w, 1);
        }
      } else {
        addEdge(this.n + c, T, 2);
      }
    }
    // Dinic：BFS 分层 + 阻塞流
    const level = new Int32Array(V);
    const iters = new Int32Array(V);
    const bfsQ = new Int32Array(V);
    let flow = 0;
    const target = 2 * blacks;
    const dfs = (u: number, f: number): number => {
      if (u === T) return f;
      for (; iters[u] < ghead[u].length; iters[u]++) {
        const ei = ghead[u][iters[u]];
        const v = eto[ei];
        if (ecap[ei] <= 0 || level[v] !== level[u] + 1) continue;
        const d = dfs(v, Math.min(f, ecap[ei]));
        if (d > 0) {
          ecap[ei] -= d;
          ecap[ei ^ 1] += d;
          return d;
        }
      }
      return 0;
    };
    for (;;) {
      level.fill(-1);
      let qh = 0;
      let qt = 0;
      level[S] = 0;
      bfsQ[qt++] = S;
      while (qh < qt) {
        const u = bfsQ[qh++];
        for (const ei of ghead[u]) {
          const v = eto[ei];
          if (ecap[ei] > 0 && level[v] < 0) {
            level[v] = level[u] + 1;
            bfsQ[qt++] = v;
          }
        }
      }
      if (level[T] < 0) break;
      iters.fill(0);
      for (;;) {
        const f = dfs(S, target - flow);
        if (!f) break;
        flow += f;
      }
      if (flow >= target) break;
    }
    if (flow !== target) return false; // 支持集上无 2-factor（链接未动，调用方回滚）
    // 提取：黑格的满流弧 → 两条链接（双向落槽）。
    // 只认「黑→白」正向弧（下标 n..2n−1）且残量为 0（容量 1 已耗尽 = 有流）；
    // S→黑 的反向弧（eto=S）与白→T 的反向弧（eto=白−n 越界值）一律跳过。
    this.l0.fill(-1);
    this.l1.fill(-1);
    const wslot = new Int32Array(this.n);
    for (let c = 0; c < this.n; c++) {
      if (!this.present[c]) continue;
      if (((c % this.w) + ((c / this.w) | 0)) % 2 !== 0) continue;
      let got = 0;
      for (const ei of ghead[c]) {
        const v = eto[ei];
        if (v < this.n || v >= 2 * this.n) continue; // 非 黑→白 弧（S 反向弧等）
        if (ecap[ei] !== 0) continue; // 容量 1 未耗尽 = 无流
        const w = v - this.n;
        if (!this.present[w]) continue;
        if (got === 0) this.l0[c] = w;
        else this.l1[c] = w;
        got++;
        if (wslot[w] === 0) this.l0[w] = c;
        else this.l1[w] = c;
        wslot[w]++;
      }
      if (got !== 2) return false; // 流守恒破坏（防御）
    }
    for (let c = 0; c < this.n; c++) {
      if (this.present[c] && (this.l0[c] < 0 || this.l1[c] < 0)) return false;
    }
    this.stats.flowMs.push(performance.now() - t0);
    return true;
  }

  /** 全量兜底：流求解（逐 variant 换形态）+ 重新合并；全部失败且 rebuildFn 可用时
   *  退到生成树全量重建（保证不劣于既有引擎：增量 → 流变体 → O(N) 重建 → 拒绝）。 */
  /** 全量兜底（事件路径的唯一兜底，时间有界）：rebuildFn（生成树 O(N)，~0.3ms）。
   *  不走流变体——rebuildFn 失败（罕见 Prim 形态 8 seed 重试后仍失败）时流求解+
   *  原始多圈因子全合并实测 30–70ms，是 wall 降级尖峰的根因；且流变体在此场景
   *  成功率有限。事件语义 = 增量修复 → 生成树重建兜底 → 拒绝。专项对照显示该实现
   *  仍可能在全量重建可接受时拒绝，因此它是更保守的实验路径，不能宣称严格不劣。
   *  流求解只用于 init（决策环外）。 */
  private fullResolve(): boolean {
    this.stats.fallbacks++;
    if (this.rebuildFn) {
      const rt0 = performance.now();
      const order = this.rebuildFn();
      this.stats.rebuildMs.push(performance.now() - rt0);
      if (order && order.length === this.presentCount) {
        let allPresent = true;
        for (const c of order) {
          if (!this.present[c]) {
            allPresent = false;
            break;
          }
        }
        if (allPresent) {
          this.l0.fill(-1);
          this.l1.fill(-1);
          for (let i = 0; i < order.length; i++) {
            const c = order[i];
            this.l0[c] = order[(i + 1) % order.length];
            this.l1[c] = order[(i - 1 + order.length) % order.length];
          }
          if (this.mergeToSingle()) return true;
        }
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ */
  /* 初始化                                                          */
  /* ------------------------------------------------------------ */

  /** 从给定单环序初始化（兼容 DynamicCycle.init，也作为流求解失败的后备） */
  init(order: number[]): boolean {
    const L = order.length;
    if (L < 4) return false;
    this.present.fill(0);
    this.l0.fill(-1);
    this.l1.fill(-1);
    for (let i = 0; i < L; i++) {
      const c = order[i];
      this.present[c] = 1;
      this.l0[c] = order[(i + 1) % L];
      this.l1[c] = order[(i - 1 + L) % L];
    }
    this.presentCount = L;
    this.idx.fill(-1);
    order.forEach((c, i) => {
      this.idx[c] = i;
      this.cells[i] = c;
      this.next[c] = order[(i + 1) % L];
      this.prev[c] = order[(i - 1 + L) % L];
    });
    this.N = L;
    this.walkCount++;
    return this.verifyStructure(this.N) === null;
  }

  /** b 路线初始化：流求解 2-factor + 圈合并成单环（逐 variant 重试；失败由调用方后备 init(order)） */
  initFromFlow(): boolean {
    this.present.fill(0);
    this.l0.fill(-1);
    this.l1.fill(-1);
    this.presentCount = 0;
    for (let c = 0; c < this.n; c++) {
      if (!this.gridBlocked[c]) {
        this.present[c] = 1;
        this.presentCount++;
      }
    }
    for (let variant = 0; variant < 4; variant++) {
      if (this.solveFlow(variant)) {
        if (variant === 0) this.stats.rawCycles = this.labelCycles(this.labels);
        if (this.mergeToSingle()) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ */
  /* 事件入口（与 DynamicCycle.removeBlock/insertBlock 同语义）        */
  /* ------------------------------------------------------------ */

  /** 摘除宏格 m（预排/落地双调用安全：已摘除时幂等返回 true）。失败恢复快照并返回 false。 */
  removeBlock(m: number, isSnakeCell: (c: number) => boolean): boolean {
    const cells = this.macroCells(m);
    for (const c of cells) if (isSnakeCell(c)) return false;
    if (cells.every((c) => !this.present[c])) return true; // 双调用守卫
    const t0 = performance.now();
    this.snapshot();
    // 先全摘（同宏格内部链接两端都被摘除，不算亏格），再收集边界 deficits——
    // 逐格边摘边收会把「尚未摘到的同宏格链接端点」误收为 deficit，黑白亏格
    // 守恒（每条切断链接损失黑1白1）被破坏，增广必然无解（实测 100% 走兜底的根因）。
    for (const c of cells) {
      if (!this.present[c]) continue;
      const p1 = this.l0[c];
      const p2 = this.l1[c];
      if (p1 >= 0) this.clearSlot(p1, c);
      if (p2 >= 0) this.clearSlot(p2, c);
      this.present[c] = 0;
      this.l0[c] = -1;
      this.l1[c] = -1;
      this.presentCount--;
    }
    const deficits: number[] = [];
    for (const c of cells) {
      const cx = c % this.w;
      const cy = (c / this.w) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const nx = cx + TDX[dir];
        const ny = cy + TDY[dir];
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        const nb = ny * this.w + nx;
        if (this.present[nb] && this.deg(nb) < 2 && !deficits.includes(nb)) deficits.push(nb);
      }
    }
    let ok = this.repair(deficits) && this.mergeToSingle();
    if (!ok) {
      this.stats.repairFails++;
      ok = this.fullResolve();
    }
    if (ok && this.monoArcChecker && !this.monoArcChecker(Array.from(this.cells.subarray(0, this.N)))) {
      ok = false;
    }
    if (!ok) {
      this.restoreFail();
      this.stats.eventMs.push(performance.now() - t0);
      return false;
    }
    this.stats.eventMs.push(performance.now() - t0);
    return true;
  }

  /** 缝回宏格 m（预排/落地双调用安全：已缝回时幂等返回 true）。失败恢复快照并返回 false。 */
  insertBlock(m: number, isSnakeCell: (c: number) => boolean): boolean {
    const cells = this.macroCells(m);
    for (const c of cells) if (isSnakeCell(c)) return false;
    if (cells.every((c) => this.present[c])) return true; // 双调用守卫
    const t0 = performance.now();
    this.snapshot();
    const deficits: number[] = [];
    for (const c of cells) {
      if (this.present[c]) continue;
      this.present[c] = 1;
      this.l0[c] = -1;
      this.l1[c] = -1;
      this.presentCount++;
      deficits.push(c);
    }
    let ok = this.repair(deficits) && this.mergeToSingle();
    if (!ok) {
      this.stats.repairFails++;
      ok = this.fullResolve();
    }
    if (ok && this.monoArcChecker && !this.monoArcChecker(Array.from(this.cells.subarray(0, this.N)))) {
      ok = false;
    }
    if (!ok) {
      this.restoreFail();
      this.stats.eventMs.push(performance.now() - t0);
      return false;
    }
    this.stats.eventMs.push(performance.now() - t0);
    return true;
  }

  /* ------------------------------------------------------------ */
  /* JIT 预热（reset 阶段调用，不计入游戏内决策预算）                   */
  /* ------------------------------------------------------------ */

  warmup(): void {
    for (let i = 0; i < 20; i++) {
      this.solveFlow();
      this.mergeToSingle();
    }
    // 预热增量路径：摘除首个自由宏格再缝回（净零变更）
    for (let m = 0; m < this.mw * this.mh; m++) {
      const cells = this.macroCells(m);
      if (cells.some((c) => this.gridBlocked[c])) continue;
      this.removeBlock(m, () => false);
      this.insertBlock(m, () => false);
      break;
    }
  }
}
