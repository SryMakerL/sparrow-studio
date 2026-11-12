import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  SOLVER_REVISION,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { solveSheets, type StripAttempt } from '../src/engine/sheets';
import { validate } from '../src/engine/geometry/validate';
import { normalizeJob, bounds } from '../src/engine/geometry/normalize';
import {
  canUseStock,
  selectBoards,
  splitVirtualResult,
  stitchBoards,
} from '../src/engine/virtualSheets';
import { solverInput } from '../src/engine/import/sparrow';
import { addParts, jobKey, newProject, projectJob, startBlockers } from '../src/project/model';
import { parseProject, serializeProject } from '../src/project/file';

const part = (size: number, quantity: number) => ({
  ...newPart([
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ]),
  quantity,
  rotations: { kind: 'discrete' as const, degrees: [0] },
});
const job = (quantity = 5, count = 3): Job => ({
  name: 'Sheets',
  parts: [part(10, quantity)],
  settings: {
    ...DEFAULT_SETTINGS,
    materialWidthMm: 10,
    sheetLengthMm: 20,
    sheetCount: count,
    sheetCompressionSeconds: 1,
  },
});
const result = (placements: Result['placements'], length: number): Result => ({
  documentRevision: 0,
  solverRevision: SOLVER_REVISION,
  seed: 'test',
  elapsedSeconds: 0,
  placements,
  usedLengthMm: length,
  validation: {
    status: 'pending',
    overlapAreaMm2: null,
    maxBoundaryViolationMm: null,
    minClearanceMm: null,
    errors: [],
  },
});
const virtualRow: StripAttempt = async (input) => {
  const domains = input.settings.virtualBoards!;
  let board = 0,
    x = bounds(domains[0].outer)[0];
  const placements: Result['placements'] = [];
  for (const p of input.parts) {
    const box = bounds(p.outer),
      width = box[2] - box[0],
      height = box[3] - box[1];
    for (let copyIndex = 0; copyIndex < p.quantity; copyIndex++) {
      while (board < domains.length) {
        const b = bounds(domains[board].outer);
        if (height <= b[3] - b[1] && x + width <= b[2] + 1e-6) break;
        board++;
        if (board < domains.length) x = bounds(domains[board].outer)[0];
      }
      if (board === domains.length) return;
      placements.push({ partId: p.id, copyIndex, xMm: x - box[0], yMm: -box[1], angleDeg: 0 });
      x += width;
    }
  }
  return result(placements, x);
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function finish(pending: ReturnType<typeof solveSheets>, ms = 100) {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}

describe('joint virtual sheet solver', () => {
  it('solves selected boards together and restores local coordinates and copy indices', async () => {
    const input = job();
    const calls: Job[] = [];
    const solve: StripAttempt = async (child) => {
      calls.push(child);
      return virtualRow(child);
    };
    solve.beginSheet = vi.fn();
    solve.endSheet = vi.fn();
    const { result: output } = await finish(solveSheets(input, solve));
    expect(output.unplaced).toEqual([]);
    expect(output.sheets!.map((sheet) => sheet.result.placements.length)).toEqual([2, 2, 1]);
    expect(calls[0].parts[0].quantity).toBe(5);
    expect(calls[0].settings.virtualBoards).toHaveLength(3);
    expect(
      calls.every(
        (child) =>
          child.settings.sheetCount === undefined && child.settings.sheetStock === undefined,
      ),
    ).toBe(true);
    expect(output.sheets![1].result.placements[0].xMm).toBe(0);
    expect(output.sheets![1].result.placements.map((p) => p.copyIndex)).toEqual([0, 1]);
    expect(validate(input, output).status).toBe('passed');
    expect(solve.beginSheet).toHaveBeenCalledTimes(1);
  });
  it('accepts an evacuated first board even when the virtual right boundary grows', async () => {
    const input = job(3, 2);
    input.settings.sheetLengthMm = 30;
    let compressed = false;
    const solve: StripAttempt = async (child, _signal, offer, _budget, initial) => {
      const domains = child.settings.virtualBoards!;
      if (domains.length < 2) return;
      const p = child.parts[0];
      const next = result(
        [0, 31, 41].map((xMm, copyIndex) => ({
          partId: p.id,
          copyIndex,
          xMm,
          yMm: 0,
          angleDeg: 0,
        })),
        51,
      );
      if (!initial) return next;
      compressed = true;
      const evacuated = result(
        [31, 41, 51].map((xMm, copyIndex) => ({
          partId: p.id,
          copyIndex,
          xMm,
          yMm: 0,
          angleDeg: 0,
        })),
        61,
      );
      offer?.(evacuated);
      return evacuated;
    };
    const snapshots: Result[] = [];
    const outcome = await finish(solveSheets(input, solve, { onSheet: (r) => snapshots.push(r) }));
    expect(compressed).toBe(true);
    expect(outcome.result.unplaced).toEqual([]);
    expect(outcome.result.sheets).toHaveLength(1);
    expect(snapshots.some((r) => r.sheets?.length === 2)).toBe(true);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('uses positive separators and serializes unrotated board domains', () => {
    const input = job();
    input.settings.clearanceMm = 4;
    const stocks: SheetStock[] = [
      {
        id: 'a',
        name: 'a',
        kind: 'rectangle',
        lengthMm: 20,
        widthMm: 10,
        quantity: 1,
        priority: 0,
      },
      {
        id: 'b',
        name: 'b',
        kind: 'rectangle',
        lengthMm: 30,
        widthMm: 15,
        quantity: 1,
        priority: 0,
      },
    ];
    const virtual = stitchBoards(input, stocks);
    expect(virtual.boards.map((board) => board.xMm)).toEqual([0, 24]);
    expect(virtual.job.settings.materialWidthMm).toBe(15);
    expect(virtual.job.settings.sheetLengthMm).toBe(54);
    expect(virtual.job.settings.virtualBoards![1].outer).toEqual([
      [24, 0],
      [54, 0],
      [54, 15],
      [24, 15],
    ]);
    expect(JSON.parse(solverInput(virtual.job)).stock_geometry.boards).toEqual(
      virtual.job.settings.virtualBoards,
    );
  });
  it('rejects a seam crossing instead of clipping or assigning by center', () => {
    const input = job(1, 2);
    const stock: SheetStock = {
      id: 's',
      name: 's',
      kind: 'rectangle',
      lengthMm: 20,
      widthMm: 10,
      quantity: 2,
      priority: 0,
    };
    const virtual = stitchBoards(input, [stock, stock]);
    const bad = result(
      [{ partId: input.parts[0].id, copyIndex: 0, xMm: 16, yMm: 0, angleDeg: 0 }],
      26,
    );
    expect(splitVirtualResult(input, virtual, bad)).toBeUndefined();
    expect(validate(virtual.job, bad).status).toBe('failed');
  });
  it('rejects stock holes through independent physical-board validation', async () => {
    const input = job(1, 1);
    input.settings.sheetStocks = [
      {
        id: 'hole',
        name: 'hole',
        kind: 'polygon',
        quantity: 1,
        priority: 0,
        lengthMm: 20,
        widthMm: 20,
        outer: [
          [0, 0],
          [20, 0],
          [20, 20],
          [0, 20],
        ],
        holes: [
          [
            [2, 2],
            [4, 2],
            [4, 4],
            [2, 4],
          ],
        ],
      },
    ];
    const { result: output } = await finish(solveSheets(input, virtualRow));
    expect(output.sheets).toEqual([]);
    expect(output.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 1 }]);
  });
  it('grows a geometrically insufficient selection', async () => {
    const input = job(3, 3);
    input.parts = [part(11, 3)];
    input.settings.materialWidthMm = 15;
    const sizes: number[] = [];
    const { result: output } = await finish(
      solveSheets(input, async (child) => {
        sizes.push(child.settings.virtualBoards!.length);
        return virtualRow(child);
      }),
    );
    expect(sizes[0]).toBe(2);
    expect(sizes).toContain(3);
    expect(output.unplaced).toEqual([]);
    expect(validate(input, output).status).toBe('passed');
  });
  it('discards unused boards and tries smaller combinations after success', async () => {
    const input = job(3, 3);
    const sizes: number[] = [];
    const { result: output } = await finish(
      solveSheets(input, async (child) => {
        sizes.push(child.settings.virtualBoards!.length);
        return virtualRow(child);
      }),
    );
    expect(output.sheets).toHaveLength(2);
    expect(sizes).toContain(2);
    expect(output.unplaced).toEqual([]);
  });
  it('replaces oversized stock with a smaller available board at equal priority', async () => {
    const input = job(1, 2);
    input.settings.sheetStocks = [
      {
        id: 'large',
        name: 'large',
        kind: 'rectangle',
        quantity: 1,
        priority: 0,
        lengthMm: 100,
        widthMm: 10,
      },
      {
        id: 'small',
        name: 'small',
        kind: 'rectangle',
        quantity: 1,
        priority: 0,
        lengthMm: 20,
        widthMm: 10,
      },
    ];
    const { result: output } = await finish(solveSheets(input, virtualRow));
    expect(output.sheets![0].job.settings.sheetStock!.id).toBe('small');
    expect(output.unplaced).toEqual([]);
    expect(validate(input, output).status).toBe('passed');
  });
  it('conserves unplaced quantities when inventory is exhausted', async () => {
    const input = job(3, 1);
    const { result: output, reason } = await finish(solveSheets(input, virtualRow));
    expect(reason).toBe('StockExhausted');
    expect(output.sheets![0].result.placements).toHaveLength(2);
    expect(output.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 1 }]);
    expect(validate(input, output).status).toBe('passed');
  });
  it('keeps high priority demand when reducing infeasible quantities', async () => {
    const input = job(1, 1);
    input.settings.sheetLengthMm = 10;
    const high = { ...part(10, 1), priority: 10 },
      low = { ...part(10, 1), priority: 0 };
    input.parts = [low, high];
    const { result: output } = await finish(solveSheets(input, virtualRow));
    expect(output.sheets![0].job.parts.map((p) => p.id)).toEqual([high.id]);
    expect(output.unplaced).toEqual([{ partId: low.id, quantity: 1 }]);
  });
  it('cancels uncooperative solvers and ignores late candidates', async () => {
    const controller = new AbortController();
    let offer: ((r: Result) => void) | undefined;
    const solve: StripAttempt = async (_child, _signal, candidate) => {
      offer = candidate;
      return new Promise(() => {});
    };
    const publish = vi.fn();
    const pending = solveSheets(job(), solve, { signal: controller.signal, onSheet: publish });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const outcome = await pending;
    expect(outcome.reason).toBe('Stopped');
    offer?.(result([], 1));
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([null, 30] as const)(
    'ignores legacy combination cap with total limit %s',
    async (seconds) => {
      const input = job();
      input.settings.timeLimitSeconds = seconds;
      input.settings.sheetCompressionSeconds = 1;
      const controller = new AbortController();
      let received: number | undefined,
        settled = false;
      const pending = solveSheets(
        input,
        async (_child, _signal, _offer, budget) => {
          received = budget;
          return new Promise(() => {});
        },
        { signal: controller.signal },
      ).then((outcome) => {
        settled = true;
        return outcome;
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(settled).toBe(false);
      expect(received).toBe(seconds === null ? Infinity : 30000);
      controller.abort();
      expect((await pending).reason).toBe('Stopped');
    },
  );
  it('bounds combinations and the overall deadline', async () => {
    const input = job();
    input.settings.timeLimitSeconds = 10;
    let calls = 0;
    const pending = solveSheets(input, async () => {
      calls++;
      return new Promise(() => {});
    });
    const outcome = await finish(pending, 11_000);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(10);
    expect(outcome.result.elapsedSeconds).toBeLessThanOrEqual(10.1);
  });
  it('propagates infrastructure failures', async () => {
    await expect(
      solveSheets(job(), async () => {
        throw Error('WASM failed');
      }),
    ).rejects.toThrow('WASM failed');
  });
  it('uses independent validation rather than trusting solver status', async () => {
    const verify = vi.fn(async (input: Job, candidate: Result) => validate(input, candidate));
    const output = await finish(solveSheets(job(), virtualRow, { validate: verify }));
    expect(verify).toHaveBeenCalled();
    expect(output.result.validation.status).toBe('passed');
  });
});

describe('stock selection and compatibility', () => {
  it('selects compatible stock without rotating physical boards', () => {
    const input = job(1, 2),
      p = part(10, 1);
    const narrow: SheetStock = {
      id: 'narrow',
      name: 'narrow',
      kind: 'rectangle',
      quantity: 1,
      priority: 99,
      lengthMm: 30,
      widthMm: 5,
    };
    const suitable: SheetStock = { ...narrow, id: 'wide', widthMm: 10, priority: 1 };
    input.settings.sheetStocks = [narrow, suitable];
    expect(canUseStock(p, narrow)).toBe(false);
    expect(selectBoards(input, [p]).map((stock) => stock.id)).toEqual(['wide']);
  });
  it('allows long internal containers but preserves physical sheet limits', () => {
    const input = job(1, 2);
    const stock: SheetStock = {
      id: 'long',
      name: 'long',
      kind: 'rectangle',
      quantity: 2,
      priority: 0,
      lengthMm: 80_000,
      widthMm: 10,
    };
    const virtual = stitchBoards(input, [stock, stock]);
    expect(normalizeJob(virtual.job).settings.sheetLengthMm).toBe(160_001);
    expect(() =>
      normalizeJob({
        ...virtual.job,
        settings: { ...virtual.job.settings, virtualBoards: undefined },
      }),
    ).toThrow();
  });
  it('roundtrips legacy settings without changing layout keys', () => {
    const project = addParts(newProject('Job'), [part(10, 1)]);
    const legacy = JSON.parse(serializeProject(project));
    delete legacy.settings.sheetCompressionSeconds;
    delete legacy.settings.sheetInsertionFailures;
    expect(parseProject(legacy).settings).toMatchObject({
      sheetInsertionFailures: 3,
    });
    expect(parseProject(legacy).settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(project.settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(projectJob(project).settings).not.toHaveProperty('sheetCompressionSeconds');
    const configured = {
      ...project,
      settings: { ...project.settings, sheetCompressionSeconds: 2, sheetInsertionFailures: 5 },
    };
    expect(parseProject(JSON.parse(serializeProject(configured)))).toEqual(configured);
    expect(projectJob(configured).settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(normalizeJob(projectJob(configured)).settings).not.toHaveProperty(
      'sheetCompressionSeconds',
    );
    expect(jobKey(projectJob(configured))).toBe(jobKey(projectJob(project)));
    expect(startBlockers(configured)).toEqual([]);
  });
});
