import { Game } from './game';
import { HamiltonCycle, buildHamiltonCycle } from './hamilton';
import { DegradeController, DynamicCycle, DynScheduler } from './dyn';
import { TWOFACTOR_ENGINE, TwoFactorCycle } from './twofactor';
import { astar, bfs, canReachTailInTime, floodFill, longestPath } from './search';
import { DX, DY, ScenarioConfig, StrategyId } from './types';

/**
 * 时间感知追尾判定的终局启用阈值（融合自 5.1 A 的 hybrid 模式语义）：
 * 剩余空格 ≤ 该值时，静态 BFS 到尾几乎必然误杀（蛇身盘满全场），
 * 此时才改用时间感知判定作为兜底。
 */
export const TIME_AWARE_ENDGAME = 8;

export interface StrategyDebug {
  path: number[] | null;
  cycle: HamiltonCycle | null;
  mode: string;
}

export interface Strategy {
  id: StrategyId;
  decide(game: Game): number;
  debug: StrategyDebug;
}

/* ------------------------------------------------------------------ */
/* 公共工具                                                            */
/* ------------------------------------------------------------------ */

/** 蛇头可进入的邻格：非障碍、非蛇身（蛇尾除外——尾巴本步会移开） */
function enterable(game: Game, c: number): boolean {
  if (c < 0) return false;
  if (game.reserved[c]) return false; // 动态障碍预约位（预告期不可通行；静态场景 reserved 为空数组）
  if (!game.occ[c]) return true;
  return c === game.tail && game.length > 1;
}

function freeNeighbors(game: Game): number[] {
  const out: number[] = [];
  const base = game.head * 4;
  for (let d = 0; d < 4; d++) {
    const j = game.grid.nbr[base + d];
    if (enterable(game, j)) out.push(j);
  }
  return out;
}

/** 搜索用占用图：把蛇尾视作可通行（作为终点） */
function occForSearch(game: Game): Uint8Array {
  const occ = game.occ.slice();
  if (game.length > 1) occ[game.tail] = 0;
  return occ;
}

/** 最大可达空间的邻格（兜底） */
function bestSpaceMove(game: Game): number {
  let best = -1,
    bestCount = -1;
  for (const c of freeNeighbors(game)) {
    const occ = game.occ.slice();
    occ[c] = 1;
    const { count, reachGoal } = floodFill(game.grid, occ, c, game.tail);
    const score = count + (reachGoal ? game.grid.n : 0);
    if (score > bestCount) {
      bestCount = score;
      best = c;
    }
  }
  return best;
}

/**
 * 虚拟蛇：沿路径模拟前进（含吃到食物导致的增长），
 * 到达终点后检查“新蛇头能否到达新蛇尾”。能到达 ⇒ 吃完后仍留有退路，不会被自己围死。
 * 安全判定（融合自 5.1 A）：默认静态 BFS 到尾；终局（剩余空格 ≤ TIME_AWARE_ENDGAME）
 * 静态判定失败时改用时间感知追尾判定兜底，避免盘满局面下的系统性误杀。
 */
function virtualSafe(game: Game, path: number[], strictSpace = false): boolean {
  const occ = game.occ.slice();
  const body = game.bodyCells();
  for (let i = 1; i < path.length; i++) {
    const c = path[i];
    const eat = game.foodAt[c] >= 0;
    if (!eat) {
      const t = body.shift()!;
      occ[t] = 0;
    }
    if (occ[c]) return false; // 路径与（移动中的）蛇身冲突
    body.push(c);
    occ[c] = 1;
  }
  const head = body[body.length - 1];
  const tail = body[0];
  if (body.length >= game.grid.freeCount) return true; // 吃完即通关
  occ[tail] = 0;
  if (strictSpace) {
    // 严格空间校验：吃完后所有剩余自由格必须仍从蛇头可达（不允许把空间切成孤岛）
    // count = 蛇头 + 可达自由格（含已释放的尾格）；全部可达 ⇔ count == remaining + 2
    const { count } = floodFill(game.grid, occ, head);
    const remaining = game.grid.freeCount - body.length;
    return count >= remaining + 2;
  }
  if (bfs(game.grid, occ, head, tail, true) !== null) return true;
  // 终局兜底（融合自 5.1 A 的 hybrid 模式语义）：静态判定在盘满局面下几乎必然失败，
  // 改用时间感知追尾判定；中局不启用 —— 无门槛并集会让吃食路径过于激进（实测 no-move 上升）。
  if (game.grid.freeCount - body.length <= TIME_AWARE_ENDGAME) {
    return canReachTailInTime(game.grid, body);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 1. 贪心 A*：只管最短路吃食物（AStar-Snake / snakeAIs 基线）           */
/* ------------------------------------------------------------------ */
function greedyAStar(): Strategy {
  const debug: StrategyDebug = { path: null, cycle: null, mode: '' };
  return {
    id: 'greedy-astar',
    debug,
    decide(game) {
      const occ = occForSearch(game);
      let best: number[] | null = null;
      for (const f of game.foods) {
        const p = astar(game.grid, occ, game.head, f.cell);
        if (p && (!best || p.length < best.length)) best = p;
      }
      if (best) {
        debug.path = best;
        debug.mode = 'A*→食物';
        return best[1];
      }
      debug.path = null;
      debug.mode = '无路径：空间兜底';
      return bestSpaceMove(game);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. 安全 A*：A* + 虚拟蛇校验 + 追尾（最长路径）+ 洪水填充兜底           */
/*    借鉴 stevennl/Snake 的 graph-search 策略                          */
/* ------------------------------------------------------------------ */
interface SafeOpts {
  /** 优先选择“吃完后不把剩余空间切成孤岛”的路径（找不到时回退到普通安全路径） */
  preferUnified: boolean;
  /** 饥饿逃逸：长时间未进食时交替使用最短/最长追尾路径，打破稳定的死循环排布 */
  escape: boolean;
}

function safeAStar(id: StrategyId = 'safe-astar', opts: SafeOpts = { preferUnified: false, escape: false }): Strategy {
  const debug: StrategyDebug = { path: null, cycle: null, mode: '' };
  return {
    id,
    debug,
    decide(game) {
      const occ = occForSearch(game);
      const N = game.grid.freeCount;
      // (1) 对每个食物求 A* 最短路，按长度排序后依次做虚拟蛇校验
      const cands: number[][] = [];
      for (const f of game.foods) {
        const p = astar(game.grid, occ, game.head, f.cell);
        if (p) cands.push(p);
      }
      cands.sort((a, b) => a.length - b.length);
      let fallbackSafe: number[] | null = null;
      for (const p of cands) {
        if (opts.preferUnified) {
          if (virtualSafe(game, p, true)) {
            debug.path = p;
            debug.mode = 'A*→食物（不分割空间）';
            return p[1];
          }
          if (!fallbackSafe && virtualSafe(game, p, false)) fallbackSafe = p;
        } else if (virtualSafe(game, p, false)) {
          debug.path = p;
          debug.mode = 'A*→食物（虚拟蛇校验通过）';
          return p[1];
        }
      }
      // (1b) 最短路不安全时，尝试“最长路径”绕行到食物（让蛇身重新排布后再吃），同样做虚拟蛇校验
      for (const p of cands) {
        const lp = longestPath(game.grid, occ, game.head, p[p.length - 1]);
        if (lp && lp.length > 1 && virtualSafe(game, lp, opts.preferUnified)) {
          debug.path = lp;
          debug.mode = '最长路径→食物（虚拟蛇校验通过）';
          return lp[1];
        }
      }
      if (fallbackSafe) {
        debug.path = fallbackSafe;
        debug.mode = 'A*→食物（回退：允许分割空间）';
        return fallbackSafe[1];
      }
      // (2) 追尾：沿“最长路径”走向蛇尾，尽量拖延并保持连通
      if (game.length > 1) {
        // 饥饿逃逸：每 N 步在“最长追尾 / 最短追尾”之间切换，改变蛇身排布以解锁被封住的食物
        const useShortest = opts.escape && Math.floor(game.stepsSinceFood / N) % 2 === 1;
        const lp = useShortest
          ? bfs(game.grid, occ, game.head, game.tail, true)
          : longestPath(game.grid, occ, game.head, game.tail, true);
        if (lp && lp.length > 1) {
          debug.path = lp;
          debug.mode = useShortest ? '追尾（最短路径·饥饿逃逸）' : '追尾（最长路径）';
          return lp[1];
        }
      }
      // (3) 兜底：选择可达空间最大的方向
      debug.path = null;
      debug.mode = '空间最大化兜底';
      return bestSpaceMove(game);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3/4. 哈密顿回路（纯 / 带捷径）                                       */
/* ------------------------------------------------------------------ */
function hamiltonMove(game: Game, cycle: HamiltonCycle, shortcuts: boolean, debug: StrategyDebug): number {
  const L = cycle.length;
  const idx = cycle.index;
  const tail = game.tail;
  const tIdx = idx[tail];
  const rel = (c: number) => (c === tail ? L : (idx[c] - tIdx + L) % L);
  const headRel = rel(game.head);

  // 终局规则：若相邻食物吃下后蛇长 == 可通行格数，则直接吃下即通关
  // （奇×奇地图上最后一格可能是别名格或其官方格，二者共享序号，需要此规则收尾）
  if (game.length + 1 >= game.grid.freeCount) {
    for (const c of freeNeighbors(game)) if (game.foodAt[c] >= 0) {
      debug.mode = '终局：吃下最后一格';
      return c;
    }
  }

  // 最近的“前方”食物（回路序上位于蛇头之后）+ 全部前方食物的 rel 升序（路径食物计数用）
  let foodRel = Infinity;
  const foodRels: number[] = [];
  for (const f of game.foods) {
    const r = rel(f.cell);
    if (r > headRel && r < foodRel) foodRel = r;
    if (r > headRel) foodRels.push(r);
  }
  foodRels.sort((x, y) => x - y);

  let natural = -1,
    naturalRel = Infinity;
  let best = -1,
    bestRel = -1;
  // margin：基础 2（吃食尾停一步）+ 路径食物项（落点与目标食物之间的实际食物数——
  // 落点之后到蛇尾之间的食物要等蛇沿回路经过时才吃到，不影响落点瞬间安全）。
  // 终局（剩余空格 ≤ 32）基础 2 → 1。越食档：越过最近食物落到「其后方且蛇尾前无食物」的格。
  const endgameNow = ENDGAME_MARGIN.enabled && game.grid.freeCount - game.length <= 32;
  const baseMargin = endgameNow ? 1 : 2;
  for (const c of freeNeighbors(game)) {
    const r = rel(c);
    if (r <= headRel) continue; // 只允许沿回路序单调前进 ⇒ 蛇身永远位于 [尾, 头] 区间内
    // 自然下一格（序号 +1）；若存在别名格且其上有食物则优先
    if (r < naturalRel || (r === naturalRel && game.foodAt[c] >= 0)) {
      naturalRel = r;
      natural = c;
    }
    if (!shortcuts) continue;
    // 常规档：不越过最近前方食物；裕量 = 基础 + 落点→食物间的食物数
    if (r <= foodRel) {
      let k = 0;
      for (const fr of foodRels) if (fr > r && fr < foodRel) k++;
      if (L - r >= baseMargin + k && r > bestRel) {
        bestRel = r;
        best = c;
      }
    }
  }
  // 越食档：常规档无果且前方有食物。跳过最近食物，落到 foodRel 后方、下一食物前方
  // （落点后沿回路马上遇到被跳过的食物，绕回成本低），并与蛇尾留足裕量。
  if (shortcuts && best < 0 && foodRels.length > 0) {
    const nextFoodAfterSkipped = foodRels.length > 1 ? foodRels[1] : Infinity;
    for (const c of freeNeighbors(game)) {
      const r = rel(c);
      if (r <= headRel) continue;
      // 落点必须越过最近食物（r > foodRel）且不越过第二个食物（绕回先吃被跳过的）
      if (r <= foodRel || r >= nextFoodAfterSkipped) continue;
      if (L - r >= baseMargin + 1 && r > bestRel) {
        bestRel = r;
        best = c;
      }
    }
  }
  if (shortcuts && best >= 0 && best !== natural) {
    debug.mode = `捷径 跳过 ${bestRel - headRel - 1} 格`;
    return best;
  }
  if (natural >= 0) {
    debug.mode = '沿回路';
    return natural;
  }
  debug.mode = '回路异常：空间兜底';
  return bestSpaceMove(game);
}

function hamilton(shortcuts: boolean, game: Game): Strategy {
  const cycle = buildHamiltonCycle(game.grid, game.seed);
  const debug: StrategyDebug = { path: null, cycle, mode: '' };
  const fallback = safeAStar();
  return {
    id: shortcuts ? 'hamilton-shortcut' : 'hamilton',
    debug,
    decide(g) {
      if (!cycle) {
        const m = fallback.decide(g);
        debug.path = fallback.debug.path;
        debug.mode = '无回路(有障碍)→退化为安全A*: ' + fallback.debug.mode;
        return m;
      }
      debug.path = null;
      return hamiltonMove(g, cycle, shortcuts, debug);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 5. 混合（推荐）：能建回路 → 回路+捷径（可证明安全，100% 通关）；        */
/*    不能建回路（有障碍）→ 安全 A*，并在残局用“空间+追尾”双重校验         */
/* ------------------------------------------------------------------ */
function hybrid(game: Game): Strategy {
  const cycle = buildHamiltonCycle(game.grid, game.seed);
  const debug: StrategyDebug = { path: null, cycle, mode: '' };
  const safe = safeAStar('hybrid', { preferUnified: false, escape: true });
  return {
    id: 'hybrid',
    debug,
    decide(g) {
      if (cycle) {
        debug.path = null;
        return hamiltonMove(g, cycle, true, debug);
      }
      const m = safe.decide(g);
      debug.path = safe.debug.path;
      debug.mode = '障碍地图→' + safe.debug.mode;
      return m;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 5.5 动态障碍回路（极限难度 extreme-dyn）：                            */
/*     预约位规避 + 候选验证后提交的 O(N) 重建 + p99 保险丝降级             */
/* ------------------------------------------------------------------ */
function hamiltonDyn(game: Game): Strategy {
  const debug: StrategyDebug = { path: null, cycle: null, mode: '' };
  // 基础回路由宏格生成树法构造（block 场景必可构造）
  const base = buildHamiltonCycle(game.grid, game.seed);
  const dyn = base ? new DynamicCycle(game) : null;
  if (dyn && base) {
    if (!dyn.init(Array.from(base.cells.slice(0, base.length)))) {
      debug.mode = '动态回路初始化失败';
    }
  }
  // b-主：2-factor 增量维护引擎（TWOFACTOR_ENGINE 开关，默认关闭 = 经典路径零改动）。
  // 初始化：流求解 2-factor + 圈合并成单环，失败退回生成树回路序 init。
  let tfCycle: TwoFactorCycle | null = null;
  if (TWOFACTOR_ENGINE.enabled && base) {
    const tf = new TwoFactorCycle(game);
    const order0 = Array.from(base.cells.slice(0, base.length));
    if ((tf.initFromFlow() || tf.init(order0)) && tf.verifyStructure(tf.N) === null) {
      tfCycle = tf;
    }
  }
  const coreDyn: DynamicCycle | TwoFactorCycle | null = tfCycle ?? dyn;
  const cfgDyn = game.cfg as ScenarioConfig & { dynamicObstacles?: boolean; dynPeriod?: number; dynNotice?: number; dynCount?: number };
  const budget = game.cfg.timeBudgetMs > 0 ? game.cfg.timeBudgetMs : 2;
  const controller = new DegradeController(budget);
  // 预排钩子：预约期（grid 尚未 block）重建时，把待拆宏格的 4 格临时视为占用，
  // 让 buildSpanningTreeCycle 直接产出「不含该宏格」的新回路——预排后回路 N = 自由格 −4，
  // 蛇头沿新回路走永远不会踏进预约区（预约位同时由 reserved 位图硬挡）。
  let pendingMacroCells: number[] = [];
  if (dyn) {
    dyn.rebuildFn = () => {
      // 临时视图：在 game.grid 上叠加 pendingMacroCells 的占用（借 reserved 建副本太贵，直接改 blocked 再还原）。
      // 关键 1：改 blocked 后必须 rebuildNeighbors —— buildSpanningTreeCycle 依赖预处理的
      // 邻接表，旧表含被摘宏格的内部边，会让遍历/缝合错乱恒返 null（实测 513 次全 null 根因）。
      // 关键 2：叠加全部 reserved 预约位 —— unblock 重建时若预约格（尚未落地、grid 未 block）
      // 被缝回回路，头的后继会变成预约格 → 后继异常（实测 seed 7030 死因）。
      const blocked = game.grid.blocked;
      const touched: number[] = [];
      for (const c of pendingMacroCells) {
        if (!blocked[c]) { blocked[c] = 1; touched.push(c); }
      }
      const reservedNow: number[] = [];
      for (let c = 0; c < blocked.length; c++) {
        if (game.reserved[c] && !blocked[c]) { blocked[c] = 1; reservedNow.push(c); }
      }
      if (touched.length || reservedNow.length) game.grid.rebuildNeighbors();
      try {
        // 多 seed 重试：buildSpanningTreeCycle 对部分 Prim 树形态 + 障碍布局会自检失败
        // （回路长度 ≠ 自由格数），固定 seed 遇到即永远 null（实测宏格 196 恒失败）。
        // 换 seed 重试即可命中可构造形态；确定性由「同 grid + 同 seed 序列 → 同结果」保持。
        for (let attempt = 0; attempt < 8; attempt++) {
          const cyc = buildHamiltonCycle(game.grid, game.seed + 7919 + attempt * 104729);
          if (cyc) return Array.from(cyc.cells.slice(0, cyc.length));
        }
        return null;
      } finally {
        for (const c of touched) blocked[c] = 0;
        for (const c of reservedNow) blocked[c] = 0;
        if (touched.length || reservedNow.length) game.grid.rebuildNeighbors();
      }
    };
    // 开局 JIT 预热：buildHamiltonCycle 冷启动前几十次调用含 JIT 编译尖峰（实测冷启动 p99 2.3ms，
    // 预热后 p99 0.6ms）。reset 阶段跑 50 次重建（含随机宏格变体）把热点编译完，
    // 游戏内首次 rebuild 即落在预算内。此开销发生在 startGame 前，不计入游戏内决策预算。
    {
      const realFn = dyn.rebuildFn;
      for (let i = 0; i < 50; i++) realFn();
    }
    // 单调弧校验：蛇身格在新回路上必须仍是尾→头单调弧（否则策略不变量破坏，拒绝重建）
    dyn.monoArcChecker = (order: number[]) => {
      const newIdx = new Int32Array(game.grid.n).fill(-1);
      order.forEach((c, i) => (newIdx[c] = i));
      const body = game.bodyCells();
      const L = body.length;
      if (L <= 1) return true;
      const hIdx = newIdx[body[L - 1]];
      let prevDist = -1;
      for (let i = 0; i < L; i++) {
        if (newIdx[body[i]] < 0) return false; // 蛇身格不在新回路上
        const dist = (hIdx - newIdx[body[i]] + order.length) % order.length;
        if (i > 0 && dist >= prevDist) return false; // 必须严格递减
        prevDist = dist;
      }
      return true;
    };
  }
  // b 引擎接线（TWOFACTOR_ENGINE 开启且初始化成功时）：复用生成树构造作 fullResolve
  // 最终兜底 + 同一单调弧判据 + JIT 预热。事件回调与决策消费 coreDyn（tf 优先）。
  if (tfCycle) {
    const tf = tfCycle;
    tf.rebuildFn = () => {
      // 按 tf 支持集叠加临时视图：不在支持集的格全部视为占用
      const blocked = game.grid.blocked;
      const touched: number[] = [];
      for (let c = 0; c < blocked.length; c++) {
        if (!tf.present[c] && !blocked[c]) { blocked[c] = 1; touched.push(c); }
      }
      if (touched.length) game.grid.rebuildNeighbors();
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const cyc = buildHamiltonCycle(game.grid, game.seed + 7919 + attempt * 104729);
          if (cyc) return Array.from(cyc.cells.slice(0, cyc.length));
        }
        return null;
      } finally {
        for (const c of touched) blocked[c] = 0;
        if (touched.length) game.grid.rebuildNeighbors();
      }
    };
    tf.monoArcChecker = (order: number[]) => {
      const newIdx = new Int32Array(game.grid.n).fill(-1);
      order.forEach((c, i) => (newIdx[c] = i));
      const body = game.bodyCells();
      const L = body.length;
      if (L <= 1) return true;
      const hIdx = newIdx[body[L - 1]];
      let prevDist = -1;
      for (let i = 0; i < L; i++) {
        if (newIdx[body[i]] < 0) return false;
        const dist = (hIdx - newIdx[body[i]] + order.length) % order.length;
        if (i > 0 && dist >= prevDist) return false;
        prevDist = dist;
      }
      return true;
    };
    tf.warmup();
  }
  // 预约回调（grid 未变时调用）：预排重建——新回路直接跳过待拆宏格。
  // 拒绝条件：4 格有蛇身，或预排后蛇身非单调弧。
  // 蛇身判定直接用 occ 位图（O(1)、零分配）。
  const onReserve = (macro: number): boolean => {
    if (!coreDyn) return false;
    const occ = game.occ;
    const mw = game.grid.w / 2;
    const a = (macro % mw) * 2 + ((macro / mw) | 0) * 2 * game.grid.w;
    pendingMacroCells = [a, a + 1, a + game.grid.w, a + game.grid.w + 1];
    try {
      return coreDyn.removeBlock(macro, (c) => occ[c] === 1);
    } finally {
      pendingMacroCells = [];
    }
  };
  const scheduler = game.dynamic
    ? new DynScheduler(game, game.seed, cfgDyn.dynCount ?? 2, cfgDyn.dynPeriod ?? 40, cfgDyn.dynNotice ?? 15)
    : null;
  if (scheduler) {
    scheduler.onReserve = onReserve;
    const validateCommittedView = (): boolean => {
      if (!coreDyn) return false;
      const support = new Uint8Array(game.grid.n);
      for (let c = 0; c < game.grid.n; c++) {
        support[c] = !game.grid.blocked[c] && !game.reserved[c] ? 1 : 0;
      }
      // DynamicCycle 检查精确支持集；TwoFactorCycle 的同名校验器会忽略额外参数，
      // 其 present 支持集已由 insert/remove 事务维护。
      const verify = coreDyn.verifyStructure as (n: number, expectedSupport?: Uint8Array) => string | null;
      return verify.call(coreDyn, coreDyn.N, support) === null;
    };
    // 预约期已经把候选回路提交为“落地后视图”；正式落地只需验证，无需再做一次
    // 可能失败的重复重建。这样 grid 与回路不会在第二次构造失败时分叉。
    scheduler.onBlocked = () => validateCommittedView();
    // unblock（grid 尚未 unblock 时调用）：预排重建——新回路包含将恢复的宏格
    scheduler.onUnblock = (macro: number): boolean => {
      if (!coreDyn) return false;
      const occ = game.occ;
      // b 引擎：支持集是内部状态，不读 grid，无需临时解除 blocked
      if (tfCycle) return tfCycle.insertBlock(macro, (c) => occ[c] === 1);
      const mw = game.grid.w / 2;
      const a = (macro % mw) * 2 + ((macro / mw) | 0) * 2 * game.grid.w;
      // unblock 预排：临时解除 grid.blocked 让重建包含该宏格（改后必须 rebuildNeighbors，
      // 理由同 rebuildFn——邻接表必须与 blocked 一致）
      const blocked = game.grid.blocked;
      const cells = [a, a + 1, a + game.grid.w, a + game.grid.w + 1];
      const touched: number[] = [];
      for (const c of cells) if (blocked[c]) { blocked[c] = 0; touched.push(c); }
      if (touched.length) game.grid.rebuildNeighbors();
      try {
        return dyn!.insertBlock(macro, (c) => occ[c] === 1);
      } finally {
        for (const c of touched) blocked[c] = 1;
        if (touched.length) game.grid.rebuildNeighbors();
      }
    };
    // onUnblock 已按未来自由视图完成预排；落地后只校验提交视图。
    scheduler.onUnblocked = () => validateCommittedView();
  }
  let lastStep = -1;
  let anomalyStreak = 0;

  /** 决策前的调度推进（同一 game.step 只推进一次） */
  const sync = () => {
    if (!scheduler || game.steps === lastStep) return;
    lastStep = game.steps;
    scheduler.tick();
  };

  return {
    id: 'hamilton-dyn',
    debug,
    decide(g: Game) {
      const t0 = performance.now();
      const walksBefore = coreDyn ? coreDyn.walkCount : 0;
      sync();
      let move: number;
      let ok = true;
      if (!coreDyn) {
        move = bestSpaceMove(g);
        debug.mode = '无回路→空间兜底';
        ok = false;
      } else if (controller.degraded) {
        // 「安全优先」降级：纯回路前进（O(1)，最保守），禁捷径。
        // 滞回恢复（d-4）：降级满 recoverySteps 且观察期无新 spike → 恢复正常模式；
        // 恢复成功的那一步即走正常捷径（落到下方 else 不行——本步已离开 degraded 分支）。
        if (controller.tryRecover(g.steps)) {
          ok = cycleStep(g, coreDyn, true, debug);
          move = g.lastCandidate;
          debug.mode = '滞回恢复: ' + debug.mode;
        } else {
          ok = cycleStep(g, coreDyn, false, debug);
          move = g.lastCandidate;
          debug.mode = '降级·安全优先: ' + debug.mode;
        }
      } else {
        ok = cycleStep(g, coreDyn, true, debug);
        move = g.lastCandidate;
      }
      if (!ok) {
        anomalyStreak++;
        if (anomalyStreak >= 5) controller.force('anomaly', g.steps);
      } else {
        anomalyStreak = 0;
      }
      controller.sample(performance.now() - t0, coreDyn ? coreDyn.walkCount - walksBefore : 0);
      controller.check(g.steps);
      if (controller.degraded && controller.degradeStep === g.steps) {
        debug.mode = `触发降级(${controller.reason})：下一步切安全优先`;
      }
      return move;
    },
    // 观测钩子（验收脚本/调试用，非 Strategy 接口字段）
    _dyn: (coreDyn ?? undefined) as DynamicCycle | undefined,
    _tf: tfCycle ?? undefined,
    _controller: controller,
    _scheduler: scheduler ?? undefined,
  } as Strategy & { _dyn?: DynamicCycle; _tf?: TwoFactorCycle; _controller?: DegradeController; _scheduler?: DynScheduler };
}

/** 可变回路上的 O(1) 单调序步进（含预约位规避与捷径）。
 * 不变量：蛇身是回路上头→尾的连续弧。头每步走「拓扑后继 next[head]」或完整捷径条件的格子；
 * 后继被预约位/障碍挡住的情况由拆块（removeBlock）在预约时提前改写拓扑解决，不应在此发生；
 * 若发生（拓扑异常），走空间兜底并返回 false 供上层计数。
 * 注意：succ 必须用 next[head]（拓扑真后继）而非 rel==1 的邻格 —— insertBlock 的短弧接入
 * 会让局部环流反向，重编号后 next[head] 的序号不一定是 hi+1。 */
/** cycleStep 的固定候选缓冲（每策略实例一份，零分配）：最多 4 个邻格，存 [cell, rel, idx] 三元组 */
const candBuf: Int32Array = new Int32Array(12);

/** 越食捷径开关（A/B 基准用；验收目标 ↓≥5% 步数的实验项） */
export const OVERFOOD_SHORTCUT = { enabled: false };
/** 终局 margin 收窄开关（同上，与越食档独立） */
export const ENDGAME_MARGIN = { enabled: false };

function cycleStep(g: Game, core: { idx: Int32Array; next: Int32Array; N: number }, shortcuts: boolean, debug: StrategyDebug): boolean {
  const { idx, next, N } = core;
  const head = g.head;
  const hi = idx[head];
  const tail = g.tail;
  const ti = idx[tail];
  // gap = 头沿回路到尾的前向距离（尾悬空时视为整圈）
  const gap = ti >= 0 ? (ti - hi + N) % N || N : N;
  const base = head * 4;
  // 候选 = 四邻中可通行（非障碍/非预约位、非蛇身——尾格除外：头进尾格合法，尾巴同时让开）
  // 且在回路上的格子。终局 gap==1 时拓扑后继恰为尾格，不放行会误判后继异常并在满盘前死锁。
  const topoSucc = next[head];
  let succ = -1; // 拓扑后继（需可通行且与头相邻）
  let nCand = 0; // 固定缓冲长度指针（零分配）
  for (let d = 0; d < 4; d++) {
    const c = g.grid.nbr[base + d];
    if (c < 0) continue;
    if (g.occ[c] && !(c === tail && g.length > 1)) continue;
    if (g.grid.blocked[c] || g.reserved[c]) continue;
    const r = idx[c];
    if (r < 0) continue; // 悬空格不可踩
    const rel = (r - hi + N) % N;
    if (rel === 0) continue;
    if (succ < 0 && c === topoSucc) succ = c;
    candBuf[nCand * 3] = c;
    candBuf[nCand * 3 + 1] = rel;
    candBuf[nCand * 3 + 2] = r;
    nCand++;
  }
  if (succ < 0) {
    // 拓扑后继被挡/不在邻域：拓扑异常（挡住的情况应由拆块提前处理）
    g.lastCandidate = nCand > 0 ? candBuf[0] : bestSpaceMove(g);
    debug.mode = nCand > 0 ? '后继异常：空间兜底' : '无候选：空间兜底';
    return false;
  }
  // 捷径（两档）：
  // 常规档：rel 最大且（不越过最近前方食物、gap − rel ≥ margin）。安全裕量证明见报告 I3。
  // 越食档（条件性）：若常规档无候选，允许越过前方食物（跳过后沿回路绕回再吃），
  // 但需 gap − rel ≥ margin + 食物数 × 2（多绕一圈的裕量）。
  // OVERFOOD_SHORTCUT 开关供 A/B 基准（验收要求 vs 基线 ↓≥5%）。
  // 裕量必须用 rel（相对蛇尾）计算 —— 绝对 idx 在动态重编号后起点任意（实测自围根因）。
  let best = -1;
  if (shortcuts) {
    let foodRel = Infinity;
    let nFoodAhead = 0;
    for (const f of g.foods) {
      const rf = idx[f.cell];
      if (rf >= 0) {
        const rel = (rf - hi + N) % N;
        if (rel > 0 && rel < gap) {
          nFoodAhead++;
          if (rel < foodRel) foodRel = rel;
        }
      }
    }
    // margin 组成：基础 2（吃食尾停一步）+ 路径食物项。原实现用全场食物数（5 食物场景=7）
    // 过度保守——落点与目标食物之间实际只经过 k 个食物（尾巴停 k 步），落点之后到蛇尾
    // 之间的食物要等蛇沿回路经过时才吃到，不影响落点瞬间安全。按候选逐个算 k。
    // 终局（剩余空格 ≤ 32）基础 2 → 1：蛇身盘满时尾巴让开节奏固定（canReachTailInTime 回路版）。
    const endgameNow = ENDGAME_MARGIN.enabled && g.grid.freeCount - g.length <= 32;
    const baseMargin = endgameNow ? 1 : 2;
    // 各前方食物的 rel 升序（供路径食物计数）
    const foodRels: number[] = [];
    for (const f of g.foods) {
      const rf = idx[f.cell];
      if (rf >= 0) {
        const rel = (rf - hi + N) % N;
        if (rel > 0 && rel < gap) foodRels.push(rel);
      }
    }
    foodRels.sort((x, y) => x - y);
    // 常规档：目标食物 = foodRel（最近前方食物），落点 rel 越大越省
    for (let i = nCand - 1; i >= 0; i--) {
      const c = candBuf[i * 3];
      const rel = candBuf[i * 3 + 1];
      if (rel > foodRel) continue; // 不越过最近前方食物
      let k = 0; // 落点到目标食物之间的食物数（尾巴将停 k 步）
      for (const fr of foodRels) if (fr > rel && fr < foodRel) k++;
      if (gap - rel >= baseMargin + k) {
        best = c;
        break;
      }
    }
    // 越食档：常规档无果且前方确有食物。跳过最近食物落到它后方——安全性要求落点之后、
    // 蛇尾之前不再有食物（若还有，沿回路先遇到它，直接走自然步更优，不该跳）。
    if (OVERFOOD_SHORTCUT.enabled && best < 0 && nFoodAhead > 0) {
      for (let i = nCand - 1; i >= 0; i--) {
        const c = candBuf[i * 3];
        const rel = candBuf[i * 3 + 1];
        let foodBeyond = false; // rel 之后是否还有食物
        for (const fr of foodRels) if (fr > rel) { foodBeyond = true; break; }
        if (foodBeyond) continue;
        if (gap - rel >= baseMargin) {
          best = c;
          break;
        }
      }
    }
  }
  if (best >= 0 && best !== succ) {
    debug.mode = '捷径';
    g.lastCandidate = best;
    return true;
  }
  debug.mode = '沿回路';
  g.lastCandidate = succ;
  return true;
}

/* ------------------------------------------------------------------ */
/* 6. 手动控制（融合自 3.1 的手动模式）：方向键/WASD 队列输入            */
/* ------------------------------------------------------------------ */
const manualQueue: number[] = [];

/** UI 层在按键时调用（0=上 1=右 2=下 3=左），最多缓存 3 个意图 */
export function pushManualDir(d: 0 | 1 | 2 | 3) {
  if (manualQueue.length < 3) manualQueue.push(d);
}

/** 新开一局时清空按键缓存 */
export function clearManualQueue() {
  manualQueue.length = 0;
}

function manual(): Strategy {
  const debug: StrategyDebug = { path: null, cycle: null, mode: '' };
  return {
    id: 'manual',
    debug,
    decide(game) {
      const head = game.head;
      const hx = game.grid.x(head),
        hy = game.grid.y(head);
      // 当前朝向由蛇身推导（头 - 脖颈），状态无关
      let curDir = 1;
      if (game.length > 1) {
        const neck = game.bodyCells()[game.length - 2];
        const dx = hx - game.grid.x(neck),
          dy = hy - game.grid.y(neck);
        if (dy === -1) curDir = 0;
        else if (dx === 1) curDir = 1;
        else if (dy === 1) curDir = 2;
        else if (dx === -1) curDir = 3;
      }
      // 从队列取第一个「非反向」的意图（反向 = 掉头撞脖颈，直接丢弃）
      while (manualQueue.length) {
        const d = manualQueue.shift()! as 0 | 1 | 2 | 3;
        if (game.length > 1 && d === ((curDir + 2) & 3)) continue;
        debug.mode = '手动';
        return game.grid.idx(hx + DX[d], hy + DY[d]);
      }
      debug.mode = '手动（直行）';
      return game.grid.idx(hx + DX[curDir], hy + DY[curDir]);
    },
  };
}

/* ------------------------------------------------------------------ */

export function createStrategy(id: StrategyId, game: Game): Strategy {
  switch (id) {
    case 'greedy-astar':
      return greedyAStar();
    case 'safe-astar':
      return safeAStar();
    case 'hamilton':
      return hamilton(false, game);
    case 'hamilton-shortcut':
      return hamilton(true, game);
    case 'hybrid':
      return hybrid(game);
    case 'hamilton-dyn':
      return hamiltonDyn(game);
    case 'manual':
      return manual();
  }
}
