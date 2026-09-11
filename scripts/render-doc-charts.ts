import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import snapshot from './data/verification-snapshot.json';
import { BASELINE } from '../src/content/baseline';

const outDir = resolve('docs/assets');
mkdirSync(outDir, { recursive: true });

const esc = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function strategyChart(): string {
  const ids = ['greedy-astar', 'safe-astar', 'hamilton', 'hamilton-shortcut', 'hybrid'] as const;
  const names = ['贪心找食物', '安全找路', '固定环形路线', '环形路线＋近路', '自动选择路线'];
  const scenarios = new Set(['basic', 'medium', 'hard']);
  const values = ids.map((id) => {
    const rows = BASELINE.filter((row) => row.strategy === id && scenarios.has(row.scenario));
    return rows.reduce((sum, row) => sum + row.winRate, 0) / Math.max(1, rows.length);
  });
  const bars = values.map((value, i) => {
    const y = 105 + i * 58;
    const width = Math.round(value * 560);
    return `<text x="36" y="${y + 18}" fill="#cbd5e1" font-size="18">${esc(names[i])}</text><rect x="210" y="${y}" width="560" height="26" rx="8" fill="#1e293b"/><rect x="210" y="${y}" width="${width}" height="26" rx="8" fill="${value === 1 ? '#10b981' : '#38bdf8'}"/><text x="785" y="${y + 20}" fill="#f8fafc" font-size="17" text-anchor="end">${Math.round(value * 100)}%</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="430" viewBox="0 0 820 430" role="img" aria-labelledby="title desc"><title id="title">不同贪吃蛇算法的平均通关率</title><desc id="desc">基础、规则障碍和困难规则地图上的三组十局实验平均值。</desc><rect width="820" height="430" rx="24" fill="#0f172a"/><text x="36" y="48" fill="#f8fafc" font-size="26" font-weight="700">不同走法，结果差多少？</text><text x="36" y="76" fill="#94a3b8" font-size="15">基础、规则障碍、困难规则地图 · 每组 10 局的平均通关率</text>${bars}<text x="36" y="405" fill="#64748b" font-size="13">实验结果只代表给定地图、版本和种子，不代表所有地图。</text></svg>`;
}

function verificationChart(): string {
  const cards = [
    ['通关', `${snapshot.wins}/${snapshot.runs}`, '#10b981'],
    ['安全失败', String(snapshot.safetyFailures), '#38bdf8'],
    ['大多数步骤耗时', `${snapshot.pooledP99Ms} ms`, '#a78bfa'],
  ];
  const body = cards.map(([label, value, color], i) => {
    const x = 36 + i * 250;
    return `<rect x="${x}" y="110" width="220" height="150" rx="18" fill="#1e293b"/><circle cx="${x + 28}" cy="140" r="7" fill="${color}"/><text x="${x + 46}" y="146" fill="#94a3b8" font-size="17">${label}</text><text x="${x + 22}" y="215" fill="#f8fafc" font-size="34" font-weight="700">${value}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="340" viewBox="0 0 820 340" role="img" aria-labelledby="title desc"><title id="title">动态障碍场景验证摘要</title><desc id="desc">二十局全部通关，没有安全失败，合并全部步骤后的百分之九十九耗时为零点八九二七毫秒。</desc><rect width="820" height="340" rx="24" fill="#0f172a"/><text x="36" y="48" fill="#f8fafc" font-size="26" font-weight="700">动态地图验证快照</text><text x="36" y="76" fill="#94a3b8" font-size="15">${snapshot.date} · ${snapshot.scenario} · 固定种子 ${snapshot.runs} 局</text>${body}<text x="36" y="306" fill="#64748b" font-size="13">“${snapshot.wins}/${snapshot.runs}”是样本结果，不是对任意动态地图的保证。</text></svg>`;
}

writeFileSync(resolve(outDir, 'strategy-comparison.svg'), strategyChart(), 'utf8');
writeFileSync(resolve(outDir, 'dynamic-verification.svg'), verificationChart(), 'utf8');
console.log(`Charts generated in ${outDir}`);
