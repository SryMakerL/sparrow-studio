import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { normalizeSheetStock, stockArea } from '../src/engine/stock';
import { netArea } from '../src/engine/geometry/validate';
import { solveSheets } from '../src/engine/sheets';
import { utilization } from '../src/project/model';

// L 形板面：外接矩形 30 x 30 = 900，实际面积 500
const L = (): SheetStock =>
  normalizeSheetStock({
    id: 'L',
    name: 'L',
    quantity: 1,
    priority: 0,
    kind: 'polygon',
    widthMm: 0,
    lengthMm: 0,
    outer: [
      [10, 10],
      [40, 10],
      [40, 20],
      [20, 20],
      [20, 40],
      [10, 40],
    ],
    holes: [],
  });

const job = (stock: SheetStock): Job => ({
  name: 'L',
  parts: [
    {
      ...newPart([
        [0, 0],
        [8, 0],
        [8, 8],
        [0, 8],
      ]),
      rotations: { kind: 'discrete', degrees: [0] },
    },
  ],
  settings: {
    ...DEFAULT_SETTINGS,
    solverPreset: 'fast',
    sheetStocks: [stock],
    sheetCount: 1,
    sheetStagnationSeconds: 1,
    timeLimitSeconds: 10,
    sheetLengthMm: stock.lengthMm,
    materialWidthMm: stock.widthMm,
  },
});

const layout = (child: Job, x: number, y: number): Result => ({
  documentRevision: 0,
  solverRevision: 'test',
  seed: '',
  elapsedSeconds: 0,
  usedLengthMm: x + 8,
  placements: [{ partId: child.parts[0].id, copyIndex: 0, xMm: x, yMm: y, angleDeg: 0 }],
  validation: {
    status: 'pending',
    overlapAreaMm2: null,
    maxBoundaryViolationMm: null,
    minClearanceMm: null,
    errors: [],
  },
});

describe('tmp polygon utilization', () => {
  it('stockArea is net polygon area', () => {
    expect(stockArea(L())).toBe(500);
  });

  it('multi-sheet utilization uses polygon area, not bounding box', async () => {
    vi.useFakeTimers();
    try {
      const input = job(L());
      const pending = solveSheets(input, async (child) => layout(child, 0, 0));
      await vi.advanceTimersByTimeAsync(10000);
      const { result } = await pending;
      console.log('sheets', result.sheets?.length, 'unplaced', JSON.stringify(result.unplaced));
      console.log('sheet job sheetStock', result.sheets?.[0].job.settings.sheetStock?.kind);
      console.log('part area', netArea(input.parts[0]));
      console.log('utilization', utilization(input, result, netArea));
      expect(result.sheets).toHaveLength(1);
      expect(utilization(input, result, netArea)).toBeCloseTo((64 / 500) * 100, 6);
    } finally {
      vi.useRealTimers();
    }
  });
});
