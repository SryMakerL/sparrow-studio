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

<<<<<<< HEAD
describe('fixed sheet phases', () => {
  it.each([undefined, 2])(
    'selects, fully inserts, then keeps compressing complete single-sheet demand (%s seconds)',
    async (seconds) => {
      const input = job(3, 1);
      input.settings.sheetLengthMm = 40;
      input.settings.sheetCompressionSeconds = seconds;
      const calls: string[] = [];
      const budgets: number[] = [];
      let seeded = false;
      const solve: StripAttempt = async (child, _signal, _offer, budget, initial) => {
        const n = quantity(child);
        calls.push(
          `${initial ? (n === initial.placements.length ? 'compress' : 'warm') : 'cold'}:${n}`,
        );
        budgets.push(budget!);
        if (!initial && n === 3 && !seeded) return undefined;
        seeded = true;
        return row(child);
      };
      solve.continueSheet = vi.fn(() => {
        throw Error('continuous must not run');
      });
      const controller = new AbortController();
      const pending = solveSheets(input, solve, {
        signal: controller.signal,
        onProgress: (p) => expect(p.roundIndex).toBe(0),
      });
      await vi.advanceTimersByTimeAsync(250);
      expect(calls).toEqual([
        'cold:3',
        'cold:1',
        'warm:2',
        'warm:3',
        'compress:3',
        'compress:3',
        'compress:3',
      ]);
      expect(budgets).toEqual([
        2500,
        2500,
        10_000,
        10_000,
        ...Array(3).fill((seconds ?? 10) * 1000),
      ]);
      controller.abort();
      const outcome = await pending;
      expect(outcome.reason).toBe('Stopped');
      expect(solve.continueSheet).not.toHaveBeenCalled();
      expect(outcome.result.unplaced).toEqual([]);
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );

  it('finishes the final sheet after the compression product window even with spare stock', async () => {
    const input = job(1, 4, 10);
    input.settings.sheetCompressionSeconds = 3;
    const budgets: number[] = [];
    const signals: AbortSignal[] = [];
    const starts: number[] = [];
    const sheets: number[] = [];
    const pending = solveSheets(
      input,
      async (child, signal, _offer, budget, initial) => {
        if (!initial) return row(child);
        budgets.push(budget!);
        signals.push(signal!);
        starts.push(performance.now());
        return new Promise(() => {});
      },
      { onProgress: (p) => sheets.push(p.sheetIndex) },
    );
    const outcome = await finish(pending, 10_000);
    expect(budgets).toEqual([3000, 3000, 2800]);
    expect(starts.slice(1).map((at, i) => at - starts[i])).toEqual([3100, 3100]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(new Set(sheets)).toEqual(new Set([0, 1]));
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.elapsedSeconds).toBe(
      input.settings.sheetCompressionSeconds! * (input.settings.sheetInsertionFailures ?? 3),
    );
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(budgets).toHaveLength(3);
  });

  it.each(['complete', 'stop'] as const)(
    'ends automatic single-sheet compression at the product window or early %s',
    async (end) => {
      const input = job(1, 1);
      input.settings.sheetCompressionSeconds = 1;
      input.settings.sheetInsertionFailures = 3;
      const controller = new AbortController();
      const signals: AbortSignal[] = [];
      const budgets: number[] = [];
      const rounds: number[] = [];
      let settled = false;
      const pending = solveSheets(
        input,
        async (child, signal, _offer, budget, initial) => {
          if (!initial) return row(child);
          budgets.push(budget!);
          signals.push(signal!);
          return new Promise(() => {});
        },
        {
          signal: controller.signal,
          onProgress: (p) => rounds.push(p.roundIndex),
        },
      ).then((outcome) => {
        settled = true;
        return outcome;
      });
      await vi.advanceTimersByTimeAsync(2500);
      expect(settled).toBe(false);
      expect(budgets).toEqual([1000, 1000, 800]);
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
      expect(new Set(rounds)).toEqual(new Set([0]));
      if (end === 'stop') controller.abort();
      else {
        await vi.advanceTimersByTimeAsync(499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      }
      const outcome = await pending;
      expect(outcome.reason).toBe(end === 'stop' ? 'Stopped' : 'Complete');
      expect(outcome.result.elapsedSeconds).toBe(
        end === 'stop'
          ? 2.5
          : input.settings.sheetCompressionSeconds * input.settings.sheetInsertionFailures,
      );
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(outcome.result.sheets).toHaveLength(1);
      expect(outcome.result.unplaced).toEqual([]);
      expect(validate(input, outcome.result).status).toBe('passed');
      await vi.advanceTimersByTimeAsync(3000);
      expect(budgets).toEqual([1000, 1000, 800]);
    },
  );

  it('retries naturally finished slices with the latest best and ignores stale or worse candidates', async () => {
    const input = job(1, 4);
    const controller = new AbortController();
    const seeds: string[] = [];
    const starts: number[] = [];
    const published: string[] = [];
    let oldOffer: ((result: Result) => void) | undefined;
    let base: Result | undefined;
    let settled = false;
    const pending = solveSheets(
      input,
      async (child, _signal, offer, _budget, initial) => {
        base = (await row(child))!;
        if (!initial) return { ...base, usedLengthMm: 18, seed: 'initial' };
        seeds.push(initial.seed);
        starts.push(performance.now());
        if (seeds.length === 1) {
          oldOffer = offer;
          return { ...base, usedLengthMm: 16, seed: 'first-best' };
        }
        if (seeds.length === 2) {
          oldOffer?.({ ...base, usedLengthMm: 10, seed: 'stale-best' });
          offer?.({ ...base, usedLengthMm: 16, seed: 'equal' });
          return { ...base, usedLengthMm: 17, seed: 'worse' };
        }
        if (seeds.length === 3) return undefined;
        if (seeds.length === 4) {
          offer?.({ ...base, usedLengthMm: 14, seed: 'latest-best' });
          return { ...base, usedLengthMm: 15, seed: 'worse-return' };
        }
        return undefined;
      },
      {
        signal: controller.signal,
        onSheet: (result) => published.push(result.sheets![0].result.seed),
        onProgress: (p) => expect(p.sheetIndex).toBe(0),
      },
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(450);
    expect(settled).toBe(false);
    expect(seeds).toEqual(['initial', 'first-best', 'first-best', 'first-best', 'latest-best']);
    expect(starts.slice(1).map((at, i) => at - starts[i])).toEqual([100, 100, 100, 100]);
    expect(published).toEqual(['initial', 'first-best', 'latest-best']);
    controller.abort();
    const outcome = await pending;
    expect(outcome.reason).toBe('Stopped');
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.sheets![0].result.seed).toBe('latest-best');
    expect(validate(input, outcome.result).status).toBe('passed');
    const count = published.length;
    oldOffer?.({ ...base!, usedLengthMm: 10, seed: 'after-stop' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(published).toHaveLength(count);
    expect(seeds).toHaveLength(5);
  });

  it.each([1, 2])(
    'compresses the final sheet for the product window after committing another sheet (%s failures)',
    async (limit) => {
      const input = job(3, 4);
      input.settings.sheetCompressionSeconds = 1;
      input.settings.sheetInsertionFailures = limit;
      const compressed: number[] = [];
      const budgets: number[] = [];
      const signals: AbortSignal[] = [];
      const startedAt = performance.now();
      let finalStartedAt = 0;
      let settled = false;
      const pending = solveSheets(input, async (child, signal, _offer, budget, initial) => {
        if (initial && quantity(child) === initial.placements.length) {
          compressed.push(quantity(child));
          if (quantity(child) === 1) {
            if (!budgets.length) finalStartedAt = performance.now();
            budgets.push(budget!);
            signals.push(signal!);
            return new Promise(() => {});
          }
        }
        return row(child);
<<<<<<< HEAD
      }),
    );
    expect(compressed).toEqual([2, 2, 2, 2, 1]);
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.sheets!.map((sheet) => quantity(sheet.job))).toEqual([2, 1]);
    expect(outcome.result.unplaced).toEqual([]);
    expect(outcome.result.elapsedSeconds).toBeLessThan(0.1);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
=======
      }).then((outcome) => {
        settled = true;
        return outcome;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(budgets).toEqual([1000]);
      await vi.advanceTimersByTimeAsync(limit * 1000 - (performance.now() - finalStartedAt) - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending;
      expect(performance.now() - finalStartedAt).toBe(
        input.settings.sheetCompressionSeconds * limit * 1000,
      );
      expect(compressed).toEqual([...Array(limit).fill(2), ...Array(limit).fill(1)]);
      expect(budgets).toEqual(limit === 1 ? [1000] : [1000, 900]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(outcome.reason).toBe('Complete');
      expect(outcome.result.sheets!.map((sheet) => quantity(sheet.job))).toEqual([2, 1]);
      expect(outcome.result.unplaced).toEqual([]);
      expect(outcome.result.elapsedSeconds).toBe((finalStartedAt - startedAt) / 1000 + limit);
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );
>>>>>>> dev

  it.each([undefined, 1])(
    'compresses after each failed insertion before retrying (%s)',
    async (limit) => {
      const input = job(3, 2);
      input.settings.sheetLengthMm = 30;
      input.settings.sheetInsertionFailures = limit;
      let sheet = 0;
      const calls: string[] = [];
      const controller = new AbortController();
      const outcome = await finish(
        solveSheets(
          input,
          async (child, _signal, _offer, _budget, initial) => {
            calls.push(
              `${initial ? (quantity(child) === initial.placements.length ? 'compress' : 'warm') : 'cold'}:${quantity(child)}`,
            );
            return quantity(child) === 1 ? row(child) : undefined;
          },
          {
            signal: controller.signal,
            onProgress: (p) => {
              sheet = p.sheetIndex;
              if (sheet === 1) controller.abort();
            },
          },
        ),
      );
<<<<<<< HEAD
      const failedPass = ['warm:2', 'cold:2'];
      const limitValue = limit ?? 3;
=======
      const failedPass = ['warm:2'];
>>>>>>> dev
      expect(calls).toEqual([
        'cold:3',
        'cold:1',
        ...failedPass,
        ...Array.from({ length: limitValue }, () => ['compress:1', ...failedPass]).flat(),
        'compress:1',
        ...failedPass,
      ]);
      expect(sheet).toBe(1);
      expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 2 }]);
      expect(outcome.result.elapsedSeconds).toBeLessThan(0.1);
    },
  );

  it.each([
    { priorities: [0, 0, 0], expected: ['ABC', 'BCA', 'CAB', 'ABC'] },
    { priorities: [2, 0, 0], expected: ['ABC', 'ACB', 'ABC', 'ACB'] },
  ])(
    'rotates failed candidates only within equal priorities ($priorities)',
    async ({ priorities, expected }) => {
      const input = job(1, 2);
      const seed = { ...part(10, 1), id: 'seed', priority: 10 };
      const extra = [9, 8, 7].map((size, index) => ({
        ...part(size, 1),
        id: 'ABC'[index],
        priority: priorities[index],
      }));
      input.parts = [seed, ...extra];
      input.settings.sheetLengthMm = 100;
      const controller = new AbortController();
      const passes: string[][] = [[]];
      const retries: string[] = [];
      let placementBuilt = false;
      const outcome = await finish(
        solveSheets(
          input,
          async (child, _signal, _offer, _budget, initial) => {
            if (quantity(child) === 1 && child.parts[0].id === seed.id) {
              if (initial) passes.push([]);
              placementBuilt = true;
              return row(child);
            }
            const id = child.parts.find((part) => part.id !== seed.id)!.id;
            if (initial) {
              passes.at(-1)!.push(id);
            } else if (placementBuilt) {
              retries.push(id);
            }
            return undefined;
          },
          {
            signal: controller.signal,
            onProgress: (progress) => {
              if (progress.sheetIndex === 1) controller.abort();
            },
          },
        ),
      );
      expect(passes.map((pass) => pass.join(''))).toEqual(expected);
      expect(retries).toEqual([]);
      expect(outcome.result.sheets![0].job.parts.map((part) => part.id)).toEqual(['seed']);
    },
  );

  it('resets insertion failures only when an insertion adds copies', async () => {
    const input = job(4, 2);
    input.settings.sheetLengthMm = 40;
    const controller = new AbortController();
    let compressions = 0;
    const counts: number[] = [];
    const outcome = await finish(
      solveSheets(
        input,
        async (child, _signal, _offer, _budget, initial) => {
          const n = quantity(child);
          if (initial && n === initial.placements.length) {
            compressions++;
            counts.push(n);
            return row(child);
          }
          if (n === 1 || (compressions >= 3 && n === 2)) return row(child);
          return undefined;
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.sheetIndex === 1) controller.abort();
          },
        },
      ),
    );
    expect(counts).toEqual([1, 1, 1, 2, 2, 2, 2]);
    expect(outcome.result.sheets![0].job.parts[0].quantity).toBe(2);
    expect(validate(input, outcome.result).status).toBe('passed');
=======
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
>>>>>>> dev
  });
  it('accepts an evacuated first board even when the virtual right boundary grows', async () => {
    const input = job(3, 2);
<<<<<<< HEAD
    input.settings.sheetLengthMm = 40;
    const controller = new AbortController();
    let compressions = 0;
    const progress: SheetProgress[] = [];
    const outcome = await finish(
      solveSheets(
        input,
        async (child, _signal, _offer, _budget, initial) => {
          if (quantity(child) > 1) return undefined;
          if (initial) {
            compressions++;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return { ...(await row(child))!, usedLengthMm: 14 - compressions };
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            progress.push(p);
            if (p.sheetIndex === 1) controller.abort();
          },
        },
      ),
    );
    expect(compressions).toBe(4);
    const times = progress.filter((p) => p.sheetIndex === 0).map((p) => p.lastImprovementAt);
    expect(new Set(times).size).toBe(5);
    expect(outcome.result.sheets![0].result.usedLengthMm).toBe(10);
  });

  it('uses validated equal-width rearrangements for insertion without publishing a best improvement', async () => {
    const input = job(2, 1);
    input.settings.materialWidthMm = 20;
    input.settings.sheetLengthMm = 40;
    input.settings.sheetCompressionSeconds = 1;
    const controller = new AbortController();
    const published: string[] = [];
    const insertionStarts: number[] = [];
    const accepted = vi.fn();
    let compressionStarted = 0;
    const solve: StripAttempt = async (child, _signal, _offer, budget, initial) => {
      if (quantity(child) > 1) {
        if (initial?.seed === 'rearranged') {
          expect(initial.placements[0].yMm).toBe(10);
          expect(performance.now() - compressionStarted).toBeGreaterThanOrEqual(900);
          insertionStarts.push(performance.now());
          controller.abort();
        }
        return undefined;
      }
      const base = (await row(child))!;
      if (!initial) return { ...base, seed: 'initial' };
      compressionStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, budget! - 100));
      return {
        ...base,
        seed: 'rearranged',
        placements: base.placements.map((placement) => ({ ...placement, yMm: 10 })),
      };
    };
    solve.acceptCandidate = accepted;
    const pending = solveSheets(input, solve, {
      signal: controller.signal,
      onSheet: (result) => published.push(result.sheets![0].result.seed),
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(insertionStarts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(insertionStarts).toHaveLength(1);
    expect(published).toEqual(['initial']);
    expect(accepted.mock.calls.map(([result]) => result.seed)).toEqual(['initial', 'rearranged']);
  });

  it('uses the last validated equal-width compressed layout for the next warm insertion', async () => {
    const input = job(2, 1);
    input.settings.materialWidthMm = 20;
=======
>>>>>>> dev
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
