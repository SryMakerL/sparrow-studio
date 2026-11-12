import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { normalizePart } from '../src/engine/geometry/normalize';
import { validate } from '../src/engine/geometry/validate';
import { importSparrow, solverInput } from '../src/engine/import/sparrow';
import { solveSheets, type StripAttempt } from '../src/engine/sheets';
import { solvePolygon } from '../src/engine/workers/polygonSolver';
import { addParts, jobKey, newProject, projectJob } from '../src/project/model';
import { parseProject, serializeProject } from '../src/project/file';

const square = (size: number, priority = 0, quantity = 1) => ({
  ...newPart([
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ]),
  priority,
  quantity,
  rotations: { kind: 'discrete' as const, degrees: [0] },
});
const virtualLayout = (job: Job): Result | undefined => {
  expect(job.settings.sheetStock).toBeUndefined();
  expect(job.settings.sheetCount).toBeUndefined();
  const boards = job.settings.virtualBoards!.map((board) => ({
    left: Math.min(...board.outer.map(([x]) => x)),
    right: Math.max(...board.outer.map(([x]) => x)),
    top: Math.max(...board.outer.map(([, y]) => y)),
    x: Math.min(...board.outer.map(([x]) => x)),
    y: Math.min(...board.outer.map(([, y]) => y)),
    rowHeight: 0,
  }));
  const placements: Result['placements'] = [];
  let usedLengthMm = 0;
  for (const part of job.parts) {
    const size = part.outer[1][0];
    for (let copyIndex = 0; copyIndex < part.quantity; copyIndex++) {
      let placed = false;
      for (const board of boards) {
        if (board.x + size > board.right) {
          board.x = board.left;
          board.y += board.rowHeight + job.settings.clearanceMm;
          board.rowHeight = 0;
        }
        if (board.x + size > board.right || board.y + size > board.top) continue;
        placements.push({
          partId: part.id,
          copyIndex,
          xMm: board.x,
          yMm: board.y,
          angleDeg: 0,
        });
        usedLengthMm = Math.max(usedLengthMm, board.x + size);
        board.x += size + job.settings.clearanceMm;
        board.rowHeight = Math.max(board.rowHeight, size);
        placed = true;
        break;
      }
      if (!placed) return undefined;
    }
  }
  return {
    documentRevision: 0,
    solverRevision: 'test',
    seed: '',
    elapsedSeconds: 0,
    usedLengthMm,
    placements,
    validation: {
      status: 'pending',
      overlapAreaMm2: null,
      maxBoundaryViolationMm: null,
      minClearanceMm: null,
      errors: [],
    },
  };
};
const row: StripAttempt = async (job) => virtualLayout(job);
const sheetJob = (parts: Job['parts']): Job => ({
  name: 'Priority',
  parts,
  settings: {
    ...DEFAULT_SETTINGS,
    materialWidthMm: 10,
    sheetLengthMm: 10,
    sheetCount: 1,
    sheetCompressionSeconds: 1,
    timeLimitSeconds: 10,
  },
});

afterEach(() => vi.useRealTimers());

describe('part priorities', () => {
  it('defaults legacy parts to zero and preserves priorities through project files', () => {
    const project = addParts(newProject('Priority'), [square(10, 9)]);
    expect(parseProject(JSON.parse(serializeProject(project))).parts[0].priority).toBe(9);
    const legacy = JSON.parse(serializeProject(project));
    delete legacy.parts[0].priority;
    expect(parseProject(legacy).parts[0].priority).toBe(0);
    const job = projectJob(project);
    expect(jobKey({ ...job, parts: [{ ...job.parts[0], priority: 0 }] })).not.toBe(jobKey(job));
    expect(newPart(square(1).outer).priority).toBe(0);
  });

  it.each([-1, 1.5, NaN, Infinity, null, '1', 2147483648])(
    'rejects invalid priority %s',
    (priority) => {
      expect(() => normalizePart({ ...square(1), priority: priority as number })).toThrow(
        'priority',
      );
    },
  );

  it('imports and forwards priorities without changing solver item IDs', () => {
    const data = {
      name: 'Priority',
      strip_height: 10,
      items: [
        { id: 0, demand: 1, priority: 0, shape: { type: 'simple_polygon', data: square(2).outer } },
        { id: 1, demand: 1, priority: 7, shape: { type: 'simple_polygon', data: square(1).outer } },
      ],
    };
    const job = importSparrow(JSON.stringify(data), 'parts.json', 1).document;
    expect(job.parts.map((part) => part.priority)).toEqual([0, 7]);
    expect(
      JSON.parse(solverInput(job)).items.map(
        ({ id, priority }: { id: number; priority: number }) => [id, priority],
      ),
    ).toEqual([
      [0, 0],
      [1, 7],
    ]);
    const legacy = JSON.parse(JSON.stringify(data));
    delete legacy.items[1].priority;
    expect(importSparrow(JSON.stringify(legacy), 'parts.json', 1).document.parts[1].priority).toBe(
      0,
    );
  });

  it('orders joint demand by priority and removes the larger low-priority part after failure', async () => {
    vi.useFakeTimers();
    const low = square(10),
      high = square(6, 5);
    const input = sheetJob([low, high]);
    let round = 0;
    const demands = new Map<number, { id: string; quantity: number }[]>();
    const pending = solveSheets(
      input,
      async (job) => {
        if (!demands.has(round)) {
          demands.set(round, job.parts.map(({ id, quantity }) => ({ id, quantity })));
        }
        return virtualLayout(job);
      },
      {
        onProgress: (progress) => {
          round = progress.roundIndex;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(demands.get(0)).toEqual([
      { id: high.id, quantity: 1 },
      { id: low.id, quantity: 1 },
    ]);
    expect(demands.get(1)).toEqual([{ id: high.id, quantity: 1 }]);
    expect(outcome.result.sheets!.flatMap((sheet) => sheet.result.placements)
      .map((placement) => placement.partId)).toEqual([high.id]);
    expect(outcome.result.unplaced).toEqual([{ partId: low.id, quantity: 1 }]);
    expect(validate(input, outcome.result).status).toBe('passed');
    for (const sheet of outcome.result.sheets!) {
      expect(validate(sheet.job, sheet.result).status).toBe('passed');
    }
  });

  it('preserves one high-priority copy while reducing two low-priority copies after joint failures', async () => {
    vi.useFakeTimers();
    const low = square(5, 0, 2),
      high = square(10, 5);
    const input = sheetJob([low, high]);
    let round = 0;
    const demands = new Map<number, { high: number; low: number }>();
    const candidates: Result[] = [];
    const pending = solveSheets(
      input,
      async (job) => {
        demands.set(round, {
          high: job.parts.find((part) => part.id === high.id)?.quantity ?? 0,
          low: job.parts.find((part) => part.id === low.id)?.quantity ?? 0,
        });
        return virtualLayout(job);
      },
      {
        onProgress: (progress) => {
          round = progress.roundIndex;
        },
        onCurrentRound: (result) => candidates.push(result),
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(demands.get(0)).toEqual({ high: 1, low: 2 });
    expect(demands.get(1)).toEqual({ high: 1, low: 1 });
    expect(demands.get(2)).toEqual({ high: 1, low: 0 });
    expect([...demands.values()].every((demand) => demand.high === 1)).toBe(true);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((result) => result.sheets!.flatMap((sheet) => sheet.result.placements)
      .every((placement) => placement.partId === high.id))).toBe(true);
    expect(outcome.result.sheets![0].job.parts).toEqual([{ ...high, quantity: 1 }]);
    expect(outcome.result.unplaced).toEqual([{ partId: low.id, quantity: 2 }]);
    expect(validate(input, outcome.result).status).toBe('passed');
    for (const sheet of outcome.result.sheets!) {
      expect(validate(sheet.job, sheet.result).status).toBe('passed');
    }
  });

  it('still fills stock with low-priority parts when a high-priority part cannot fit', async () => {
    vi.useFakeTimers();
    const low = square(5),
      high = square(20, 5);
    const pending = solveSheets(sheetJob([high, low]), row);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(outcome.result.sheets![0].job.parts[0].id).toBe(low.id);
    expect(outcome.result.unplaced).toEqual([{ partId: high.id, quantity: 1 }]);
  });

  it('places high-priority parts first in the geometry solver', async () => {
    const low = square(4),
      high = square(2, 5);
    const job = sheetJob([low, high]);
    delete job.settings.sheetCount;
    job.settings.solverPreset = 'fast';
    job.settings.sheetStock = {
      id: 'sheet',
      name: 'Sheet',
      kind: 'rectangle',
      quantity: 1,
      priority: 0,
      widthMm: 10,
      lengthMm: 10,
    };
    const result = await solvePolygon(job, undefined, undefined, 2500);
    expect(result?.placements.map((placement) => placement.partId)).toEqual([high.id, low.id]);
  });
});
