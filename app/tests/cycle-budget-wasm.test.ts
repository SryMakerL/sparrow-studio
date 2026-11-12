import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SHEET_CYCLE_BUDGET,
  newPart,
  type Job,
  type SheetStock,
} from '../src/engine/model';
import { solverInput } from '../src/engine/import/sparrow';
import { stitchBoards } from '../src/engine/virtualSheets';

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])(
  'applies configured round limits and disabled early exit in compiled %s',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const stock: SheetStock = {
      id: 'budget',
      name: 'budget',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: 30,
      widthMm: 12,
    };
    const job: Job = {
      name: 'budget runtime',
      parts: [
        {
          ...newPart([
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
          ]),
          quantity: 4,
          rotations: { kind: 'discrete', degrees: [0] },
        },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        sheetStocks: [stock],
        sheetCount: 2,
        sheetLengthMm: 30,
        materialWidthMm: 12,
        clearanceMm: 1,
      },
    };
    const results: { roundCap: number; phases: number; elapsedMs: number; finished: boolean }[] =
      [];
    for (const roundCap of [1, 0]) {
      const virtual = stitchBoards(job, [stock, stock]);
      virtual.job.settings.sheetCycleBudget = {
        ...DEFAULT_SHEET_CYCLE_BUDGET,
        localMs: 5,
        globalMs: 5,
        evacuationMs: 5,
        maxRounds: roundCap,
        stallRounds: 0,
      };
      const session = new wasm.SheetSession(solverInput(virtual.job), 1, 'standard');
      let phases = 0,
        finished = false;
      const start = performance.now();
      try {
        session.step(
          JSON.stringify({
            quantities: [4],
            mode: 'compress',
            budget_ms: 300,
            initial_placement: {
              used_length_mm: 61,
              placements: [5, 19, 36, 50].map((x) => ({
                item_id: 0,
                rotation: 0,
                translation: [x, 2],
              })),
            },
          }),
          '42',
          (text: string) => {
            const message = JSON.parse(text);
            if (message.type === 'phase') phases++;
            if (message.type === 'finished') finished = true;
          },
        );
        results.push({ roundCap, phases, elapsedMs: performance.now() - start, finished });
      } finally {
        session.free();
      }
    }
    expect(results[0].finished).toBe(true);
    expect(results[0].phases).toBeLessThanOrEqual(7);
    expect(results[1].finished).toBe(true);
    expect(results[1].phases).toBeGreaterThan(results[0].phases);
    expect(results[1].elapsedMs).toBeGreaterThanOrEqual(250);
    for (const roundCap of [1, 0]) {
      const automatic = stitchBoards(job, [stock, stock]);
      automatic.job.settings.sheetCycleBudget = {
        ...DEFAULT_SHEET_CYCLE_BUDGET,
        localMs: 5,
        globalMs: 5,
        evacuationMs: 5,
        maxRounds: roundCap,
        stallRounds: 0,
      };
      const session = new wasm.SheetSession(solverInput(automatic.job), 1, 'standard');
      let phases = 0,
        finished = false,
        interrupted = false;
      try {
        session.step(
          JSON.stringify({
            quantities: [4],
            mode: 'compress',
            budget_ms: null,
            initial_placement: {
              used_length_mm: 61,
              placements: [5, 19, 36, 50].map((x) => ({
                item_id: 0,
                rotation: 0,
                translation: [x, 2],
              })),
            },
          }),
          '42',
          (text: string) => {
            const message = JSON.parse(text);
            if (message.type === 'phase') phases++;
            if (message.type === 'finished') finished = true;
          },
          () => {
            if (roundCap === 0 && phases >= 12) interrupted = true;
            return interrupted;
          },
        );
        expect(finished).toBe(true);
        if (roundCap === 1) expect(phases).toBeLessThanOrEqual(7);
        else {
          expect(phases).toBeGreaterThanOrEqual(12);
          expect(interrupted).toBe(true);
        }
      } finally {
        session.free();
      }
    }
    const virtual = stitchBoards(job, [stock, stock]);
    const invalid = { ...JSON.parse(solverInput(virtual.job)), board_cycle: { localMs: 0 } };
    expect(() => new wasm.SheetSession(JSON.stringify(invalid), 1, 'standard')).toThrow();
  },
  15_000,
);
