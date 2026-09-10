import { useEffect, useRef } from 'react';
import { Game } from '../engine/game';
import { StrategyDebug } from '../engine/strategies';

interface Props {
  game: Game;
  debug: StrategyDebug | null;
  showCycle: boolean;
  showPath: boolean;
  /** 触发重绘的计数器 */
  tick: number;
  size?: number;
}

export default function Board({ game, debug, showCycle, showPath, tick, size = 520 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const { w, h } = game.grid;
    const cell = Math.floor(Math.min(size / w, size / h));
    const W = cell * w,
      H = cell * h;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);
    // 网格与障碍
    for (let i = 0; i < game.grid.n; i++) {
      const x = (i % w) * cell,
        y = ((i / w) | 0) * cell;
      if (game.grid.blocked[i]) {
        ctx.fillStyle = '#334155';
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
      } else if (game.reserved[i]) {
        // 动态障碍预约位（预告期）：琥珀色斜纹闪烁语义——用半透明琥珀填充
        ctx.fillStyle = 'rgba(251, 191, 36, 0.35)';
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 2.5, y + 2.5, cell - 5, cell - 5);
      } else if (game.visited[i]) {
        ctx.fillStyle = '#131c33';
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(W, y * cell + 0.5);
      ctx.stroke();
    }
    // 哈密顿回路
    if (showCycle && debug?.cycle) {
      const cyc = debug.cycle;
      ctx.strokeStyle = 'rgba(139,92,246,0.45)';
      ctx.lineWidth = Math.max(1, cell * 0.12);
      ctx.beginPath();
      for (let k = 0; k <= cyc.length; k++) {
        const c = cyc.cells[k % cyc.length];
        const x = (c % w) * cell + cell / 2,
          y = ((c / w) | 0) * cell + cell / 2;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 回路序号叠加（融合自 5.1 A）：格子足够大时标出每格在回路上的序号
      if (cell >= 22) {
        ctx.fillStyle = 'rgba(226,232,240,0.6)';
        ctx.font = `${Math.floor(cell * 0.3)}px ui-monospace, monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (let i = 0; i < cyc.length; i++) {
          const c = cyc.cells[i];
          ctx.fillText(String(i), (c % w) * cell + 2, ((c / w) | 0) * cell + 2);
        }
      }
      if (cyc.aliasCell >= 0) {
        const c = cyc.aliasCell;
        ctx.fillStyle = 'rgba(139,92,246,0.35)';
        ctx.fillRect((c % w) * cell + 2, ((c / w) | 0) * cell + 2, cell - 4, cell - 4);
      }
    }
    // 规划路径
    if (showPath && debug?.path && debug.path.length > 1) {
      ctx.strokeStyle = 'rgba(56,189,248,0.8)';
      ctx.lineWidth = Math.max(1, cell * 0.15);
      ctx.beginPath();
      debug.path.forEach((c, k) => {
        const x = (c % w) * cell + cell / 2,
          y = ((c / w) | 0) * cell + cell / 2;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // 食物
    for (const f of game.foods) {
      const x = (f.cell % w) * cell,
        y = ((f.cell / w) | 0) * cell;
      const ratio = Number.isFinite(f.expiresAt) ? (f.expiresAt - game.steps) / (f.expiresAt - f.bornAt) : 1;
      ctx.fillStyle = `hsl(${Math.max(0, ratio) * 40}, 90%, 55%)`;
      ctx.beginPath();
      ctx.arc(x + cell / 2, y + cell / 2, cell * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
    // 蛇身
    const body = game.bodyCells();
    const L = body.length;
    body.forEach((c, i) => {
      const x = (c % w) * cell,
        y = ((c / w) | 0) * cell;
      const t = i / Math.max(1, L - 1);
      const isHead = i === L - 1;
      ctx.fillStyle = isHead ? '#f8fafc' : `hsl(${150 + t * 20}, 70%, ${35 + t * 25}%)`;
      const pad = isHead ? 1 : 1.5;
      ctx.fillRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2);
    });
  }, [game, debug, showCycle, showPath, tick, size]);

  return <canvas ref={ref} className="rounded-lg shadow-2xl shadow-black/40" />;
}
