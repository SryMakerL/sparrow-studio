import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { normalizePart } from '../src/engine/geometry/normalize';
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
const row: StripAttempt = async (job) => {
  let x = 0;
  const placements = job.parts.flatMap((part) =>
    Array.from({ length: part.quantity }, (_, copyIndex) => {
      const placement = { partId: part.id, copyIndex, xMm: x, yMm: 0, angleDeg: 0 };
      x += part.outer[1][0];
      return placement;
    }),
  );
  return {
    documentRevision: 0,
    solverRevision: 'test',
    seed: '',
    elapsedSeconds: 0,
    usedLengthMm: x,
    placements,
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
};
const sheetJob = (parts: Job['parts']): Job => ({
  name: 'Priority',
  parts,
  settings: {
    ...DEFAULT_SETTINGS,
    materialWidthMm: 10,
    sheetLengthMm: 10,
    sheetCount: 1,
    sheetStagnationSeconds: 1,
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

  it('selects smaller high-priority parts before larger low-priority parts in every round', async () => {
    vi.useFakeTimers();
    const low = square(10),
      high = square(6, 5);
    let round = 0;
    const first = new Map<number, string>();
    const pending = solveSheets(
      sheetJob([low, high]),
      async (job) => {
        if (!first.has(round)) first.set(round, job.parts[0].id);
        return row(job);
      },
      {
        onProgress: (progress) => {
          round = progress.roundIndex;
        },
      },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    expect(first.size).toBeGreaterThan(1);
    expect([...first.values()].every((id) => id === high.id)).toBe(true);
    expect(outcome.result.unplaced).toEqual([{ partId: low.id, quantity: 1 }]);
  });

  it('does not replace one high-priority copy with two low-priority copies in a later round', async () => {
    vi.useFakeTimers();
    const low = square(5, 0, 2),
      high = square(10, 5);
    let round = 0;
    const candidates: Result[] = [];
    const pending = solveSheets(
      sheetJob([low, high]),
      async (job) => {
        if (round > 0 && job.parts.some((part) => part.id === high.id)) return undefined;
        return row(job);
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
    expect(candidates.some((result) => result.sheets?.[0]?.job.parts[0].id === low.id)).toBe(true);
    expect(outcome.result.sheets![0].job.parts[0].id).toBe(high.id);
    expect(outcome.result.unplaced).toEqual([{ partId: low.id, quantity: 2 }]);
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
