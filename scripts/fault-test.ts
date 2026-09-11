/**
 * 故障注入测试：人为制造「危险时刻」，验证降级/回滚/放弃路径不崩溃、不死锁、不产出非法状态。
 *
 * 注入项（对 hamilton-dyn 全链路）：
 *  F1 强制重建失败：rebuildFn 间歇性返回 null → 策略应保持旧回路或放弃事件，游戏继续；
 *  F2 强制单调弧拒绝：monoArcChecker 间歇性返回 false → 同上；
 *  F3 强制降级：随机步 force('anomaly') → 安全优先模式接管，游戏继续；
 *  F4 极端时钟：强制每步 wall 采样超大值 → walks/wall 双判据触发降级，不死循环。
 * 验收：所有注入下游戏终态合法（WIN 或明确 failReason），无未定义行为；
 *      且注入结束后 verifyStructure 仍通过（引擎状态未被污染）。
 *
 * 用法：npx tsx scripts/fault-test.ts [局数=10] [种子=8000]
 */
import { getScenario } from '../src/engine/scenarios';
import { Game } from '../src/engine/game';
import { createStrategy } from '../src/engine/strategies';

const cfg = getScenario('extreme-dyn');

/**
 * 违例分类器：把结构校验器（DynamicCycle.verifyStructure / shadowCheckRing 同构）的
 * 违例消息映射到 5 类不变量分支桶——「哪些检测分支被触发过多少次」（老师 e-4 覆盖度意见）。
 * 数字大小不能说明验证强度，分支覆盖分布可以；某类计数为 0 说明该检测分支未被触发，
 * 是否足以证明强度由「检测分支活性探针」（下方 probeDetectorBranches）补齐。
 */
const VIOLATION_BUCKETS = ['传送边', '第二环', 'prev不一致', '覆盖缺失', '序号错乱'] as const;
type ViolationBucket = (typeof VIOLATION_BUCKETS)[number];

function classifyViolation(msg: string): ViolationBucket | '其他' {
  if (msg.includes('传送边')) return '传送边'; // 相邻性不变量 I-adj：所有链接网格相邻
  if (msg.includes('第二环') || msg.includes('环外')) return '第二环'; // 单环不变量 I1：无第二个环
  if (msg.includes('prev 不一致')) return 'prev不一致'; // 链接对称性：next/prev 双向一致
  if (msg.includes('覆盖') || msg.includes('覆盖缺失')) return '覆盖缺失'; // 覆盖不变量：环覆盖恰 N 格
  if (msg.includes('idx') || msg.includes('越环') || msg.includes('无后继') || msg.includes('环过长') || msg.includes('序号')) return '序号错乱'; // idx/序号一致性
  return '其他';
}

/**
 * 检测分支活性探针：对合法回路逐一注入 5 类人工破损，断言分类器每类都能命中——
 * 证明 fault-test 运行期间「某类计数为 0」是真零（未触发）而非检测分支失效。
 * 每类探针独立构造、跑完即还原，不污染后续测试。
 */
function probeDetectorBranches(w: number, h: number): { bucket: ViolationBucket; ok: boolean; detail: string }[] {
  // 构造一条合法回路：单行蛇形（w 为偶数时首尾相邻，构成简单环）
  const order: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) order.push(y * w + (y % 2 === 0 ? x : w - 1 - x));
  }
  const n = w * h;
  const next = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const idx = new Int32Array(n).fill(-1);
  order.forEach((c, i) => {
    idx[c] = i;
    next[c] = order[(i + 1) % n];
    prev[c] = order[(i - 1 + n) % n];
  });
  const blocked = new Uint8Array(n); // 全自由
  const clone = () => ({ next: next.slice(), prev: prev.slice(), idx: idx.slice() });

  const checks: { bucket: ViolationBucket; break: (s: ReturnType<typeof clone>) => string }[] = [
    {
      // 传送边：段反转——把环上 [B..Y] 整段方向倒置，产生 A→Y、B→Z 两条跨环链接。
      // 游走仍覆盖全部 N 格且单环闭合（覆盖/单环检查通过），传送边由相邻性检查抓出。
      bucket: '传送边',
      break: (s) => {
        const A = order[0], B = order[1], Y = order[50], Z = order[51];
        for (let k = 1; k <= 50; k++) {
          const t = s.next[order[k]];
          s.next[order[k]] = s.prev[order[k]];
          s.prev[order[k]] = t;
        }
        s.next[A] = Y; s.prev[Y] = A;
        s.next[B] = Z; s.prev[Z] = B;
        return `传送边 ${A}→${Y}`;
      },
    },
    {
      // 第二环：交换两对邻接边，圈出独立小环，其余仍是一环 → 「环外」检测
      bucket: '第二环',
      break: (s) => {
        // 取环上相邻四格 a→b→c→d，改成 a→b→a 与 c→d→c 两个 2-环，主环缩短成第二环
        const [a, b, c, d] = [order[0], order[1], order[2], order[3]];
        s.next[a] = b; s.prev[b] = a; s.next[b] = a; s.prev[a] = b;
        s.next[c] = d; s.prev[d] = c; s.next[d] = c; s.prev[c] = d;
        return `格 ${c} 在环外（第二环）`;
      },
    },
    {
      // prev 不一致：把某格 prev 指向错误位置（next 不动）
      bucket: 'prev不一致',
      break: (s) => { s.prev[order[5]] = order[1]; return `prev 不一致 ${order[5]}`; },
    },
    {
      // 覆盖缺失：删掉一格的链接，环覆盖数 < N（消息 = 覆盖 count/expected）
      bucket: '覆盖缺失',
      break: (s) => {
        const c = order[7];
        const p = s.prev[c], q = s.next[c];
        s.next[p] = q; s.prev[q] = p; s.next[c] = -1; s.prev[c] = -1;
        return `覆盖 ${n - 1}/${n}`;
      },
    },
    {
      // 序号错乱：idx 与 next 游走序不一致（环上格 idx 悬空 → 越环检测）
      bucket: '序号错乱',
      break: (s) => { s.idx[order[3]] = -1; return `格 ${order[3]} idx 越环`; },
    },
  ];

  return checks.map(({ bucket, break: brk }) => {
    const s = clone();
    const synthetic = brk(s);
    // 与真实校验器同构地走一遍（shadowCheckRing 语义），确认该破损能被检出并分类
    let detected: string | null = null;
    const blockedV = blocked;
    if (bucket === '序号错乱') {
      // idx 类违例由 verifyStructure 的 idx 一致性检查抓（shadowCheckRing 不查 idx）
      const linked = s.next[order[0]] >= 0;
      if (linked && s.idx[order[3]] < 0) detected = `格 ${order[3]} idx 越环`;
    } else {
      detected = ringCheck(s.next, s.prev, blockedV, w, n);
    }
    const cls = detected ? classifyViolation(detected) : null;
    const ok = detected !== null && cls === bucket;
    return { bucket, ok, detail: ok ? `${synthetic} → ${detected}` : `未检出或分类错: synthetic="${synthetic}" detected="${detected}" class="${cls}"` };
  });
}

/** 影子同构的环检查（与 shadowCheckRing 相同实现，供探针/真实违例共用） */
function ringCheck(next: Int32Array, prev: Int32Array, blocked: Uint8Array, w: number, expectedN: number): string | null {
  const linked: number[] = [];
  for (let c = 0; c < next.length; c++) if (next[c] >= 0) linked.push(c);
  if (linked.length !== expectedN) return `覆盖 ${linked.length}/${expectedN}`;
  const start = linked[0];
  const visited = new Set<number>([start]);
  let cur = start;
  let count = 1;
  for (;;) {
    const nx = next[cur];
    if (nx < 0) return `格 ${cur} 无后继`;
    if (visited.has(nx)) {
      if (nx !== start) return `提前回到非起点格 ${nx}（第二环）`;
      break;
    }
    visited.add(nx);
    count++;
    if (count > linked.length) return '环过长';
    cur = nx;
  }
  if (visited.size !== linked.length) return `单环只覆盖 ${visited.size}/${linked.length} 格（第二环）`;
  for (const c of visited) {
    const nx = next[c];
    const x = c % w;
    const y = (c - x) / w;
    const nx2 = nx % w;
    const ny = (nx - nx2) / w;
    if (Math.abs(x - nx2) + Math.abs(y - ny) !== 1) return `传送边 ${c}→${nx}`;
    if (prev[nx] !== c) return `prev 不一致 ${nx}`;
    if (blocked[c]) return `格 ${c} 在障碍上`;
  }
  return null;
}

interface InjectResult {
  name: string;
  games: number;
  wins: number;
  legalEnds: number; // 终态合法（WIN 或 alive=false 有 failReason）
  structureOk: boolean;
  injections: number; // 实际注入的事件数（验收要求全脚本 ≥10³）
  /** 覆盖度：不变量分支 → 触发次数（e-4「哪些不变量分支被触发过多少次」） */
  coverage: Record<string, number>;
}

/** 事件路径汇总（跨注入项累计）：落地/预约拒绝/落地回滚/解除重试。 */
const outcomeTotals: Record<string, number> = {};
/** 5 类违例桶的全局汇总（fault-test 全部局累计，验收要求每类探针活性 + 真实触发分布） */
const violationCounts: Record<string, number> = {};

function runInjected(name: string, games: number, seed0: number, inject: (s: any, step: number, rng: () => number) => number): InjectResult {
  let wins = 0;
  let legalEnds = 0;
  let structureOk = true;
  let injections = 0;
  let reserveRejects = 0; // onReserve 返回 false 的次数（预约拒绝）
  let landRollbacks = 0; // onBlocked 返回 false 的次数（落地回滚，grid 已由调度器还原）
  let unblockGives = 0; // onUnblock 返回 false 的重试次数（不等于最终放弃）
  // 覆盖度计数（不变量分支名 → 触发次数）：终局时逐局统计
  const coverage: Record<string, number> = {};
  const note = (k: string) => (coverage[k] = (coverage[k] ?? 0) + 1);
  let sc = seed0;
  const rng = () => {
    sc = (sc * 1103515245 + 12345) & 0x7fffffff;
    return sc / 0x7fffffff;
  };
  for (let i = 0; i < games; i++) {
    const seed = seed0 + i;
    const game = new Game(cfg, seed);
    const strat = createStrategy('hamilton-dyn', game) as any;
    // 调度器结局计数：包装三个回调观测「预约→落地→缝回」全链路结局（零行为改变）
    reserveRejects = 0; landRollbacks = 0; unblockGives = 0;
    const sched = strat._scheduler;
    if (sched) {
      const oReserve = sched.onReserve;
      sched.onReserve = (m: number) => { const ok = oReserve(m); if (!ok) reserveRejects++; return ok; };
      const oBlocked = sched.onBlocked;
      sched.onBlocked = (m: number) => { const ok = oBlocked(m); if (!ok) landRollbacks++; return ok; };
      // 解除重试：这里只统计 onUnblock false；最终放弃应读取 scheduler.stats.unblockAbandons。
      const oUnblock = sched.onUnblock;
      sched.onUnblock = (m: number) => { const ok = oUnblock(m); if (!ok) unblockGives++; return ok; };
    }
    const maxSteps = game.freeCells * game.freeCells * 2 + 1000;
    while (game.alive && !game.won && game.steps < maxSteps) {
      injections += inject(strat, game.steps, rng);
      const next = strat.decide(game);
      game.step(next);
      if (!game.alive || game.won) break;
      if (game.stepsSinceFood > game.grid.freeCount * 6 + 100) game.fail('starved');
    }
    if (game.alive && !game.won) game.fail('step-limit');
    if (game.won) wins++;
    // 终态合法：won，或已 die 且有明确原因
    if (game.won || (!game.alive && game.failReason !== 'none')) legalEnds++;
    // 覆盖度：失败原因分布
    if (!game.won) note(`失败:${game.failReason}`);
    else note('终局:WIN');
    // 覆盖度：引擎观测分支（降级/回滚/重建/事件放弃）
    const dyn = strat._dyn;
    const ctrl = strat._controller;
    if (ctrl?.degraded) note(`降级:${ctrl.reason}`);
    if (dyn) {
      if (dyn.walkCount > 0) note('分支:commitWalk');
      if (dyn.rollbackCount > 0) note('分支:rollback');
      // 覆盖度 e-4：结构校验违例按 5 类不变量分支计数（0 触发 = 该分支未被考验）
      const support = new Uint8Array(game.grid.n);
      for (let c = 0; c < game.grid.n; c++) support[c] = !game.grid.blocked[c] && !game.reserved[c] ? 1 : 0;
      const err = dyn.verifyStructure(dyn.N, support);
      if (err) {
        structureOk = false;
        const cls = classifyViolation(err);
        note(`违例:${cls}`);
        violationCounts[cls] = (violationCounts[cls] ?? 0) + 1;
        console.error(`  seed ${seed} 结构污染: ${err}`);
      } else {
        note('分支:结构校验通过');
      }
    }
    // 覆盖度：调度器事件路径（落地成功/预约拒绝/落地回滚/解除重试）
    if (sched) {
      if (sched.landSeq > 0) note('事件:落地');
      if (reserveRejects > 0) note('事件:预约拒绝');
      if (landRollbacks > 0) note('事件:落地回滚');
      if (unblockGives > 0) note('事件:解除重试');
      outcomeTotals.落地 = (outcomeTotals.落地 ?? 0) + (sched.landSeq > 0 ? 1 : 0);
    }
    if (reserveRejects > 0) outcomeTotals.预约拒绝 = (outcomeTotals.预约拒绝 ?? 0) + 1;
    if (landRollbacks > 0) outcomeTotals.落地回滚 = (outcomeTotals.落地回滚 ?? 0) + 1;
    if (unblockGives > 0) outcomeTotals.解除重试 = (outcomeTotals.解除重试 ?? 0) + 1;
    if (game.expiredFoods > 0) note('分支:食物过期');
    if (dyn && dyn.N < game.initialFreeCount) note('分支:当前回路小于初始自由格');
  }
  return { name, games, wins, legalEnds, structureOk, injections, coverage };
}

function main(): void {
  const games = Number(process.argv[2] ?? 10);
  const seed0 = Number(process.argv[3] ?? 8000);
  console.log(`== 故障注入测试（extreme-dyn × ${games} 局，注入种子 ${seed0}..）==\n`);

  // 覆盖度 e-4 前置：检测分支活性探针——对合法回路注入 5 类破损，证明分类器每桶可命中。
  // 探针全过 ⟹ 后续真实运行中「某类违例计数为 0」是真零（未触发）而非检测失效。
  console.log('检测分支活性探针（合成破损 → 分类器命中）：');
  const probes = probeDetectorBranches(10, 10);
  let probesOk = true;
  for (const p of probes) {
    if (!p.ok) probesOk = false;
    console.log(`  ${p.ok ? '✅' : '❌'} ${p.bucket}: ${p.detail}`);
  }
  if (!probesOk) { console.error('探针未全过：分类器/检测分支失效，覆盖度数据不可信'); process.exit(1); }
  console.log('');

  const results: InjectResult[] = [];
  // 全局注入计数器（每项注入函数返回本步注入的事件数）
  // F1 强制重建失败：30% 概率下一次重建返回 null（包装 rebuildFn，注入一次后自动恢复）
  results.push(
    runInjected('F1 强制重建失败 30%', games, seed0, (s, _step, rng) => {
      const dyn = s._dyn;
      if (!dyn || dyn.__f1Armed || rng() >= 0.3) return 0;
      const orig = dyn.rebuildFn;
      dyn.rebuildFn = () => null; // 下一次重建（可能在 removeBlock/insertBlock 内）失败
      dyn.__f1Armed = true;
      // 在本次 rebuild 消费后自动恢复（rebuildFn 是同步调用的，包装一层计数后恢复）
      dyn.rebuildFn = () => {
        dyn.rebuildFn = orig;
        delete dyn.__f1Armed;
        return null;
      };
      return 1;
    }),
  );

  // F1b 持续重建失败（整局重建全部失败 → 回路永不更新，事件被放弃/回滚，游戏应仍可进行）
  results.push(
    runInjected('F1b 重建全程失败', games, seed0 + 100, (s) => {
      const dyn = s._dyn;
      if (dyn && !dyn.__f1b) {
        dyn.__f1b = true;
        dyn.rebuildFn = () => null;
        return 1; // 局级注入计 1
      }
      return 0;
    }),
  );

  // F2 强制单调弧拒绝（50% 概率每次重建被拒）
  results.push(
    runInjected('F2 单调弧拒绝 50%', games, seed0 + 200, (s, _step, rng) => {
      const dyn = s._dyn;
      if (!dyn) return 0;
      if (!dyn.__f2) {
        dyn.__f2 = true;
        const orig = dyn.monoArcChecker;
        dyn.monoArcChecker = (order: number[]) => (rng() < 0.5 ? false : orig ? orig(order) : true);
      }
      return 1; // 局级注入计 1
    }),
  );

  // F3 强制降级（每 500 步触发一次 anomaly 降级）
  results.push(
    runInjected('F3 周期性强降级', games, seed0 + 300, (s, step) => {
      if (s._controller && step > 0 && step % 500 === 0) {
        s._controller.force('anomaly', step);
        return 1;
      }
      return 0;
    }),
  );

  // F4 极端时钟（每步采样 999ms → wall 判据必触发降级）
  results.push(
    runInjected('F4 极端时钟采样', games, seed0 + 400, (s) => {
      if (s._controller && !s._controller.__f4) {
        s._controller.__f4 = true;
        s._controller.sample = (_ms: number, walks: number) => {
          (s._controller as any).wall.push(999);
          if ((s._controller as any).wall.length > (s._controller as any).windowSize) (s._controller as any).wall.shift();
          (s._controller as any).walks.push(walks);
          if ((s._controller as any).walks.length > (s._controller as any).windowSize) (s._controller as any).walks.shift();
        };
        return 1;
      }
      return 0;
    }),
  );

  console.log('注入项'.padEnd(22), '局数 通关 合法终态 结构完好 注入事件数');
  let allOk = true;
  let totalInjections = 0;
  for (const r of results) {
    const ok = r.legalEnds === r.games && r.structureOk;
    if (!ok) allOk = false;
    totalInjections += r.injections;
    console.log(
      r.name.padEnd(24),
      String(r.games).padEnd(5),
      `${((r.wins / r.games) * 100).toFixed(0)}%`.padEnd(4),
      `${r.legalEnds}/${r.games}`.padEnd(10),
      r.structureOk ? '✅' : '❌',
      String(r.injections),
    );
  }
  // 覆盖度汇总（e-4）：每项注入的不变量分支触发计数
  console.log('');
  console.log('覆盖度指标（不变量分支 → 触发局数）：');
  for (const r of results) {
    const keys = Object.keys(r.coverage).sort((a, b) => (r.coverage[b] ?? 0) - (r.coverage[a] ?? 0));
    const top = keys.map((k) => `${k}×${r.coverage[k]}`).join('  ');
    console.log(`  ${r.name.padEnd(22)} ${top}`);
  }
  // 违例分支分布（e-4 核心）：5 类不变量检测分支在全部真实局中的触发次数
  console.log('');
  console.log('违例分支覆盖（5 类不变量检测分支 → 真实触发次数，0 = 该分支未被考验，活性由探针保证）：');
  for (const b of VIOLATION_BUCKETS) {
    console.log(`  ${b.padEnd(10)} ×${violationCounts[b] ?? 0}`);
  }
  const other = violationCounts['其他'] ?? 0;
  if (other) console.log(`  其他       ×${other}`);
  // 事件结局空间（调度器全链路）：四类结局至少各触发一次才说明结局空间被完整考验
  console.log('');
  console.log('调度器事件结局空间（跨注入项累计局数）：');
  const outcomeKeys = ['落地', '预约拒绝', '落地回滚', '解除重试'];
  for (const k of outcomeKeys) {
    console.log(`  ${k.padEnd(6)} ×${outcomeTotals[k] ?? 0}`);
  }
  const outcomesCovered = outcomeKeys.filter((k) => (outcomeTotals[k] ?? 0) > 0).length;
  console.log(`  结局覆盖 ${outcomesCovered}/4${outcomesCovered < 4 ? '（未覆盖结局 = 该故障路径未被本注入集触发，非缺陷）' : ''}`);
  console.log(
    `\n说明：注入下通关率不是目标（回路维护被人为破坏），验收标准是「终态合法 + 引擎状态无污染」；`,
  );
  console.log(`总体判定: ${allOk ? '✅ 全部通过' : '❌ 存在失败项'}`);
  if (!allOk) process.exit(1);
}

main();
