import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bounds } from '../src/engine/geometry/normalize';
import { validate, netArea } from '../src/engine/geometry/validate';
import { importDXF } from '../src/engine/import/dxf';
import { normalizeSheetStock, stockArea } from '../src/engine/stock';
import { solveSheets } from '../src/engine/sheets';
import { solvePolygon } from '../src/engine/workers/polygonSolver';
import { newPart, type Job, type SheetStock } from '../src/engine/model';
import { utilization, projectJob, newProject, setStockSheets } from '../src/project/model';

const review = importDXF(readFileSync('../test/circle sheet.dxf', 'utf8'), 'circle sheet.dxf', {
  scale: 1,
  tolerance: 0.01,
  enclosed: 'holes',
});
const contour = review.document.parts[0];
const b = bounds(contour.outer);

// Mirrors App.tsx: the DXF contour becomes a polygon stock with bbox dimensions.
const circleStock = (quantity: number): SheetStock =>
  normalizeSheetStock({
    id: 'circle',
    name: 'circle sheet',
    kind: 'polygon',
    outer: contour.outer,
    holes: contour.holes,
    widthMm: b[3] - b[1],
    lengthMm: b[2] - b[0],
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

describe('circle sheet end to end', () => {
  it('multi-sheet utilization matches net stock area', async () => {
    const stock = circleStock(3);
    const p = newProject('circle boards');
    p.parts = [{ ...square(150), quantity: 9, rotations: { kind: 'discrete', degrees: [0] } }];
    p.stock = setStockSheets(p.stock, [stock]);
    const job = projectJob(p);
    job.settings.timeLimitSeconds = 10;
    job.settings.sheetStagnationSeconds = 1;
    job.settings.solverPreset = 'fast';

    vi.useFakeTimers();
    try {
      const pending = solveSheets(job, (child, signal, onCandidate, budget) =>
        solvePolygon(child, signal, onCandidate, Math.max(150, Math.min(600, budget ?? 150))),
      );
      await vi.advanceTimersByTimeAsync(10000);
      const { result } = await pending;
      console.log('sheets', result.sheets?.length, 'unplaced', JSON.stringify(result.unplaced));

      let area = 0;
      let netCapacity = 0;
      let bboxCapacity = 0;
      for (const [i, sheet] of (result.sheets ?? []).entries()) {
        const s = sheet.job.settings.sheetStock!;
        const partsArea = sheet.job.parts.reduce((n, q) => n + netArea(q) * q.quantity, 0);
        const net = stockArea(s);
        const box = s.widthMm * s.lengthMm;
        area += partsArea;
        netCapacity += net;
        bboxCapacity += box;
        console.log(
          `sheet ${i + 1}: kind=${s.kind} placed=${sheet.result.placements.length}/${sheet.job.parts[0].quantity}`,
          `used=${sheet.result.usedLengthMm.toFixed(1)}`,
          `parts=${partsArea.toFixed(0)} net=${net.toFixed(0)} bbox=${box.toFixed(0)}`,
          `shown=${((partsArea / net) * 100).toFixed(2)}% (bbox would be ${((partsArea / box) * 100).toFixed(2)}%)`,
        );
      }
      console.log('total shown', ((area / netCapacity) * 100).toFixed(3), '%');
      console.log('total if bbox', ((area / bboxCapacity) * 100).toFixed(3), '%');
      console.log('utilization()', utilization(job, result, netArea).toFixed(3), '%');
      expect(utilization(job, result, netArea)).toBeCloseTo((area / netCapacity) * 100, 9);
    } finally {
      vi.useRealTimers();
    }
  }, 120000);
});
