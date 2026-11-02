import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  SOLVER_REVISION,
  type Job,
  type Result,
} from '../src/engine/model';
import { solveSheets, type SheetProgress, type StripAttempt } from '../src/engine/sheets';
import { validate } from '../src/engine/geometry/validate';
import { normalizeJob } from '../src/engine/geometry/normalize';
import { addParts, jobKey, newProject, projectJob, startBlockers } from '../src/project/model';
import { parseProject, serializeProject } from '../src/project/file';
import { exportSVG } from '../src/engine/export/svg';
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
const job = (quantity = 5, count = 3, seconds: number | null = 60): Job => ({
  name: 'Sheets',
  parts: [part(10, quantity)],
  settings: {
    ...DEFAULT_SETTINGS,
    materialWidthMm: 10,
    sheetLengthMm: 20,
    sheetCount: count,
    timeLimitSeconds: seconds,
  },
});
const row: StripAttempt = async (input) => {
  let x = 0;
  const placements = input.parts.flatMap((p) =>
    Array.from({ length: p.quantity }, (_, copyIndex) => {
      const placement = { partId: p.id, copyIndex, xMm: x, yMm: 0, angleDeg: 0 };
      x += p.outer[1][0];
      return placement;
    }),
  );
  return {
    documentRevision: 1,
    solverRevision: SOLVER_REVISION,
    seed: '1',
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
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function finish(pending: ReturnType<typeof solveSheets>, ms = 60_000) {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}

describe('sheet stagnation sequencing', () => {
  it.each([60, null])(
    'keeps a complete single rectangle in one continuous search (%s)',
    async (seconds) => {
      const input = job(2, 1, seconds);
      input.settings.sheetStagnationSeconds = 1;
      const controller = new AbortController();
      const progress: SheetProgress[] = [];
      const solve: StripAttempt = vi.fn(row);
      solve.continueSheet = vi.fn(async (child, signal, offer, budget, initial) => {
        expect(budget).toBe(seconds === null ? Infinity : 60_000);
        expect(initial?.placements).toHaveLength(2);
        return new Promise<Result | undefined>((resolve) => {
          signal?.addEventListener('abort', () => resolve(undefined), { once: true });
          setTimeout(
            async () => offer?.({ ...(await row(child))!, seed: 'late-continuous' }),
            20_000,
          );
        });
      });
      const pending = solveSheets(input, solve, {
        signal: controller.signal,
        onProgress: (p) => progress.push(p),
      });
      await vi.advanceTimersByTimeAsync(20_001);
      expect(solve.continueSheet).toHaveBeenCalledTimes(1);
      expect(solve).toHaveBeenCalledTimes(1);
      expect(progress.every((p) => p.roundIndex === 0 && p.sheetIndex === 0)).toBe(true);
      controller.abort();
      const outcome = await pending;
      expect(outcome.result.unplaced).toEqual([]);
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );

  it('validates late continuous candidates, rejects regressions and preserves Stop', async () => {
    const input = job(2, 1, 30);
    input.settings.sheetLengthMm = 30;
    input.settings.sheetStagnationSeconds = 1;
    const controller = new AbortController();
    const published: Result[] = [];
    const solve: StripAttempt = async (child) => ({ ...(await row(child))!, usedLengthMm: 25 });
    solve.continueSheet = async (child, signal, offer) => {
      const base = (await row(child))!;
      setTimeout(() => offer?.({ ...base, usedLengthMm: 26, seed: 'longer' }), 2000);
      setTimeout(
        () => offer?.({ ...base, usedLengthMm: 24, seed: 'invalid', placements: [] }),
        3000,
      );
      setTimeout(() => offer?.({ ...base, usedLengthMm: 22, seed: 'late-shorter' }), 12_000);
      return new Promise((resolve) =>
        signal?.addEventListener('abort', () => resolve(undefined), { once: true }),
      );
    };
    const pending = solveSheets(input, solve, {
      signal: controller.signal,
      onSheet: (result) => published.push(result),
    });
    await vi.advanceTimersByTimeAsync(12_001);
    expect(published.at(-1)!.sheets![0].result.seed).toBe('late-shorter');
    expect(published.some((result) => result.sheets![0]?.result.seed === 'invalid')).toBe(false);
    controller.abort();
    const outcome = await pending;
    expect(outcome.reason).toBe('Stopped');
    expect(outcome.result.sheets![0].result.usedLengthMm).toBe(22);
  });

  it('does not restart the board after a continuous optimizer finishes naturally', async () => {
    const input = job(2, 1, null);
    const solve: StripAttempt = vi.fn(row);
    solve.continueSheet = vi.fn(row);
    const outcome = await finish(solveSheets(input, solve), 1);
    expect(solve).toHaveBeenCalledTimes(1);
    expect(solve.continueSheet).toHaveBeenCalledTimes(1);
    expect(outcome.result.unplaced).toEqual([]);
  });

  it('advances after a configured three seconds without improvement', async () => {
    const input = job();
    input.settings.sheetStagnationSeconds = 3;
    const progress: SheetProgress[] = [];
    const pending = solveSheets(input, row, { onProgress: (p) => progress.push(p) });
    await vi.advanceTimersByTimeAsync(2999);
    expect(progress.at(-1)?.sheetIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await finish(pending, 57_000);
  });
  it('an improvement at two seconds resets the configured three-second timeout', async () => {
    const input = job(3, 2);
    input.settings.sheetStagnationSeconds = 3;
    input.settings.sheetLengthMm = 21;
    const progress: SheetProgress[] = [];
    const pending = solveSheets(
      input,
      async (child) => {
        const result = (await row(child))!;
        return {
          ...result,
          usedLengthMm: result.usedLengthMm + (performance.now() < 2000 ? 1 : 0),
        };
      },
      { onProgress: (p) => progress.push(p) },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(progress.at(-1)?.lastImprovementAt).toBe(2000);
    await vi.advanceTimersByTimeAsync(2999);
    expect(progress.at(-1)?.sheetIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await finish(pending, 55_000);
  });
  it('the global deadline takes priority over a configured sheet timeout', async () => {
    const input = job(5, 3, 10);
    input.settings.sheetStagnationSeconds = 600;
    const progress: SheetProgress[] = [];
    const pending = solveSheets(input, row, { onProgress: (p) => progress.push(p) });
    const outcome = await finish(pending, 10_000);
    expect(progress.every((p) => p.sheetIndex === 0)).toBe(true);
    expect(outcome.result.elapsedSeconds).toBe(10);
    expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 3 }]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('waits 14.999s, advances at 15s, and repartitions only after every board', async () => {
    const input = job();
    const progress: SheetProgress[] = [];
    const pending = solveSheets(input, row, { onProgress: (p) => progress.push(p) });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress.every((p) => p.sheetIndex === 0 && p.roundIndex === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress.every((p) => p.roundIndex === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(progress.at(-1)?.roundIndex).toBe(1);
    const outcome = await finish(pending, 14_999);
    expect(outcome.result.sheets!.map((s) => s.job.parts[0].quantity)).toEqual([2, 2, 1]);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('compression at 14 seconds postpones advancement until 29 seconds', async () => {
    const input = job(3, 2, 60);
    const progress: SheetProgress[] = [];
    const pending = solveSheets(
      input,
      async (child) => {
        const result = (await row(child))!;
        return {
          ...result,
          usedLengthMm: result.usedLengthMm + (performance.now() < 14_000 ? 1 : 0),
        };
      },
      {
        validate: async () => ({
          status: 'passed',
          overlapAreaMm2: 0,
          maxBoundaryViolationMm: 0,
          minClearanceMm: null,
          errors: [],
        }),
        onProgress: (p) => progress.push(p),
      },
    );
    await vi.advanceTimersByTimeAsync(14_000);
    expect(progress.at(-1)?.lastImprovementAt).toBe(14_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress.at(-1)?.sheetIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await finish(pending, 31_000);
  });
  it('adding copies increases whole-stock utilization and resets the stagnation clock', async () => {
    const input = job(3, 2, 60);
    input.settings.sheetLengthMm = 30;
    const progress: SheetProgress[] = [];
    const pending = solveSheets(
      input,
      async (child) => {
        if (performance.now() < 14_000 && child.parts[0].quantity > 1) return undefined;
        return row(child);
      },
      { onProgress: (p) => progress.push(p) },
    );
    await vi.advanceTimersByTimeAsync(14_000);
    expect(progress.at(-1)?.lastImprovementAt).toBe(14_000);
    await vi.advanceTimersByTimeAsync(1001);
    expect(progress.some((p) => p.sheetIndex === 1)).toBe(false);
    const outcome = await finish(pending, 44_999);
    expect(outcome.result.sheets![0].job.parts[0].quantity).toBe(3);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('global deadline stops before later boards without losing quantities', async () => {
    const input = job(5, 3, 10);
    const progress: SheetProgress[] = [];
    const pending = solveSheets(input, row, { onProgress: (p) => progress.push(p) });
    const outcome = await finish(pending, 10_000);
    expect(progress.every((p) => p.sheetIndex === 0 && p.roundIndex === 0)).toBe(true);
    expect(outcome.result.elapsedSeconds).toBe(10);
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 3 }]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('impossible first board waits fifteen seconds and preserves all unplaced copies', async () => {
    const input = job(5, 2, 60);
    const progress: SheetProgress[] = [];
    const solve = vi.fn(async () => undefined);
    const pending = solveSheets(input, solve, { onProgress: (p) => progress.push(p) });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(progress.at(-1)?.roundIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(progress.at(-1)?.roundIndex).toBeGreaterThanOrEqual(1);
    const outcome = await finish(pending, 29_999);
    expect(solve.mock.calls.length).toBeGreaterThan(12);
    expect(outcome.result.sheets).toEqual([]);
    expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 5 }]);
  });
});

describe('sheet current rounds', () => {
  it('tries one added copy before compression and allows slow incremental construction', async () => {
    const input = job(60, 1, 10);
    input.settings.sheetLengthMm = 1000;
    input.settings.sheetStagnationSeconds = 60;
    const controller = new AbortController();
    const attempts: { quantity: number; previous: number; budget: number }[] = [];
    const pending = solveSheets(
      input,
      async (child, _signal, _offer, budget, initial) => {
        const quantity = child.parts[0].quantity;
        attempts.push({ quantity, previous: initial?.placements.length ?? 0, budget: budget! });
        if (!initial && quantity > 15) return undefined;
        if (initial && quantity > initial.placements.length) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        return row(child);
      },
      {
        signal: controller.signal,
        onSheet: (result) => {
          if ((result.sheets?.[0]?.result.placements.length ?? 0) > 15) controller.abort();
        },
      },
    );
    const outcome = await finish(pending, 10_000);
    const warm = attempts.filter((attempt) => attempt.previous > 0);
    expect(warm[0]).toEqual({ quantity: 16, previous: 15, budget: 10_000 });
    expect(outcome.result.sheets![0].result.placements).toHaveLength(16);
    expect(validate(input, outcome.result).status).toBe('passed');
  });

  it.each([true, false])(
    'inherits compressed placements for insertion and preserves fallback (%s)',
    async (warmSucceeds) => {
      const input = job(3, 1, 10);
      input.settings.sheetLengthMm = 40;
      input.settings.sheetStagnationSeconds = 1;
      const controller = new AbortController();
      const warm: Result[] = [];
      let compressed = false;
      let inserted = false;
      const pending = solveSheets(
        input,
        async (child, _signal, _offer, _budget, initial) => {
          const quantity = child.parts[0].quantity;
          if (!initial && quantity > 1 && !compressed) return undefined;
          const result = (await row(child))!;
          if (initial) {
            warm.push(structuredClone(initial));
            if (quantity === initial.placements.length) {
              compressed = true;
              return { ...result, seed: 'compressed' };
            }
            if (!compressed) return undefined;
            if (initial.placements.length === 1) expect(initial.seed).toBe('compressed');
            if (!warmSucceeds) return undefined;
          }
          if (quantity === 3) inserted = true;
          return !compressed ? { ...result, usedLengthMm: result.usedLengthMm + 1 } : result;
        },
        {
          signal: controller.signal,
          onSheet: (result) => {
            if (!result.unplaced!.length) controller.abort();
          },
        },
      );
      const outcome = await finish(pending, 10_000);
      expect(compressed).toBe(true);
      expect(inserted).toBe(true);
      expect(warm.some((initial) => initial.seed === 'compressed')).toBe(true);
      expect(outcome.result.unplaced).toEqual([]);
      expect(outcome.result.sheets![0].result.usedLengthMm).toBe(30);
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );

  it('keeps selected copies in every later attempt and never rolls a board back', async () => {
    const input = job(4, 2, 10);
    input.settings.sheetLengthMm = 40;
    input.settings.sheetStagnationSeconds = 1;
    const current: Result[] = [];
    let roundIndex = 0;
    let sheetIndex = 0;
    let acceptedThree = false;
    const pending = solveSheets(
      input,
      async (child) => {
        const quantity = child.parts[0].quantity;
        if (roundIndex === 0 && sheetIndex === 0) {
          if (acceptedThree) expect(quantity).toBeGreaterThanOrEqual(3);
          if (quantity === 4) return undefined;
          if (quantity === 3) acceptedThree = true;
        }
        return row(child);
      },
      {
        onProgress: (p) => {
          roundIndex = p.roundIndex;
          sheetIndex = p.sheetIndex;
        },
        onCurrentRound: (r) => current.push(r),
      },
    );
    await finish(pending, 10_000);
    expect(acceptedThree).toBe(true);
    const firstRound = current.filter((r) => r.roundIndex === 0);
    const counts = firstRound.map((r) => r.sheets?.[0]?.job.parts[0].quantity ?? 0);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    const committed = firstRound.filter((r) => r.currentSheetIndex === 1);
    expect(committed.length).toBeGreaterThan(0);
    expect(
      committed.every(
        (r) => JSON.stringify(r.sheets![0]) === JSON.stringify(committed[0].sheets![0]),
      ),
    ).toBe(true);
  });
  it('does not publish longer or equal compression candidates but accepts a later shorter stream candidate', async () => {
    const input = job(2, 1, 10);
    input.settings.sheetLengthMm = 23;
    input.settings.sheetStagnationSeconds = 1;
    const controller = new AbortController();
    const current: Result[] = [];
    const pending = solveSheets(
      input,
      async (child, _signal, offer, budget) => {
        const result = (await row(child))!;
        if (budget! <= 2500) return { ...result, usedLengthMm: 21, seed: 'initial' };
        offer?.({ ...result, usedLengthMm: 22, seed: 'longer' });
        setTimeout(() => offer?.({ ...result, usedLengthMm: 21, seed: 'equal' }), 10);
        setTimeout(() => offer?.({ ...result, seed: 'shorter' }), 20);
        return new Promise<Result>(() => {});
      },
      {
        signal: controller.signal,
        onCurrentRound: (r) => {
          current.push(r);
          if (r.sheets?.[0]?.result.seed === 'shorter') setTimeout(() => controller.abort(), 0);
        },
      },
    );
    const outcome = await finish(pending, 1000);
    expect(current.flatMap((r) => r.sheets ?? []).map((s) => s.result.seed)).toEqual([
      'initial',
      'shorter',
    ]);
    expect(current.every((r) => r.roundIndex === 0 && r.currentSheetIndex === 0)).toBe(true);
    expect(outcome.result.sheets![0].result.usedLengthMm).toBe(20);
    expect(outcome.result.currentSheetIndex).toBeUndefined();
  });
  it.each(['stop', 'deadline'] as const)(
    'publishes worse rounds without replacing the incumbent at %s',
    async (end) => {
      const input = job(4, 2, 10);
      input.settings.sheetStagnationSeconds = 1;
      const controller = new AbortController();
      const current: Result[] = [];
      const best: Result[] = [];
      let roundIndex = 0;
      const pending = solveSheets(
        input,
        async (child) => {
          if (roundIndex > 0 && child.parts[0].quantity > 1) return undefined;
          return row(child);
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            roundIndex = p.roundIndex;
          },
          onSheet: (result) => best.push(result),
          onCurrentRound: (result, index) => {
            expect(result.roundIndex).toBe(index);
            expect(result.currentSheetIndex).toBeDefined();
            current.push(result);
            if (end === 'stop' && index === 1 && result.sheets!.length) controller.abort();
          },
        },
      );
      const outcome = await finish(pending, 10_000);
      const reset = current.find((r) => r.roundIndex === 1)!;
      expect(reset.sheets).toEqual([]);
      expect(reset.currentSheetIndex).toBe(0);
      expect(reset.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 4 }]);
      expect(
        current.some((r) => r.roundIndex === 1 && r.sheets!.length && r.unplaced!.length),
      ).toBe(true);
      expect(outcome.result.roundIndex).toBe(0);
      expect(outcome.result.unplaced).toEqual([]);
      expect(outcome.reason).toBe(end === 'stop' ? 'Stopped' : 'Complete');
      expect(best.at(-1)!.roundIndex).toBe(0);
      expect(
        [...current, ...best, outcome.result].every((r) => validate(input, r).status === 'passed'),
      ).toBe(true);
      const count = current.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(current).toHaveLength(count);
    },
  );
  it('records a later improving round on the aggregate', async () => {
    const input = job(2, 1, 10);
    input.settings.sheetStagnationSeconds = 1;
    const controller = new AbortController();
    let roundIndex = 0;
    const pending = solveSheets(
      input,
      async (child) => {
        if (roundIndex === 0 && child.parts[0].quantity > 1) return undefined;
        return row(child);
      },
      {
        signal: controller.signal,
        onProgress: (p) => {
          roundIndex = p.roundIndex;
        },
        onSheet: (result) => {
          if (!result.unplaced!.length) controller.abort();
        },
      },
    );
    const outcome = await finish(pending, 10_000);
    expect(outcome.result.roundIndex).toBe(1);
    expect(outcome.result.unplaced).toEqual([]);
    expect(outcome.result.sheets![0].result.roundIndex).toBeUndefined();
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('isolates published snapshots and the incumbent from callback mutations', async () => {
    const input = job(3, 2, 10);
    input.settings.sheetStagnationSeconds = 1;
    const current: Result[] = [];
    const pending = solveSheets(input, row, {
      onCurrentRound: (result) => {
        current.push(structuredClone(result));
        result.sheets!.forEach((sheet) => {
          sheet.result.placements.length = 0;
          sheet.job.parts[0].quantity = 999;
        });
        result.unplaced!.length = 0;
      },
      onSheet: (result) => {
        result.sheets!.length = 0;
      },
    });
    const outcome = await finish(pending, 10_000);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
    expect(current.every((r) => validate(input, r).status === 'passed')).toBe(true);
    expect(current[0].sheets).toEqual([]);
    expect(current[0].unplaced![0].quantity).toBe(3);
  });
});

describe('sheet validation and incumbents', () => {
  it('fills 50 squares as 30/20 with real validation, conserving original input', async () => {
    const input = job(50, 2, 60);
    input.parts = [part(60, 50)];
    input.settings.materialWidthMm = 100;
    input.settings.sheetLengthMm = 1800;
    const before = JSON.stringify(input);
    const controller = new AbortController();
    const pending = solveSheets(input, row, {
      signal: controller.signal,
      onSheet: (r) => {
        if (!r.unplaced!.length) controller.abort();
      },
    });
    const outcome = await finish(pending, 40_000);
    expect(outcome.result.sheets!.map((s) => s.job.parts[0].quantity)).toEqual([30, 20]);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('preserves complete incumbent throughout worse partial rounds', async () => {
    const input = job(4, 2);
    const published: Result[] = [];
    let roundIndex = 0;
    const pending = solveSheets(input, async (child) => (roundIndex > 0 ? undefined : row(child)), {
      onProgress: (p) => {
        roundIndex = p.roundIndex;
      },
      onSheet: (r) => published.push(r),
    });
    const outcome = await finish(pending);
    expect(roundIndex).toBeGreaterThan(0);
    expect(outcome.result.sheets).toHaveLength(2);
    expect(outcome.result.unplaced).toEqual([]);
    const complete = published.findIndex((r) => !r.unplaced!.length);
    expect(complete).toBeGreaterThanOrEqual(0);
    expect(published.slice(complete).every((r) => !r.unplaced!.length)).toBe(true);
    expect(published.every((r) => validate(input, r).status === 'passed')).toBe(true);
  });
  it('does not advance when worker self-stops or a short slice expires', async () => {
    const input = job(3, 2, 30);
    const signals: AbortSignal[] = [];
    const published: Result[] = [];
    const progress: SheetProgress[] = [];
    const pending = solveSheets(
      input,
      async (child, signal, offer) => {
        signals.push(signal!);
        offer?.((await row(child))!);
        return new Promise<Result>(() => {});
      },
      { onSheet: (r) => published.push(r), onProgress: (p) => progress.push(p) },
    );
    await vi.advanceTimersByTimeAsync(14_999);
    expect(published[0].sheets).toHaveLength(1);
    expect(published[0].unplaced![0].quantity).toBe(1);
    expect(progress.every((p) => p.sheetIndex === 0)).toBe(true);
    expect(signals.length).toBeGreaterThanOrEqual(3);
    const outcome = await finish(pending, 15_001);
    expect(outcome.result.unplaced).toEqual([]);
    expect(outcome.result.sheets).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('keeps compression alive after its first candidate and extends an old board timer after improvement', async () => {
    const input = job(3, 2, 60);
    const progress: SheetProgress[] = [];
    const published: Result[] = [];
    const compressions: { at: number; signal: AbortSignal; budget: number }[] = [];
    input.settings.sheetLengthMm = 21;
    const pending = solveSheets(
      input,
      async (child, signal, offer, budget) => {
        const result = (await row(child))!;
        // Leave real geometric slack on the front board so compression is validated normally.
        const loose = {
          ...result,
          usedLengthMm:
            result.usedLengthMm +
            (result.usedLengthMm === 10 ? 0 : performance.now() < 14_000 ? 1 : 0),
        };
        if (budget! <= 2500) return loose;
        compressions.push({ at: performance.now(), signal: signal!, budget: budget! });
        offer?.(loose);
        const delay = 14_000 - performance.now();
        if (delay > 0 && delay < budget!) {
          setTimeout(() => offer?.({ ...result, seed: 'compressed-at-14' }), delay);
        }
        return new Promise<Result>(() => {});
      },
      { onProgress: (p) => progress.push(p), onSheet: (r) => published.push(r) },
    );
    await vi.advanceTimersByTimeAsync(101);
    expect(compressions).toHaveLength(1);
    expect(compressions[0].budget).toBe(10_000);
    expect(compressions[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(compressions[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(11_399);
    expect(progress.at(-1)?.lastImprovementAt).toBe(14_000);
    expect(published.at(-1)!.sheets![0].result.seed).toBe('compressed-at-14');
    expect(published.at(-1)!.sheets![0].result.usedLengthMm).toBe(20);
    const active = compressions.at(-1)!;
    expect(active.at).toBeGreaterThan(10_000);
    expect(active.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    expect(active.signal.aborted).toBe(false);
    expect(progress.at(-1)?.sheetIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(13_998);
    expect(progress.at(-1)?.sheetIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(progress.at(-1)?.sheetIndex).toBe(1);
    const outcome = await finish(pending, 31_000);
    expect(outcome.result.unplaced).toEqual([]);
    expect(published.every((r) => validate(input, r).status === 'passed')).toBe(true);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('cancels hung local validation and ignores late validation and old callbacks', async () => {
    const input = job(2, 2, 10);
    const published: Result[] = [];
    const current: Result[] = [];
    let finishLate!: () => void;
    let oldOffer: ((r: Result) => void) | undefined;
    let oldResult: Result | undefined;
    const signals: AbortSignal[] = [];
    const pending = solveSheets(
      input,
      async (child, _signal, offer) => {
        const result = (await row(child))!;
        if (!oldOffer) {
          oldOffer = offer;
          oldResult = result;
        }
        offer?.(result);
        return new Promise<Result>(() => {});
      },
      {
        onSheet: (r) => published.push(r),
        onCurrentRound: (r) => current.push(r),
        validate: async (child, result, signal) => {
          signals.push(signal!);
          if (signals.length === 1)
            return new Promise((resolve) => {
              finishLate = () => resolve(validate(child, result));
            });
          return validate(child, result);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(2499);
    expect(signals[0].aborted).toBe(false);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(signals[0].aborted).toBe(true);
    const saved = [...published];
    const savedCurrent = [...current];
    finishLate();
    oldOffer?.(oldResult!);
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toEqual(saved);
    expect(current).toEqual(savedCurrent);
    const outcome = await finish(pending, 7498);
    expect(outcome.result.unplaced).toEqual([]);
    expect(published.every((r) => validate(input, r).status === 'passed')).toBe(true);
  });
  it('manual stop preserves current verified work and cancels validation', async () => {
    const input = job(3);
    const controller = new AbortController();
    let checks = 0;
    let lateSignal: AbortSignal | undefined;
    const pending = solveSheets(input, row, {
      signal: controller.signal,
      validate: async (child, result, signal) => {
        if (++checks > 1) {
          lateSignal = signal;
          return new Promise(() => {});
        }
        return validate(child, result);
      },
    });
    await vi.advanceTimersByTimeAsync(101);
    controller.abort();
    const outcome = await pending;
    expect(outcome.reason).toBe('Stopped');
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.unplaced![0].quantity).toBe(1);
    expect(lateSignal?.aborted).toBe(true);
    expect(validate(input, outcome.result).status).toBe('passed');
  });
  it('deadline cancels hung solvers and starts nothing afterward', async () => {
    const input = job(1, 1, 10);
    const signals: AbortSignal[] = [];
    const pending = solveSheets(input, async (_child, signal) => {
      signals.push(signal!);
      return new Promise<Result>(() => {});
    });
    const outcome = await finish(pending, 10_000);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(outcome.result.sheets).toEqual([]);
    expect(outcome.result.unplaced![0].quantity).toBe(1);
    expect(outcome.result.elapsedSeconds).toBe(10);
    const calls = signals.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(signals).toHaveLength(calls);
  });
  it('propagates infrastructure errors', async () => {
    await expect(
      solveSheets(job(), async () => {
        throw Error('WASM binary failed to load');
      }),
    ).rejects.toThrow('failed to load');
  });
  it('automatic mode stops only after three complete stagnant rounds', async () => {
    const progress: SheetProgress[] = [];
    const pending = solveSheets(job(1, 1, null), async () => undefined, {
      onProgress: (p) => progress.push(p),
    });
    const outcome = await finish(pending, 45_010);
    expect(outcome.reason).toBe('Unplaceable');
    expect(progress.map((p) => p.roundIndex)).toEqual([0, 1, 2]);
    expect(outcome.result.elapsedSeconds).toBeGreaterThanOrEqual(45);
  });
});

describe('sheet project compatibility', () => {
  it('defaults legacy project and job timeouts and roundtrips configured values without changing layout keys', () => {
    const project = addParts(newProject('Job'), [part(10, 1)]);
    const legacy = JSON.parse(serializeProject(project));
    delete legacy.settings.sheetStagnationSeconds;
    expect(parseProject(legacy).settings.sheetStagnationSeconds).toBe(15);
    const legacyJob = projectJob(project);
    delete legacyJob.settings.sheetStagnationSeconds;
    expect(normalizeJob(legacyJob).settings.sheetStagnationSeconds).toBe(15);
    const configured = { ...project, settings: { ...project.settings, sheetStagnationSeconds: 3 } };
    expect(parseProject(JSON.parse(serializeProject(configured)))).toEqual(configured);
    expect(projectJob(configured).settings.sheetStagnationSeconds).toBe(3);
    expect(jobKey(projectJob(configured))).toBe(jobKey(projectJob(project)));
    for (const seconds of [1, 600]) {
      expect(
        normalizeJob({
          ...legacyJob,
          settings: { ...legacyJob.settings, sheetStagnationSeconds: seconds },
        }).settings.sheetStagnationSeconds,
      ).toBe(seconds);
    }
  });
  it.each([0, -1, 601, 1.5, NaN, Infinity, null, '3'])(
    'rejects invalid timeout %s at project, start and job boundaries',
    (seconds) => {
      const project = addParts(newProject('Job'), [part(10, 1)]);
      const invalid = {
        ...project,
        settings: { ...project.settings, sheetStagnationSeconds: seconds as number },
      };
      expect(() => parseProject(invalid)).toThrow('timeout');
      expect(startBlockers(invalid)).toEqual([expect.stringContaining('timeout')]);
      expect(() => normalizeJob(projectJob(invalid))).toThrow('timeout');
    },
  );
  it('validates stock, keys and normalized settings', () => {
    const p = addParts(newProject('Job'), [part(10, 1)]);
    const sheets = {
      ...p,
      stock: { packing: 'sheets' as const, strip: p.stock.strip, lengthMm: 20, quantity: 2 },
    };
    expect(startBlockers(sheets)).toEqual([]);
    expect(jobKey(projectJob(sheets))).not.toBe(jobKey(projectJob(p)));
    expect(
      startBlockers({ ...sheets, stock: { ...sheets.stock, quantity: 0, lengthMm: NaN } }),
    ).toHaveLength(2);
    expect(() =>
      normalizeJob({ ...job(), settings: { ...job().settings, sheetCount: 0 } }),
    ).toThrow('sheet count');
    expect(parseProject(JSON.parse(serializeProject(p)))).toEqual(p);
  });
  it('roundtrips verified sheets and rejects count, geometry, nested and boundary corruption', async () => {
    const input = job();
    const pending = solveSheets(input, row);
    const { result } = await finish(pending);
    const p = addParts(newProject('Job'), input.parts);
    const project = {
      ...p,
      stock: {
        packing: 'sheets' as const,
        strip: { ...p.stock.strip, widthMm: 10 },
        lengthMm: 20,
        quantity: 3,
      },
      solutions: [{ id: 's', createdAt: '', job: input, result, stopReason: 'Complete' as const }],
    };
    expect(result.roundIndex).toBe(0);
    expect(parseProject(JSON.parse(serializeProject(project))).solutions[0].result.roundIndex).toBe(
      0,
    );
    expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
    const corrupt = (change: (r: Result) => void) => {
      const copy = JSON.parse(serializeProject(project)) as typeof project;
      change(copy.solutions[0].result);
      expect(() => parseProject(copy)).toThrow('invalid solution');
    };
    corrupt((r) => {
      r.unplaced = [{ partId: input.parts[0].id, quantity: 1 }];
    });
    corrupt((r) => {
      r.sheets![0].result.placements[0].xMm = 100;
    });
    corrupt((r) => {
      r.sheets![0].result.usedLengthMm = 21;
    });
    corrupt((r) => {
      r.sheets![0].result.sheets = [];
    });
    corrupt((r) => {
      r.sheets![0].job.parts[0].outer[1][0] = 9;
    });
    expect(() => exportSVG(input, result)).toThrow('each sheet');
    const last = result.sheets!.at(-1)!;
    expect(exportSVG(last.job, last.result).svg).toContain('20 × 10 mm');
  });
});
