import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SHEET_CYCLE_BUDGET,
  newPart,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { solverInput } from '../src/engine/import/sparrow';
import { stitchBoards, splitVirtualResult } from '../src/engine/virtualSheets';
import { validate } from '../src/engine/geometry/validate';

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])(
  'uses native local Sparrow phases with sustained budget in compiled %s',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const stock: SheetStock = {
      id: 'native-local',
      name: 'native-local',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: 50,
      widthMm: 20,
    };
    const job: Job = {
      name: 'native local phases',
      parts: [
        {
          ...newPart([
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
          ]),
          quantity: 6,
          rotations: { kind: 'discrete', degrees: [0] },
        },
      ],
      settings: {
        ...DEFAULT_SETTINGS,
        sheetStocks: [stock],
        sheetCount: 2,
        sheetLengthMm: 50,
        materialWidthMm: 20,
        clearanceMm: 1,
        sheetCycleBudget: {
          ...DEFAULT_SHEET_CYCLE_BUDGET,
          localMs: 700,
          globalMs: 600,
          evacuationMs: 100,
          localPercent: 50,
          globalPercent: 50,
          evacuationPercent: 50,
          maxRounds: 2,
          stallRounds: 0,
        },
      },
    };
    const virtual = stitchBoards(job, [stock, stock]);
    const warm: Result = {
      documentRevision: 0,
      solverRevision: 'test',
      seed: '42',
      elapsedSeconds: 0,
      usedLengthMm: 101,
      placements: [5, 19, 33, 56, 70, 84].map((xMm, copyIndex) => ({
        partId: job.parts[0].id,
        copyIndex,
        xMm,
        yMm: 3,
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
    const original = splitVirtualResult(job, virtual, warm)!;
    const session = new wasm.SheetSession(solverInput(virtual.job), 1, 'standard');
    const start = performance.now();
    let finished = false,
      candidates = 0,
      localImproved = false,
      initialWidth: number | undefined;
    const phases: string[] = [];
    const stages: { stage: string; boardIndex?: number; phase?: string }[] = [];
    let currentStage: { stage: string; boardIndex?: number; phase?: string } | undefined;
    try {
      session.step(
        JSON.stringify({
          quantities: [6],
          mode: 'compress',
          budget_ms: 2800,
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
          const message = JSON.parse(text);
          if (message.type === 'sheet-stage') {
            currentStage = {
              stage: message.stage,
              boardIndex: message.boardIndex,
              phase: message.phase,
            };
            stages.push(currentStage);
          }
          if (message.type === 'phase') phases.push(message.phase);
          if (message.type === 'finished') finished = true;
          if (message.type !== 'candidate') return;
          initialWidth ??= message.solution.strip_width;
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
                xMm: item.transformation.translation[0],
                yMm: item.transformation.translation[1],
                angleDeg: item.transformation.rotation,
              }),
            ),
          };
          const aggregate = splitVirtualResult(job, virtual, candidate);
          expect(aggregate).toBeDefined();
          expect(validate(job, aggregate!)).toMatchObject({ status: 'passed', errors: [] });
          expect(aggregate!.unplaced).toEqual([]);
          if (currentStage?.stage === 'local') {
            expect(currentStage.boardIndex).toBe(0);
            const tail = candidate.placements
              .filter((p) => p.xMm >= 51)
              .map((p) => [p.xMm, p.yMm, p.angleDeg])
              .sort((a, b) => a[0] - b[0]);
            expect(tail).toEqual([
              [56, 3, 0],
              [70, 3, 0],
              [84, 3, 0],
            ]);
          }
          if (
            candidate.usedLengthMm === initialWidth &&
            aggregate!.usedLengthMm < original.usedLengthMm
          )
            localImproved = true;
          candidates++;
        },
      );
      expect(finished).toBe(true);
      expect(candidates).toBeGreaterThan(1);
      expect(localImproved).toBe(true);
      expect(stages).toContainEqual({ stage: 'local', boardIndex: 0, phase: 'Exploration' });
      expect(stages).toContainEqual({ stage: 'local', boardIndex: 0, phase: 'Compression' });
      expect(stages).toContainEqual({ stage: 'global', phase: 'Exploration' });
      expect(
        stages.some((stage) => stage.stage === 'global' && stage.phase === 'Compression'),
      ).toBe(true);
      expect(phases.filter((p) => p === 'Exploration').length).toBeGreaterThanOrEqual(1);
      expect(phases.filter((p) => p === 'Compression').length).toBeGreaterThanOrEqual(1);
      expect(performance.now() - start).toBeGreaterThan(400);
    } finally {
      session.free();
    }
  },
  20_000,
);
