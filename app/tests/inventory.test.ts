import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { normalizeSheetStock, normalizeSheetStocks, stockArea } from '../src/engine/stock';
import { validate } from '../src/engine/geometry/validate';
import { solvePolygon } from '../src/engine/workers/polygonSolver';
import { solveSheets, type StripAttempt } from '../src/engine/sheets';
import {
  newProject,
  stockSheets,
  setStockSheets,
  projectJob,
  jobKey,
  utilization,
  usedUtilization,
  startBlockers,
} from '../src/project/model';
import { normalizeJob } from '../src/engine/geometry/normalize';
import { parseProject, serializeProject } from '../src/project/file';
import { netArea } from '../src/engine/geometry/validate';
const polygon = (): SheetStock =>
  normalizeSheetStock({
    id: 'L',
    name: 'L stock',
    quantity: 1,
    priority: 10,
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
const makeJob = (stock: SheetStock): Job => ({
  name: 'Polygon',
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
    sheetStock: stock,
    sheetLengthMm: stock.lengthMm,
    materialWidthMm: stock.widthMm,
  },
});
const layout = (job: Job, x = 0, y = 0): Result => ({
  documentRevision: 0,
  solverRevision: 'test',
  seed: '',
  elapsedSeconds: 0,
  usedLengthMm: Math.max(1, x + 8),
  placements: [{ partId: job.parts[0].id, copyIndex: 0, xMm: x, yMm: y, angleDeg: 0 }],
  validation: {
    status: 'pending',
    overlapAreaMm2: null,
    maxBoundaryViolationMm: null,
    minClearanceMm: null,
    errors: [],
  },
});

const virtualLayout = (job: Job, limits?: number[]): Result | undefined => {
  expect(job.settings.sheetStock).toBeUndefined();
  expect(job.settings.sheetCount).toBeUndefined();
  const boards = job.settings.virtualBoards!;
  expect(boards.length).toBeGreaterThan(0);
  const placements: Result['placements'] = [];
  const part = job.parts[0];
  const size = part.outer[1][0];
  for (const [index, board] of boards.entries()) {
    const x = Math.min(...board.outer.map(([x]) => x));
    const y = Math.min(...board.outer.map(([, y]) => y));
    const right = Math.max(...board.outer.map(([x]) => x));
    const top = Math.max(...board.outer.map(([, y]) => y));
    if (top - y < size) continue;
    const capacity = Math.min(
      Math.floor((right - x + job.settings.clearanceMm) / (size + job.settings.clearanceMm)),
      limits?.[index] ?? Infinity,
    );
    for (let copy = 0; copy < capacity && placements.length < part.quantity; copy++) {
      placements.push({
        partId: part.id,
        copyIndex: placements.length,
        xMm: x + copy * (size + job.settings.clearanceMm),
        yMm: y,
        angleDeg: 0,
      });
    }
  }
  if (placements.length !== part.quantity) return undefined;
  return {
    ...layout(job),
    placements,
    usedLengthMm: Math.max(...placements.map((placement) => placement.xMm + size)),
  };
};

describe('mixed inventory', () => {
  it('uses concave stock net area minus holes for individual and mixed-sheet utilization', () => {
    const stock = normalizeSheetStock({
      ...polygon(),
      holes: [
        [
          [2, 2],
          [6, 2],
          [6, 6],
          [2, 6],
        ],
      ],
    });
    const child = makeJob(stock);
    const result = layout(child, 0, 10);
    expect(stock.widthMm * stock.lengthMm).toBe(900);
    expect(stockArea(stock)).toBe(484);
    expect(utilization(child, result, netArea)).toBeCloseTo((64 / 484) * 100);
    expect(usedUtilization(child, result, netArea)).toBeCloseTo((64 / 224) * 100);
    expect(validate(child, result).status).toBe('passed');

    const rectangle: SheetStock = {
      id: 'rectangle',
      name: 'Rectangle',
      kind: 'rectangle',
      widthMm: 20,
      lengthMm: 20,
      quantity: 1,
      priority: 0,
    };
    const other = makeJob(rectangle);
    const batch = {
      ...result,
      sheets: [
        { job: child, result },
        { job: child, result },
        { job: other, result: layout(other) },
      ],
    };
    expect(utilization(child, batch, netArea)).toBeCloseTo((192 / (484 * 2 + 400)) * 100);
  });

  it('preserves rectangle and open-strip utilization denominators', () => {
    const child = makeJob({
      id: 'rectangle',
      name: 'Rectangle',
      kind: 'rectangle',
      widthMm: 20,
      lengthMm: 20,
      quantity: 1,
      priority: 0,
    });
    const result = layout(child);
    expect(utilization(child, result, netArea)).toBe(16);
    delete child.settings.sheetStock;
    delete child.settings.sheetLengthMm;
    expect(utilization(child, result, netArea)).toBe(40);
  });

  it('roundtrips an editable empty inventory but blocks solving', () => {
    const p = newProject('Empty');
    p.parts = makeJob(polygon()).parts;
    p.stock = setStockSheets(p.stock, []);
    expect(stockSheets(p.stock)).toEqual([]);
    expect(parseProject(JSON.parse(serializeProject(p)))).toEqual(p);
    expect(startBlockers(p).length).toBeGreaterThan(0);
    expect(() => normalizeJob(projectJob(p))).toThrow();
    p.stock = setStockSheets(p.stock, [polygon()]);
    expect(startBlockers(p)).toEqual([]);
    expect(normalizeJob(projectJob(p)).settings.sheetCount).toBe(1);
  });

  it.each([0, 5])(
    'requires full joint placement instead of accepting earlier stock counts with priority %s',
    async (priority) => {
      vi.useFakeTimers();
      try {
        const stocks: SheetStock[] = ['high', 'low'].map((id, i) => ({
          id,
          name: id,
          kind: 'rectangle',
          widthMm: 8,
          lengthMm: 104,
          quantity: 1,
          priority: i === 0 ? priority : 0,
        }));
        const job = makeJob(stocks[0]);
        delete job.settings.sheetStock;
        job.parts[0].quantity = 10;
        Object.assign(job.settings, {
          sheetStocks: stocks,
          sheetCount: 2,
          sheetCompressionSeconds: 1,
          timeLimitSeconds: 10,
        });
        const candidates: Result[] = [];
        let offeredPartial = false;
        const pending = solveSheets(
          job,
          async (child, _signal, onCandidate) => {
            if (child.parts[0].quantity !== 10) return undefined;
            if (!offeredPartial) {
              const partial = virtualLayout({
                ...child,
                parts: [{ ...child.parts[0], quantity: 8 }],
              })!;
              partial.seed = 'incomplete-demand';
              onCandidate?.(partial);
              offeredPartial = true;
              return partial;
            }
            return child.settings.virtualBoards!.length === 2
              ? virtualLayout(child, [1, 9])
              : undefined;
          },
          { onCurrentRound: (candidate) => candidates.push(candidate) },
        );
        await vi.advanceTimersByTimeAsync(10000);
        const { result } = await pending;
        expect(offeredPartial).toBe(true);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates.every((candidate) => candidate.unplaced!.length === 0)).toBe(true);
        expect(candidates.every((candidate) => candidate.seed !== 'incomplete-demand')).toBe(true);
        expect(result.unplaced).toEqual([]);
        expect(result.sheets!.map((s) => s.job.parts[0].quantity)).toEqual([1, 9]);
        expect(validate(job, result).status).toBe('passed');
        for (const sheet of result.sheets!) {
          expect(validate(sheet.job, sheet.result).status).toBe('passed');
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('adds a board after a failed joint search and resets failures before stock optimization', async () => {
    vi.useFakeTimers();
    try {
      const stock: SheetStock = {
        id: 'retry',
        name: 'retry',
        kind: 'rectangle',
        widthMm: 8,
        lengthMm: 104,
        quantity: 3,
        priority: 0,
      };
      const compact = { ...stock, id: 'compact', lengthMm: 80, quantity: 1 };
      const job = makeJob(stock);
      delete job.settings.sheetStock;
      job.parts[0].quantity = 10;
      Object.assign(job.settings, {
        sheetStocks: [stock, compact],
        sheetCount: 4,
        sheetCompressionSeconds: 1,
        timeLimitSeconds: 10,
      });
      let round = 0;
      const visits: string[] = [];
      const failures = new Map<number, number>();
      const pending = solveSheets(
        job,
        async (child) => {
          visits.push(`${round}:${child.settings.virtualBoards!.length}`);
          expect(child.parts[0].quantity).toBe(10);
          if (round === 0) return undefined;
          return virtualLayout(child);
        },
        {
          onProgress: (p) => {
            round = p.roundIndex;
            expect(p.sheetIndex).toBe(0);
            if (p.phase === 'Insertion') failures.set(round, p.insertionFailures);
          },
        },
      );
      await vi.advanceTimersByTimeAsync(10000);
      const { result } = await pending;
      expect(visits).toContain('0:1');
      expect(visits).toContain('1:2');
      expect(visits).toContain('2:1');
      expect(failures.get(0)).toBe(0);
      expect(failures.get(1)).toBe(1);
      expect(failures.get(2)).toBe(0);
      expect(result.unplaced).toEqual([]);
      expect(result.sheets!.flatMap((sheet) => sheet.result.placements)).toHaveLength(10);
      expect(validate(job, result).status).toBe('passed');
      for (const sheet of result.sheets!) {
        expect(validate(sheet.job, sheet.result).status).toBe('passed');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps gap intact on narrow high-priority stock regardless of representative width', async () => {
    const narrow: SheetStock = {
      id: 'narrow',
      name: 'narrow',
      kind: 'rectangle',
      widthMm: 5,
      lengthMm: 10,
      quantity: 1,
      priority: 10,
    };
    const wide: SheetStock = { ...narrow, id: 'wide', widthMm: 100, priority: 0 };
    const p = newProject('Narrow');
    p.parts = [
      {
        ...newPart([
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ]),
        rotations: { kind: 'discrete', degrees: [0] },
      },
    ];
    p.machines[0].gapMm = 10;
    for (const stocks of [
      [wide, narrow],
      [narrow, wide],
    ]) {
      p.stock = setStockSheets(p.stock, stocks);
      expect(startBlockers(p)).toEqual([]);
      expect(() => normalizeJob(projectJob(p))).not.toThrow();
    }
    const child = makeJob(narrow);
    child.parts = p.parts as Job['parts'];
    child.settings.clearanceMm = 10;
    const result = await solvePolygon(child, undefined, undefined, 500);
    expect(result).toBeDefined();
    expect(validate(child, result!).status).toBe('passed');
    expect(child.settings.clearanceMm).toBe(10);
    vi.useFakeTimers();
    try {
      const job = projectJob(p);
      job.settings.timeLimitSeconds = 10;
      job.settings.sheetCompressionSeconds = 1;
      const pending = solveSheets(job, async (candidate) => {
        normalizeJob(candidate);
        const r = layout(candidate);
        r.usedLengthMm = 4;
        return r;
      });
      await vi.advanceTimersByTimeAsync(10000);
      const outcome = await pending;
      expect(outcome.result.unplaced).toEqual([]);
      expect(outcome.result.sheets![0].job.settings.sheetStock!.id).toBe('narrow');
      expect(outcome.result.sheets![0].job.settings.clearanceMm).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
  it('normalizes polygon origin and dimensions, computes net area and enforces bounds', () => {
    const stock = polygon();
    expect(stock.lengthMm).toBe(30);
    expect(stock.widthMm).toBe(30);
    expect(stockArea(stock)).toBe(500);
    expect(
      normalizeSheetStocks([
        { ...stock, quantity: 500 },
        { ...stock, id: 'other' },
      ]),
    ).toHaveLength(2);
    expect(() => normalizeSheetStock({ ...stock, priority: 0.5 })).toThrow();
    expect(() => normalizeSheetStock({ ...stock, quantity: 0 })).toThrow();
  });
  it('migrates legacy rectangle, roundtrips explicit inventory and keys all geometry', () => {
    const p = newProject('Legacy');
    p.stock = { packing: 'sheets', strip: p.stock.strip, lengthMm: 40, quantity: 2 };
    expect(stockSheets(p.stock)[0]).toMatchObject({ kind: 'rectangle', quantity: 2, lengthMm: 40 });
    const before = projectJob(p);
    p.stock = setStockSheets(p.stock, [polygon()]);
    expect(projectJob(p).settings.sheetStocks).toHaveLength(1);
    expect(jobKey(before)).not.toBe(jobKey(projectJob(p)));
    const changed = structuredClone(projectJob(p));
    changed.settings.sheetStocks![0].priority++;
    expect(jobKey(changed)).not.toBe(jobKey(projectJob(p)));
  });
  it('reports exhausted stock with conserved unplaced quantities', async () => {
    vi.useFakeTimers();
    try {
      const stock: SheetStock = {
        id: 'only',
        name: 'only',
        kind: 'rectangle',
        widthMm: 8,
        lengthMm: 8,
        quantity: 1,
        priority: 0,
      };
      const job = makeJob(stock);
      delete job.settings.sheetStock;
      job.parts[0].quantity = 2;
      Object.assign(job.settings, {
        sheetStocks: [stock],
        sheetCount: 1,
        sheetCompressionSeconds: 1,
        timeLimitSeconds: null,
      });
      const pending = solveSheets(job, async (child) =>
        child.parts[0].quantity === 1 ? layout(child) : undefined,
      );
      await vi.advanceTimersByTimeAsync(5000);
      const outcome = await pending;
      expect(outcome.reason).toBe('StockExhausted');
      expect(outcome.result.sheets).toHaveLength(1);
      expect(outcome.result.unplaced).toEqual([{ partId: job.parts[0].id, quantity: 1 }]);
      expect(validate(job, outcome.result).status).toBe('passed');
    } finally {
      vi.useRealTimers();
    }
  });
  it('uses priority then list order across dimensions, preserves inventory and rejects tampering', async () => {
    vi.useFakeTimers();
    try {
      const stocks: SheetStock[] = [
        {
          id: 'low',
          name: 'low',
          kind: 'rectangle',
          lengthMm: 24,
          widthMm: 8,
          quantity: 1,
          priority: 0,
        },
        {
          id: 'high',
          name: 'high',
          kind: 'rectangle',
          lengthMm: 8,
          widthMm: 8,
          quantity: 1,
          priority: 5,
        },
        {
          id: 'equal',
          name: 'equal',
          kind: 'rectangle',
          lengthMm: 8,
          widthMm: 8,
          quantity: 1,
          priority: 5,
        },
      ];
      const input = makeJob(stocks[0]);
      delete input.settings.sheetStock;
      input.parts[0].quantity = 3;
      Object.assign(input.settings, {
        sheetStocks: stocks,
        sheetCount: 3,
        sheetCompressionSeconds: 1,
        timeLimitSeconds: 10,
      });
      const solve: StripAttempt = async (child) => virtualLayout(child);
      const before = JSON.stringify(input);
      const pending = solveSheets(input, solve);
      await vi.advanceTimersByTimeAsync(10000);
      const { result } = await pending;
      expect(result.sheets!.map((s) => s.job.settings.sheetStock!.id)).toEqual([
        'high',
        'equal',
        'low',
      ]);
      expect(validate(input, result).status).toBe('passed');
      for (const sheet of result.sheets!) {
        expect(validate(sheet.job, sheet.result).status).toBe('passed');
      }
      expect(JSON.stringify(input)).toBe(before);
      expect(result.unplaced).toEqual([]);
      const corrupt = structuredClone(result);
      corrupt.sheets![0].job.settings.sheetStock!.quantity = 2;
      expect(validate(input, corrupt).status).toBe('failed');
      expect(utilization(input, result, netArea)).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe('polygon placement and validation', () => {
  it('compresses across all discrete angles independently of their order', async () => {
    const stock = normalizeSheetStock({
      ...polygon(),
      outer: [
        [0, 0],
        [30, 0],
        [30, 30],
        [0, 30],
      ],
      holes: [],
    });
    for (const degrees of [
      [0, 90],
      [90, 0],
    ]) {
      const job = makeJob(stock);
      job.parts[0].outer = [
        [0, 0],
        [20, 0],
        [20, 10],
        [0, 10],
      ];
      job.parts[0].rotations = { kind: 'discrete', degrees };
      const result = await solvePolygon(job, undefined, undefined, 1000);
      expect(result?.usedLengthMm).toBeCloseTo(10);
      expect(result?.placements[0].angleDeg).toBe(90);
      expect(validate(job, result!).status).toBe('passed');
    }
  });
  it('rejects a cross-concavity edge even when its endpoints are inside', () => {
    const job = makeJob(polygon());
    job.parts[0].outer = [
      [1, 1],
      [25, 1],
      [1, 25],
    ];
    const r = layout(job);
    r.usedLengthMm = 30;
    expect(validate(job, r).status).toBe('failed');
  });
  it('rejects a stock hole fully covered by a part and keeps clearance checks', () => {
    const stock = normalizeSheetStock({
      id: 'hole',
      name: 'hole',
      kind: 'polygon',
      quantity: 1,
      priority: 0,
      widthMm: 20,
      lengthMm: 20,
      outer: [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      holes: [
        [
          [3, 3],
          [5, 3],
          [5, 5],
          [3, 5],
        ],
      ],
    });
    const job = makeJob(stock);
    expect(validate(job, layout(job)).status).toBe('failed');
    expect(validate(job, layout(job, 10, 0)).status).toBe('passed');
    job.settings.clearanceMm = 2;
    job.parts[0].quantity = 2;
    const r = layout(job, 10, 0);
    r.usedLengthMm = 18;
    r.placements.push({ ...r.placements[0], copyIndex: 1, yMm: 9 });
    expect(validate(job, r).status).toBe('failed');
  });
  it('finds a non-origin placement beside a hole, with discrete and sampled free rotations', async () => {
    const stock = normalizeSheetStock({
      id: 'hole',
      name: 'hole',
      kind: 'polygon',
      quantity: 1,
      priority: 0,
      widthMm: 20,
      lengthMm: 20,
      outer: [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ],
      holes: [
        [
          [1, 1],
          [9, 1],
          [9, 9],
          [1, 9],
        ],
      ],
    });
    const job = makeJob(stock);
    const result = await solvePolygon(job, undefined, undefined, 800);
    expect(result).toBeDefined();
    expect(result!.placements[0].xMm + result!.placements[0].yMm).toBeGreaterThan(0);
    expect(validate(job, result!).status).toBe('passed');
    job.settings.sheetStock = { ...stock, holes: [] };
    job.parts[0].outer = [
      [0, 0],
      [22, 0],
      [22, 2],
      [0, 2],
    ];
    job.parts[0].rotations = { kind: 'discrete', degrees: [45] };
    const diagonal = await solvePolygon(job, undefined, undefined, 800);
    expect(diagonal?.placements[0].angleDeg).toBe(45);
    job.parts[0].rotations = { kind: 'continuous' };
    const free = await solvePolygon(job, undefined, undefined, 800);
    expect(free).toBeDefined();
  });
  it('honors pre-abort and short deadline without producing invalid candidates', async () => {
    const job = makeJob(polygon());
    const controller = new AbortController();
    controller.abort();
    expect(await solvePolygon(job, controller.signal, undefined, 500)).toBeUndefined();
    expect(await solvePolygon(job, undefined, undefined, 0)).toBeUndefined();
    job.parts[0].outer = [
      [0, 0],
      [50, 0],
      [50, 50],
      [0, 50],
    ];
    const active = new AbortController();
    setTimeout(() => active.abort(), 10);
    const start = performance.now();
    expect(await solvePolygon(job, active.signal, undefined, 1000)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(300);
  });
});
