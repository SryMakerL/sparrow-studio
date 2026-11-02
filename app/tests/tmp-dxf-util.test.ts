import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bounds, normalizeJob } from '../src/engine/geometry/normalize';
import { validate, netArea } from '../src/engine/geometry/validate';
import { importDXF } from '../src/engine/import/dxf';
import { normalizeSheetStock, stockArea } from '../src/engine/stock';
import { solveSheets } from '../src/engine/sheets';
import { DEFAULT_SETTINGS, newPart, type Job, type Result, type SheetStock } from '../src/engine/model';
import { utilization, projectJob, newProject, setStockSheets } from '../src/project/model';

const review = importDXF(readFileSync('../test/circle sheet.dxf', 'utf8'), 'circle sheet.dxf', {
  scale: 1,
  tolerance: 0.01,
  enclosed: 'holes',
});
const part = review.document.parts[0];

const circleStock = (quantity: number): SheetStock =>
  normalizeSheetStock({
    id: 'circle',
    name: 'circle sheet',
    kind: 'polygon',
    outer: part.outer,
    holes: part.holes,
    widthMm: 0,
    lengthMm: 0,
    quantity,
    priority: 0,
  });

const square = (side: number) =>
  newPart([
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ]);

const layout = (child: Job, n: number): Result => ({
  documentRevision: 0,
  solverRevision: 'test',
  seed: '',
  elapsedSeconds: 0,
  usedLengthMm: 1200,
  placements: Array.from({ length: n }, (_, copyIndex) => ({
    partId: child.parts[0].id,
    copyIndex,
    xMm: 1000 + (copyIndex % 2) * 120,
    yMm: 1000 + Math.floor(copyIndex / 2) * 120,
    angleDeg: 0,
  })),
  validation: {
    status: 'pending',
    overlapAreaMm2: null,
    maxBoundaryViolationMm: null,
    minClearanceMm: null,
    errors: [],
  },
});

const pass = () => ({
  status: 'passed' as const,
  overlapAreaMm2: 0,
  maxBoundaryViolationMm: 0,
  minClearanceMm: null,
  errors: [],
});

describe('tmp circle sheet utilization', () => {
  it('compares bbox and net area of the circle sheet', () => {
    const s = circleStock(1);
    const bbox = s.widthMm * s.lengthMm;
    console.log('circle bbox', s.widthMm.toFixed(3), 'x', s.lengthMm.toFixed(3), '=', bbox.toFixed(1));
    console.log('circle net area', stockArea(s).toFixed(1), 'ratio', (stockArea(s) / bbox).toFixed(4));
    expect(stockArea(s)).toBeLessThan(bbox * 0.75);
  });

  it('multi-sheet run reports capacity from polygon area', async () => {
    const stock = circleStock(2);
    const p = newProject('circle boards');
    p.parts = [{ ...square(200), quantity: 4, rotations: { kind: 'discrete', degrees: [0] } }];
    p.stock = setStockSheets(p.stock, [stock]);
    const job = projectJob(p);
    job.settings.timeLimitSeconds = 10;
    job.settings.sheetStagnationSeconds = 1;
    job.settings.solverPreset = 'fast';
    normalizeJob(job);

    vi.useFakeTimers();
    try {
      const pending = solveSheets(
        job,
        async (child) => layout(child, Math.min(2, child.parts[0].quantity)),
        { validate: () => pass() },
      );
      await vi.advanceTimersByTimeAsync(10000);
      const { result } = await pending;
      console.log('sheets used', result.sheets?.length, 'unplaced', JSON.stringify(result.unplaced));
      for (const [i, sheet] of (result.sheets ?? []).entries()) {
        const s = sheet.job.settings.sheetStock!;
        const partsArea = sheet.job.parts.reduce((n, q) => n + netArea(q) * q.quantity, 0);
        console.log(
          `sheet ${i + 1}: kind=${s.kind} parts=${sheet.result.placements.length} area=${partsArea}`,
          `stockArea=${stockArea(s).toFixed(1)} bbox=${(s.widthMm * s.lengthMm).toFixed(1)}`,
          `ui=${((partsArea / stockArea(s)) * 100).toFixed(2)}% bboxFallback=${((partsArea / (s.widthMm * s.lengthMm)) * 100).toFixed(2)}%`,
        );
      }
      console.log('total utilization', utilization(job, result, netArea).toFixed(4), '%');
      const expected =
        ((result.sheets ?? []).reduce(
          (n, sheet) => n + sheet.job.parts.reduce((m, q) => m + netArea(q) * q.quantity, 0),
          0,
        ) /
          (result.sheets!.length * stockArea(stock))) *
        100;
      console.log('expected with polygon capacity', expected.toFixed(4), '%');
      expect(utilization(job, result, netArea)).toBeCloseTo(expected, 9);
    } finally {
      vi.useRealTimers();
    }
  });
});
