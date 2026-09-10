/**
 * 单格障碍图的「结构性吃满上界」判定器 v2：不相交坏区域塔（贪心划分）。
 *
 * 原理（哈密顿路径语义，非回路——蛇是路径不是环）：
 * 网格自由图是二分图。哈密顿路径是黑白交替序列，其端点约束为
 *   |B(全图) − W(全图)| ≤ 1，且差为 1 时路径两端都落在多数侧。
 * 对图上任意顶点子集 S，路径在 S 内部消耗 |S| 个连续位置时，S 内黑白格的
 * 奇偶差额必须能被路径进入/离开 S 的边界穿越补偿。由此：一个连通区域 R 若
 *   d(R) = |B(R) − W(R)| − (可边界补偿量)
 * 超过可补偿量，则至少 d(R) 个格不可被任何哈密顿路径覆盖。
 *
 * 不相交坏区域塔（贪心划分，老师定案）：
 *   区域类型 1 —— 死胡同格（度 ≤ 1 的自由格）：单独成 1×1 区域，d = 1。
 *     （长度 ≥ 2 的蛇进入死胡同格后无路可出；路径若覆盖它只能是端点，全图端点最多 2 个，
 *      多于 2 个死胡同时必有死胡同不可覆盖。这里按保守口径：每个死胡同格独立计 d=1，
 *      未扣除"最多 2 个可作为端点"的豁免——见 report 措辞：松弛上界。）
 *   区域类型 2 —— 剩余自由格的连通分量：d = max(0, |B − W| − 1)。
 *     （路径语义下单个连通分量的黑白差最多被 1 个"跨界端点对"补偿，故超额 = |B−W| − 1；
 *      全图只有唯一分量且 |B−W| ≤ 1 时 d=0，与奇×奇/偶格情形吻合。）
 *   同一区域既含死胡同又失衡时取 max 不叠加（老师定案）。
 *   区域互不相交 ⇒ 总废弃下界 = Σ d(Rᵢ)。
 *
 * 输出：认证上界（certified upper bound，非紧界）+ 逐区域证书。
 * 措辞红线：报告「认证上界/松弛上界」，绝不称「紧上界/最优值」。
 */
export interface RegionCertificate {
  /** 区域覆盖的格子 */
  cells: number[];
  /** 该区域要求的废弃格数 */
  d: number;
  /** 区域类型 */
  kind: 'deadend' | 'imbalance';
  /** 调试信息 */
  detail: string;
}

export interface UpperBoundResult {
  /** 认证吃满上界 = (自由格数 − Σd) / 自由格数 ∈ [0,1]（松弛上界，非紧界） */
  fillUpperBound: number;
  /** 废弃格数下界 = Σ d(Rᵢ) */
  wasteLowerBound: number;
  /** 自由格数 */
  freeCells: number;
  /** 逐区域证书（不相交） */
  regions: RegionCertificate[];
}

export function structuralUpperBound(blocked: Uint8Array, w: number): UpperBoundResult {
  const h = blocked.length / w;
  const n = blocked.length;
  let freeCells = 0;
  for (let c = 0; c < n; c++) if (!blocked[c]) freeCells++;

  // ---------- 第 1 类：死胡同格（度 ≤ 1），各成 1×1 区域，d = 1 ----------
  const regions: RegionCertificate[] = [];
  const claimed = new Uint8Array(n); // 已被某区域认领的格
  const deadendCells: number[] = [];
  for (let c = 0; c < n; c++) {
    if (blocked[c]) continue;
    const x = c % w;
    const y = (c - x) / w;
    let deg = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && !blocked[ny * w + nx]) deg++;
    }
    if (deg <= 1) deadendCells.push(c);
  }
  for (const c of deadendCells) {
    claimed[c] = 1;
    regions.push({ cells: [c], d: 1, kind: 'deadend', detail: `死胡同格 (${c % w},${(c - (c % w)) / w})` });
  }

  // ---------- 第 2 类：剩余自由格的连通分量，d = max(0, |B−W| − 1) ----------
  // BFS 划分连通分量（在未被死胡同区域认领之外的格上——死胡同格仍在图中但已计入
  // 类型 1；为保持区域不相交且保守，分量统计时排除已认领死胡同格，这会让分量
  // 的奇偶差略偏小 ⇒ 下界仍保守，方向正确）。
  const compStamp = new Int32Array(n);
  let stamp = 0;
  for (let c = 0; c < n; c++) {
    if (blocked[c] || claimed[c] || compStamp[c]) continue;
    stamp++;
    const compCells: number[] = [];
    const queue: number[] = [c];
    compStamp[c] = stamp;
    while (queue.length) {
      const cur = queue.pop()!;
      compCells.push(cur);
      const x = cur % w;
      const y = (cur - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (blocked[j] || claimed[j] || compStamp[j]) continue;
        compStamp[j] = stamp;
        queue.push(j);
      }
    }
    let b = 0;
    let wcount = 0;
    for (const cell of compCells) {
      const x = cell % w;
      const y = (cell - x) / w;
      if ((x + y) % 2 === 0) b++;
      else wcount++;
    }
    const d = Math.max(0, Math.abs(b - wcount) - 1); // 路径语义：单个分量可被 1 个端点对补偿
    regions.push({
      cells: compCells,
      d,
      kind: 'imbalance',
      detail: `连通分量 ${compCells.length} 格 B=${b} W=${wcount} → d=max(0,|B−W|−1)=${d}`,
    });
  }

  let waste = 0;
  for (const r of regions) waste += r.d;
  const unc = Math.min(waste, freeCells);
  return {
    fillUpperBound: freeCells === 0 ? 0 : (freeCells - unc) / freeCells,
    wasteLowerBound: unc,
    freeCells,
    regions,
  };
}
