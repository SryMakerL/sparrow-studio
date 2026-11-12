import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { solverInput } from '../src/engine/import/sparrow';
import { validate } from '../src/engine/geometry/validate';
import { splitVirtualResult, stitchBoards } from '../src/engine/virtualSheets';

afterEach(() => vi.unstubAllGlobals());

it.each(
  ['pkg', 'pkg-nosimd'].flatMap((pkg) => [
    { pkg, length: 30, width: 20, size: 12, quantity: 3 },
    { pkg, length: 60_000, width: 30_000, size: 29_000, quantity: 4 },
  ]),
)(
  'jointly nests separated boards using $pkg with $length mm physical boards',
  async ({ pkg, length, width, size, quantity }) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const stock: SheetStock = {
      id: 'board',
      name: 'board',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: length,
      widthMm: width,
    };
    const input: Job = {
      name: 'virtual integration',
      parts: [
        {
          ...newPart([
            [0, 0],
            [size, 0],
            [size, size],
            [0, size],
          ]),
          quantity,
          rotations: { kind: 'discrete', degrees: [0] },
        },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        sheetStocks: [stock],
        sheetCount: 2,
        sheetLengthMm: length,
        materialWidthMm: width,
        clearanceMm: 1,
      },
    };
    const virtual = stitchBoards(input, [stock, stock]);
    const session = new wasm.SheetSession(solverInput(virtual.job), 1, 'fast');
    let snapshot: number | undefined;
    let count = 0;
    const run = (mode: 'search' | 'compress') =>
      session.step(
        JSON.stringify({
          quantities: [quantity],
          mode,
          budget_ms: mode === 'search' ? 0 : 100,
          initial_snapshot: snapshot,
          retain_snapshot: snapshot,
        }),
        '42',
        (text: string) => {
          const message = JSON.parse(text);
          if (message.type !== 'candidate') return;
          snapshot = message.snapshotId;
          const candidate: Result = {
            documentRevision: 0,
            solverRevision: 'integration',
            seed: '42',
            elapsedSeconds: 0,
            usedLengthMm: message.solution.strip_width,
            placements: message.solution.layout.placed_items.map(
              (
                item: {
                  transformation: { rotation: number; translation: [number, number] };
                },
                copyIndex: number,
              ) => ({
                partId: input.parts[0].id,
                copyIndex,
                angleDeg: item.transformation.rotation,
                xMm: item.transformation.translation[0],
                yMm: item.transformation.translation[1],
              }),
            ),
            validation: {
              status: 'pending',
              overlapAreaMm2: null,
              maxBoundaryViolationMm: null,
              minClearanceMm: null,
              errors: [],
            },
          };
          if (length > 50_000) expect(candidate.usedLengthMm).toBeGreaterThan(100_000);
          expect(validate(virtual.job, candidate)).toMatchObject({ status: 'passed', errors: [] });
          const aggregate = splitVirtualResult(input, virtual, candidate);
          expect(aggregate).toBeDefined();
          expect(validate(input, aggregate!)).toMatchObject({ status: 'passed', errors: [] });
          expect(aggregate!.sheets).toHaveLength(2);
          expect(aggregate!.unplaced).toEqual([]);
          count++;
        },
      );
    try {
      run('search');
      run('compress');
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      session.free();
    }
  },
  15_000,
);

it.each(['pkg', 'pkg-nosimd'])(
  'evacuates a warm-started physical board in compiled %s',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const stock: SheetStock = {
      id: 'evacuation',
      name: 'evacuation',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: 30,
      widthMm: 12,
    };
    const source: SheetStock = {
      ...stock,
      id: 'source',
      name: 'small source',
      quantity: 1,
      lengthMm: 12,
    };
    stock.quantity = 1;
    const job: Job = {
      name: 'evacuation integration',
      parts: [
        {
          ...newPart([
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
          ]),
          quantity: 3,
          rotations: { kind: 'discrete', degrees: [0] },
        },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        sheetStocks: [source, stock],
        sheetCount: 2,
        sheetLengthMm: 30,
        materialWidthMm: 12,
        clearanceMm: 1,
      },
    };
    const virtual = stitchBoards(job, [source, stock]);
    const warm: Result = {
      documentRevision: 0,
      solverRevision: 'integration',
      seed: '42',
      elapsedSeconds: 0,
      usedLengthMm: 43,
      placements: [2, 15, 25].map((xMm, copyIndex) => ({
        partId: job.parts[0].id,
        copyIndex,
        xMm,
        yMm: 2,
        angleDeg: 0,
      })),
      validation: {
        status: 'pending',
        overlapAreaMm2: null,
        maxBoundaryViolationMm: null,
        minClearanceMm: null,
        errors: [],
      },
    };
    expect(validate(virtual.job, warm).status).toBe('passed');
    const session = new wasm.SheetSession(solverInput(virtual.job), 1, 'standard');
    let minimumBoards = 2;
    let candidates = 0;
    let finished = false;
    try {
      session.step(
        JSON.stringify({
          quantities: [3],
          mode: 'compress',
          budget_ms: 700,
          initial_placement: {
            used_length_mm: warm.usedLengthMm,
            placements: warm.placements.map((placement) => ({
              item_id: 0,
              rotation: placement.angleDeg,
              translation: [placement.xMm, placement.yMm],
            })),
          },
        }),
        '42',
        (text: string) => {
          const message = JSON.parse(text);
          if (message.type === 'finished') finished = true;
          if (message.type !== 'candidate') return;
          const candidate: Result = {
            ...warm,
            usedLengthMm: message.solution.strip_width,
            placements: message.solution.layout.placed_items.map(
              (
                item: {
                  transformation: { rotation: number; translation: [number, number] };
                },
                copyIndex: number,
              ) => ({
                partId: job.parts[0].id,
                copyIndex,
                angleDeg: item.transformation.rotation,
                xMm: item.transformation.translation[0],
                yMm: item.transformation.translation[1],
              }),
            ),
          };
          const aggregate = splitVirtualResult(job, virtual, candidate);
          expect(aggregate).toBeDefined();
          expect(validate(job, aggregate!)).toMatchObject({ status: 'passed', errors: [] });
          expect(aggregate!.unplaced).toEqual([]);
          if (aggregate!.sheets!.length === 1)
            expect(aggregate!.sheets![0].job.settings.sheetStock!.id).toBe(stock.id);
          minimumBoards = Math.min(minimumBoards, aggregate!.sheets!.length);
          candidates++;
        },
      );
      expect(finished).toBe(true);
      expect(candidates).toBeGreaterThan(0);
      expect(minimumBoards).toBe(1);
    } finally {
      session.free();
    }
  },
  15_000,
);

it.each(['pkg', 'pkg-nosimd'])(
  'compacts boards locally before global search in compiled %s',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const stock: SheetStock = {
      id: 'cycle',
      name: 'cycle',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: 30,
      widthMm: 12,
    };
    const job: Job = {
      name: 'local-global cycle',
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
    const virtual = stitchBoards(job, [stock, stock]);
    const warm: Result = {
      documentRevision: 0,
      solverRevision: 'integration',
      seed: '42',
      elapsedSeconds: 0,
      usedLengthMm: 61,
      placements: [5, 19, 36, 50].map((xMm, copyIndex) => ({
        partId: job.parts[0].id,
        copyIndex,
        xMm,
        yMm: 2,
        angleDeg: 0,
      })),
      validation: {
        status: 'pending',
        overlapAreaMm2: null,
        maxBoundaryViolationMm: null,
        minClearanceMm: null,
        errors: [],
      },
    };
    const initial = splitVirtualResult(job, virtual, warm)!;
    const session = new wasm.SheetSession(solverInput(virtual.job), 1, 'standard');
    let localPhase = false,
      globalAfterLocal = false,
      localImproved = false,
      finished = false;
    let fittedInitialWidth: number | undefined;
    try {
      session.step(
        JSON.stringify({
          quantities: [4],
          mode: 'compress',
          budget_ms: 1400,
          initial_placement: {
            used_length_mm: warm.usedLengthMm,
            placements: warm.placements.map((p) => ({
              item_id: 0,
              rotation: 0,
              translation: [p.xMm, p.yMm],
            })),
          },
        }),
        '42',
        (text: string) => {
          const m = JSON.parse(text);
          if (m.type === 'phase' && m.phase === 'Compression') localPhase = true;
          if (m.type === 'finished') finished = true;
          if (m.type !== 'candidate') return;
          fittedInitialWidth ??= m.solution.strip_width;
          if (m.solution.strip_width !== fittedInitialWidth) globalAfterLocal = true;
          const candidate: Result = {
            ...warm,
            usedLengthMm: m.solution.strip_width,
            placements: m.solution.layout.placed_items.map(
              (
                item: {
                  transformation: { rotation: number; translation: [number, number] };
                },
                copyIndex: number,
              ) => ({
                partId: job.parts[0].id,
                copyIndex,
                angleDeg: item.transformation.rotation,
                xMm: item.transformation.translation[0],
                yMm: item.transformation.translation[1],
              }),
            ),
          };
          const aggregate = splitVirtualResult(job, virtual, candidate);
          expect(aggregate).toBeDefined();
          expect(validate(job, aggregate!)).toMatchObject({ status: 'passed', errors: [] });
          expect(aggregate!.unplaced).toEqual([]);
          if (
            localPhase &&
            !globalAfterLocal &&
            candidate.usedLengthMm === fittedInitialWidth &&
            aggregate!.usedLengthMm < initial.usedLengthMm
          )
            localImproved = true;
        },
      );
      expect(finished).toBe(true);
      expect(localImproved).toBe(true);
      expect(globalAfterLocal).toBe(true);
    } finally {
      session.free();
    }
  },
  15_000,
);
