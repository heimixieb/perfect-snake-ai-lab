import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// @ts-expect-error gifenc 1.0.3 does not ship TypeScript declarations.
import gifenc from 'gifenc';
import { Game } from '../src/engine/game';
import { getScenario } from '../src/engine/scenarios';
import { createStrategy } from '../src/engine/strategies';

const WIDTH = 480;
const HEIGHT = 480;
const CELL = 42;
const OFFSET = 30;
const output = resolve('docs/assets/snake-fill.gif');
const { GIFEncoder } = gifenc as { GIFEncoder: () => {
  writeFrame: (pixels: Uint8Array, width: number, height: number, options: Record<string, unknown>) => void;
  finish: () => void;
  bytes: () => Uint8Array;
} };

// Fixed palette keeps the GIF small and makes asset generation deterministic.
const palette = [
  [15, 23, 42],
  [17, 28, 51],
  [35, 48, 71],
  [124, 58, 237],
  [16, 185, 129],
  [45, 212, 191],
  [236, 253, 245],
  [249, 115, 22],
];

function fillRect(pixels: Uint8Array, x: number, y: number, w: number, h: number, color: number): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(WIDTH, x + w);
  const y1 = Math.min(HEIGHT, y + h);
  for (let yy = y0; yy < y1; yy++) pixels.fill(color, yy * WIDTH + x0, yy * WIDTH + x1);
}

function drawLine(pixels: Uint8Array, x0: number, y0: number, x1: number, y1: number, color: number): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fillRect(pixels, x - 1, y - 1, 3, 3, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function render(game: Game, cycle: Int32Array, cycleLength: number): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT);
  pixels.fill(0);
  fillRect(pixels, OFFSET, OFFSET, game.grid.w * CELL, game.grid.h * CELL, 1);

  for (let i = 0; i < cycleLength; i++) {
    const a = cycle[i];
    const b = cycle[(i + 1) % cycleLength];
    const ax = OFFSET + game.grid.x(a) * CELL + CELL / 2;
    const ay = OFFSET + game.grid.y(a) * CELL + CELL / 2;
    const bx = OFFSET + game.grid.x(b) * CELL + CELL / 2;
    const by = OFFSET + game.grid.y(b) * CELL + CELL / 2;
    drawLine(pixels, ax, ay, bx, by, 3);
  }

  for (let y = 0; y <= game.grid.h; y++) fillRect(pixels, OFFSET, OFFSET + y * CELL, game.grid.w * CELL, 1, 2);
  for (let x = 0; x <= game.grid.w; x++) fillRect(pixels, OFFSET + x * CELL, OFFSET, 1, game.grid.h * CELL, 2);

  for (const food of game.foods) {
    const x = OFFSET + game.grid.x(food.cell) * CELL;
    const y = OFFSET + game.grid.y(food.cell) * CELL;
    fillRect(pixels, x + 14, y + 14, CELL - 28, CELL - 28, 7);
  }

  const body = game.bodyCells();
  for (let i = 0; i < body.length; i++) {
    const cell = body[i];
    const x = OFFSET + game.grid.x(cell) * CELL;
    const y = OFFSET + game.grid.y(cell) * CELL;
    const color = i === body.length - 1 ? 6 : i > body.length * 0.65 ? 5 : 4;
    fillRect(pixels, x + 3, y + 3, CELL - 6, CELL - 6, color);
  }
  return pixels;
}

function main(): void {
  const game = new Game(getScenario('basic'), 1000);
  const strategy = createStrategy('hamilton', game);
  const cycle = strategy.debug.cycle;
  if (!cycle) throw new Error('The basic scenario must provide a Hamiltonian cycle.');

  const gif = GIFEncoder();
  let frames = 0;
  const writeFrame = (delay: number): void => {
    gif.writeFrame(render(game, cycle.cells, cycle.length), WIDTH, HEIGHT, {
      palette: frames === 0 ? palette : undefined,
      delay,
      repeat: 0,
    });
    frames++;
  };

  writeFrame(700);
  let lastLength = game.length;
  const maxSteps = game.grid.freeCount * game.grid.freeCount;
  while (game.alive && !game.won && game.steps < maxSteps) {
    game.step(strategy.decide(game));
    if (game.length !== lastLength) {
      writeFrame(75);
      lastLength = game.length;
    }
  }
  if (!game.won) throw new Error(`GIF run did not finish: ${game.failReason}`);
  writeFrame(1400);
  gif.finish();

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, gif.bytes());
  console.log(`GIF generated: ${output} (${frames} frames, ${gif.bytes().length} bytes)`);
}

main();
