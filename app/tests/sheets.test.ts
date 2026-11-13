import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  SOLVER_REVISION,
  type Job,
  type Result,
  type SheetStock,
} from '../src/engine/model';
import { solveSheets, type SheetProgress, type StripAttempt } from '../src/engine/sheets';
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
  it.each([
    'Warm start insertion failed: no valid placement',
    'No valid initial placement',
    'Invalid initial placement',
    'Initial placement failed',
  ])('retries a failed joint warm start cold once: %s', async (message) => {
    const input = job(3, 2);
    input.settings.sheetLengthMm = 30;
    let coldAttempts = 0;
    let warmAttempts = 0;
    const { result: output } = await finish(
      solveSheets(input, async (child, _signal, offer, _budget, initial) => {
        if (child.settings.virtualBoards!.length === 2) {
          const p = child.parts[0];
          return result(
            [0, 10, 31].map((xMm, copyIndex) => ({
              partId: p.id,
              copyIndex,
              xMm,
              yMm: 0,
              angleDeg: 0,
            })),
            41,
          );
        }
        if (initial) {
          warmAttempts++;
          offer?.((await virtualRow(child))!);
          throw Error(message);
        }
        coldAttempts++;
        return virtualRow(child);
      }),
    );
    expect(warmAttempts).toBe(2);
    expect(coldAttempts).toBe(1);
    expect(output.sheets).toHaveLength(1);
    expect(output.unplaced).toEqual([]);
    expect(validate(input, output).status).toBe('passed');
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
  it('reports joint phases and updates improvement time only for a better physical layout', async () => {
    const input = job(1, 1);
    input.settings.materialWidthMm = 20;
    input.settings.sheetLengthMm = 40;
    input.settings.timeLimitSeconds = 30;
    const started = performance.now();
    const progress: SheetProgress[] = [];
    const published: string[] = [];
    const budgets: number[] = [];
    let lateOffer: ((candidate: Result) => void) | undefined;
    let improved: Result | undefined;
    const solve: StripAttempt = async (child, _signal, offer, budget, initial) => {
      budgets.push(budget!);
      const base = (await virtualRow(child))!;
      const layout = (seed: string, xMm: number, yMm = 0): Result => ({
        ...base,
        seed,
        usedLengthMm: xMm + 10,
        placements: base.placements.map((placement) => ({ ...placement, xMm, yMm })),
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!initial) return layout('initial', 10);
      expect(initial.seed).toBe('initial');
      lateOffer = offer;
      offer?.(layout('equal', 10, 10));
      await new Promise((resolve) => setTimeout(resolve, 5));
      offer?.(layout('worse', 15));
      await new Promise((resolve) => setTimeout(resolve, 5));
      improved = layout('better', 0);
      offer?.(improved);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return layout('worse-return', 15);
    };
    const accepted = vi.fn();
    solve.acceptCandidate = accepted;
    const outcome = await finish(
      solveSheets(input, solve, {
        onProgress: (p) => progress.push(p),
        onSheet: (candidate) => published.push(candidate.seed),
      }),
    );
    expect(progress).toEqual([
      {
        roundIndex: 0,
        sheetIndex: 0,
        lastImprovementAt: started,
        phase: 'Insertion',
        insertionFailures: 0,
        selectedBoards: 1,
      },
      {
        roundIndex: 0,
        sheetIndex: 0,
        lastImprovementAt: started + 5,
        phase: 'Compression',
        insertionFailures: 0,
        selectedBoards: 1,
      },
    ]);
    expect(budgets).toEqual([30_000, 29_995]);
    expect(published).toEqual(['initial', 'better']);
    expect(accepted.mock.calls.map(([candidate]) => candidate.seed)).toContain('equal');
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.seed).toBe('better');
    expect(validate(input, outcome.result).status).toBe('passed');
    const acceptedCount = accepted.mock.calls.length;
    lateOffer?.({ ...improved!, seed: 'late' });
    await vi.advanceTimersByTimeAsync(10);
    expect(accepted).toHaveBeenCalledTimes(acceptedCount);
    expect(published).toEqual(['initial', 'better']);
  });
  it('keeps real stages through candidates and clears them before compression', async () => {
    const progress: SheetProgress[] = [];
    let searchStage: Parameters<StripAttempt>[6];
    let compressionStage: Parameters<StripAttempt>[6];
    const solve: StripAttempt = async (
      child,
      _signal,
      offer,
      _budget,
      initial,
      onStarted,
      onStage,
    ) => {
      expect(onStage).toBeTypeOf('function');
      const base = (await virtualRow(child))!;
      if (!initial) {
        searchStage = onStage;
        onStage!({ stage: 'local', boardIndex: 1 });
        offer?.(base);
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(progress.at(-1)?.stage).toEqual({ stage: 'local', boardIndex: 1 });
        onStage!({ stage: 'global', phase: 'Exploration' });
        offer?.({ ...base, seed: 'global-candidate' });
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(progress.at(-1)?.stage).toEqual({ stage: 'global', phase: 'Exploration' });
        expect(progress.at(-1)?.stage).not.toHaveProperty('boardIndex');
      } else {
        compressionStage = onStage;
        expect(progress.at(-1)).toMatchObject({ phase: 'Compression' });
        expect(progress.at(-1)).not.toHaveProperty('stage');
        const count = progress.length;
        searchStage?.({ stage: 'local', boardIndex: 0 });
        expect(progress).toHaveLength(count);
        onStage!({ stage: 'local', boardIndex: 2 });
        onStarted?.(true);
        expect(progress.at(-1)).toMatchObject({
          compressionStatus: 'running',
          stage: { stage: 'local', boardIndex: 2 },
        });
        offer?.({ ...base, seed: 'compression-candidate' });
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(progress.at(-1)?.stage).toEqual({ stage: 'local', boardIndex: 2 });
        onStage!({ stage: 'global', phase: 'Compression' });
      }
      return base;
    };
    const publishedStages: SheetProgress['stage'][] = [];
    const acceptedStages: SheetProgress['stage'][] = [];
    solve.acceptCandidate = () => acceptedStages.push(progress.at(-1)?.stage);
    const outcome = await finish(
      solveSheets(job(), solve, {
        onProgress: (next) => progress.push(next),
        onCurrentRound: () => publishedStages.push(progress.at(-1)?.stage),
      }),
    );
    expect(outcome.reason).toBe('Complete');
    expect(publishedStages).toContainEqual({ stage: 'local', boardIndex: 1 });
    expect(publishedStages).toContainEqual({ stage: 'global', phase: 'Exploration' });
    expect(publishedStages).toContainEqual({ stage: 'local', boardIndex: 2 });
    expect(acceptedStages).toEqual(publishedStages);
    expect(progress.at(-1)?.stage).toEqual({ stage: 'global', phase: 'Compression' });
    const count = progress.length;
    searchStage?.({ stage: 'local', boardIndex: 0 });
    compressionStage?.({ stage: 'evacuation' });
    expect(progress).toHaveLength(count);
  });
  it('rejects a finished search stage while its candidate is still being validated', async () => {
    const progress: SheetProgress[] = [];
    let lateStage: Parameters<StripAttempt>[6];
    let release: (() => void) | undefined;
    const solve: StripAttempt = async (
      child,
      _signal,
      _offer,
      _budget,
      initial,
      _started,
      onStage,
    ) => {
      if (!initial) {
        lateStage = onStage;
        onStage?.({ stage: 'local', boardIndex: 0 });
      }
      return virtualRow(child);
    };
    const pending = solveSheets(job(1, 1), solve, {
      onProgress: (next) => progress.push(next),
      validate: async (child, candidate) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return validate(child, candidate);
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(release).toBeTypeOf('function');
    expect(progress.at(-1)?.phase).toBe('Insertion');
    const count = progress.length;
    lateStage?.({ stage: 'global', phase: 'Exploration' });
    expect(progress).toHaveLength(count);
    release!();
    await vi.advanceTimersByTimeAsync(1);
    release!();
    expect((await finish(pending)).reason).toBe('Complete');
  });
  it('clears stages for a new combination and a failed warm search retry', async () => {
    const input = job(3, 2);
    input.settings.sheetLengthMm = 30;
    const progress: SheetProgress[] = [];
    let combination = 0;
    let previousCombinationStage: Parameters<StripAttempt>[6];
    let warmStage: Parameters<StripAttempt>[6];
    let warmRetried = false;
    const solve: StripAttempt = async (
      child,
      _signal,
      _offer,
      _budget,
      initial,
      _started,
      onStage,
    ) => {
      const base = (await virtualRow(child))!;
      const compressing =
        initial?.placements.length === child.parts.reduce((sum, part) => sum + part.quantity, 0);
      if (combination === 1) {
        previousCombinationStage = onStage;
        onStage?.({ stage: 'local', boardIndex: 1 });
        const secondBoard = bounds(child.settings.virtualBoards![1].outer)[0];
        return {
          ...base,
          placements: base.placements.map((placement, index) =>
            index === 2 ? { ...placement, xMm: secondBoard } : placement,
          ),
          usedLengthMm: secondBoard + 10,
        };
      }
      if (!compressing && initial) {
        expect(initial.placements).toHaveLength(2);
        warmStage = onStage;
        onStage?.({ stage: 'local', boardIndex: 0 });
        throw Error('Warm start insertion failed: test retry');
      }
      if (!compressing) {
        warmRetried = true;
        expect(progress.at(-1)).toMatchObject({ roundIndex: 1, phase: 'Insertion' });
        expect(progress.at(-1)).not.toHaveProperty('stage');
        const count = progress.length;
        warmStage?.({ stage: 'global', phase: 'Exploration' });
        previousCombinationStage?.({ stage: 'local', boardIndex: 1 });
        expect(progress).toHaveLength(count);
      }
      onStage?.({ stage: 'global', phase: compressing ? 'Compression' : 'Exploration' });
      return base;
    };
    solve.beginSheet = () => {
      combination++;
      expect(progress.at(-1)).toMatchObject({ roundIndex: combination - 1, phase: 'Insertion' });
      expect(progress.at(-1)).not.toHaveProperty('stage');
      const count = progress.length;
      previousCombinationStage?.({ stage: 'evacuation' });
      expect(progress).toHaveLength(count);
    };
    const outcome = await finish(
      solveSheets(input, solve, { onProgress: (next) => progress.push(next) }),
    );
    expect(combination).toBe(2);
    expect(warmRetried).toBe(true);
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.sheets).toHaveLength(1);
  });
  it('ignores stage messages immediately on abort and after attempt teardown', async () => {
    const controller = new AbortController();
    const progress: SheetProgress[] = [];
    let lateStage: Parameters<StripAttempt>[6];
    const solve: StripAttempt = async (
      _child,
      _signal,
      _offer,
      _budget,
      _initial,
      _started,
      onStage,
    ) => {
      lateStage = onStage;
      onStage?.({ stage: 'local', boardIndex: 1 });
      return new Promise(() => {});
    };
    const pending = solveSheets(job(), solve, {
      signal: controller.signal,
      onProgress: (next) => progress.push(next),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.stage).toEqual({ stage: 'local', boardIndex: 1 });
    const count = progress.length;
    controller.abort();
    lateStage?.({ stage: 'global', phase: 'Compression' });
    expect(progress).toHaveLength(count);
    expect((await pending).reason).toBe('Stopped');
    lateStage?.({ stage: 'evacuation' });
    expect(progress).toHaveLength(count);
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
  it.each(['normalize', 'begin', 'search', 'validate', 'compress'] as const)(
    'enforces the total deadline during joint %s',
    async (phase) => {
      const input = job(1, 1);
      input.settings.timeLimitSeconds = 10;
      const publish = vi.fn();
      let signal: AbortSignal | undefined;
      const hang = (active?: AbortSignal): Promise<never> => {
        signal = active;
        return new Promise(() => {});
      };
      const solve: StripAttempt = async (child, active, _offer, _budget, initial) => {
        if (phase === 'search' || (phase === 'compress' && initial)) return hang(active);
        return virtualRow(child);
      };
      solve.beginSheet = phase === 'begin' ? (_child, active) => hang(active) : undefined;
      solve.endSheet = vi.fn();
      const pending = solveSheets(input, solve, {
        onSheet: publish,
        normalize: phase === 'normalize' ? (_child, active) => hang(active) : undefined,
        validate: phase === 'validate' ? (_child, _candidate, active) => hang(active) : undefined,
      });
      const outcome = await finish(pending, 10_100);
      expect(signal?.aborted).toBe(true);
      expect(outcome.result.elapsedSeconds).toBe(10);
      expect(solve.endSheet).toHaveBeenCalled();
      expect(outcome.result.sheets).toHaveLength(phase === 'compress' ? 1 : 0);
      expect(publish).toHaveBeenCalledTimes(phase === 'compress' ? 1 : 0);
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );
  it('does not truncate joint retries at the old combination round cap', async () => {
    const input = job(100, 1);
    const demands: number[] = [];
    const rounds: number[] = [];
    const snapshots: Result[] = [];
    const outcome = await finish(
      solveSheets(
        input,
        async (child) => {
          demands.push(child.parts[0].quantity);
          if (child.parts[0].quantity === 1) return virtualRow(child);
        },
        {
          onProgress: (p) => rounds.push(p.roundIndex),
          onCurrentRound: (candidate, round) => {
            expect(candidate.roundIndex).toBe(round);
            snapshots.push(candidate);
          },
        },
      ),
    );
    expect(demands.filter((quantity) => quantity > 1).length).toBeGreaterThan(8);
    expect(Math.max(...rounds)).toBeGreaterThan(8);
    expect(snapshots.length).toBeGreaterThan(0);
    expect(outcome.result.sheets![0].result.placements).toHaveLength(1);
    expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 99 }]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('forwards local, global and evacuation budgets without capping the joint attempt', async () => {
    const input = job(1, 1);
    input.settings.timeLimitSeconds = 30;
    input.settings.sheetCycleBudget = {
      localMs: 117,
      globalMs: 229,
      evacuationMs: 337,
      localPercent: 41,
      globalPercent: 53,
      evacuationPercent: 67,
      maxRounds: 0,
      stallRounds: 0,
    };
    const budgets: number[] = [];
    const progress: SheetProgress[] = [];
    const solve: StripAttempt = async (child, _signal, _offer, budget, initial, onStarted) => {
      expect(child.settings.sheetCycleBudget).toEqual(input.settings.sheetCycleBudget);
      expect(JSON.parse(solverInput(child)).board_cycle).toEqual(input.settings.sheetCycleBudget);
      budgets.push(budget!);
      if (initial) onStarted?.(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return virtualRow(child);
    };
    const outcome = await finish(
      solveSheets(input, solve, { onProgress: (p) => progress.push(p) }),
    );
    expect(budgets).toEqual([30_000, 29_995]);
    expect(progress.at(-1)).toMatchObject({
      phase: 'Compression',
      compressionStatus: 'running',
      selectedBoards: 1,
    });
    expect(outcome.result.sheets![0].job.settings.sheetCycleBudget).toEqual(
      input.settings.sheetCycleBudget,
    );
  });
  it('subtracts initialization time once and skips compression without enough total budget', async () => {
    const input = job(1, 1);
    input.settings.timeLimitSeconds = 10;
    const budgets: number[] = [];
    const progress: SheetProgress[] = [];
    const solve: StripAttempt = async (child, _signal, _offer, budget) => {
      budgets.push(budget!);
      await new Promise((resolve) => setTimeout(resolve, 9_930));
      return virtualRow(child);
    };
    solve.beginSheet = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const outcome = await finish(
      solveSheets(input, solve, { onProgress: (p) => progress.push(p) }),
      10_100,
    );
    expect(budgets).toEqual([9_980]);
    expect(progress.at(-1)).toMatchObject({
      phase: 'Compression',
      compressionStatus: 'skipped-budget',
    });
    expect(outcome.result.unplaced).toEqual([]);
  });
  it('validates complementary triangles on each physical board instead of their overlapping bounds', async () => {
    const input = job(4, 2);
    const triangle = {
      ...newPart([
        [0, 0],
        [10, 0],
        [0, 10],
      ]),
      quantity: 4,
      rotations: { kind: 'discrete' as const, degrees: [0, 180] },
    };
    input.parts = [triangle];
    input.settings.sheetLengthMm = 10;
    const outcome = await finish(
      solveSheets(input, async (child) =>
        result(
          child.settings.virtualBoards!.flatMap((board, index) => {
            const x = bounds(board.outer)[0];
            return [
              { partId: triangle.id, copyIndex: index * 2, xMm: x, yMm: 0, angleDeg: 0 },
              {
                partId: triangle.id,
                copyIndex: index * 2 + 1,
                xMm: x + 10,
                yMm: 10,
                angleDeg: 180,
              },
            ];
          }),
          child.settings.sheetLengthMm!,
        ),
      ),
    );
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.sheets!.map((sheet) => sheet.result.placements.length)).toEqual([2, 2]);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result)).toMatchObject({ status: 'passed', errors: [] });
  });
  it('rejects a forged passed validation and duplicate virtual copy identities', async () => {
    const input = job(2, 1);
    const rejected = await finish(
      solveSheets(input, async (child) => {
        if (child.parts[0].quantity !== 2) return;
        const candidate = (await virtualRow(child))!;
        candidate.validation.status = 'passed';
        candidate.placements = candidate.placements.map((placement) => ({ ...placement, xMm: 0 }));
        return candidate;
      }),
    );
    expect(rejected.result.sheets).toEqual([]);
    const stock: SheetStock = {
      id: 'copies',
      name: 'copies',
      kind: 'rectangle',
      quantity: 1,
      priority: 0,
      lengthMm: 20,
      widthMm: 10,
    };
    const virtual = stitchBoards(input, [stock]);
    const candidate = (await virtualRow(virtual.job))!;
    candidate.placements[1].copyIndex = 0;
    expect(splitVirtualResult(input, virtual, candidate)).toBeUndefined();
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
