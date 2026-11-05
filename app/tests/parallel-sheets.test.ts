import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  newPart,
  SOLVER_REVISION,
  type Job,
  type Result,
  type Validation,
} from '../src/engine/model';
import { validate } from '../src/engine/geometry/validate';
import { optimizeParallelSheets } from '../src/engine/parallelSheets';
import type { StripAttempt } from '../src/engine/sheets';

const passed: Validation = {
  status: 'passed',
  overlapAreaMm2: 0,
  maxBoundaryViolationMm: 0,
  minClearanceMm: null,
  errors: [],
};
const count = (job: Job) => job.parts.reduce((sum, part) => sum + part.quantity, 0);
function row(job: Job, length = count(job) * 10): Result {
  let x = 0;
  return {
    documentRevision: 1,
    solverRevision: SOLVER_REVISION,
    seed: 'row',
    elapsedSeconds: 0,
    usedLengthMm: length,
    validation: structuredClone(passed),
    placements: job.parts.flatMap((part) =>
      Array.from({ length: part.quantity }, (_, copyIndex) => {
        const placement = { partId: part.id, copyIndex, xMm: x, yMm: 0, angleDeg: 0 };
        x += 10;
        return placement;
      }),
    ),
  };
}
function fixture(groups: string[][], pending: string[] = []) {
  const ids = [...new Set([...groups.flat(), ...pending])];
  const job: Job = {
    name: 'parallel',
    parts: ids.map((id, priority) => ({
      ...newPart([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
      id,
      priority,
      quantity: [...groups.flat(), ...pending].filter((item) => item === id).length,
      rotations: { kind: 'discrete', degrees: [0] },
    })),
    settings: {
      ...DEFAULT_SETTINGS,
      sheetLengthMm: 200,
      materialWidthMm: 10,
      sheetCount: groups.length,
      sheetCompressionSeconds: 1,
      sheetInsertionFailures: 3,
    },
  };
  const sheets = groups.map((group, index) => {
    const { sheetCount: _, ...settings } = job.settings;
    const child: Job = {
      ...job,
      name: `board-${index}`,
      settings,
      parts: job.parts
        .filter((part) => group.includes(part.id))
        .map((part) => ({
          ...part,
          quantity: group.filter((id) => id === part.id).length,
        })),
    };
    return { job: child, result: row(child, group.length * 10 + 10) };
  });
  const initial: Result = {
    ...row(job),
    placements: [],
    sheets,
    usedLengthMm: sheets.reduce((sum, sheet) => sum + sheet.result.usedLengthMm, 0),
    unplaced: ids
      .filter((id) => pending.includes(id))
      .map((partId) => ({
        partId,
        quantity: pending.filter((id) => id === partId).length,
      })),
  };
  return { job, initial };
}
function factory(
  run: (index: number, ...args: Parameters<StripAttempt>) => ReturnType<StripAttempt>,
) {
  const sessions: StripAttempt[] = [];
  const create = () => {
    const index = sessions.length;
    const solve: StripAttempt = (...args) => run(index, ...args);
    solve.beginSheet = vi.fn();
    solve.endSheet = vi.fn();
    sessions.push(solve);
    return solve;
  };
  return { create, sessions };
}
beforeEach(() => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 16 });
  vi.stubGlobal('crossOriginIsolated', false);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('parallel board optimization', () => {
  it('reuses resident sessions across fill and compression waves and closes them once', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    job.settings.sheetConcurrency = 2;
    const { create, sessions } = factory(async () => undefined);
    const pending = optimizeParallelSheets(job, initial, create, { deadline: 10_000 });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    for (const session of sessions) {
      expect(session.beginSheet).toHaveBeenCalledTimes(1);
      expect(session.endSheet).toHaveBeenCalledTimes(1);
    }
  });

  it('evicts only idle sessions within the resident capacity and cleans up on completion', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c']]);
    job.settings.sheetConcurrency = 2;
    job.settings.sheetInsertionFailures = 2;
    const resident = new Set<number>();
    const busy = new Set<number>();
    let peak = 0;
    let opens = 0;
    let closes = 0;
    const sessions: StripAttempt[] = [];
    const create = () => {
      const id = sessions.length;
      const solve: StripAttempt = async (child, _signal, _offer, _budget, warm) => {
        expect(resident.has(id)).toBe(true);
        busy.add(id);
        if (warm && count(child) === warm.placements.length)
          await new Promise((resolve) => setTimeout(resolve, 10));
        busy.delete(id);
        return undefined;
      };
      solve.beginSheet = () => {
        expect(resident.has(id)).toBe(false);
        resident.add(id);
        opens++;
        peak = Math.max(peak, resident.size);
      };
      solve.endSheet = () => {
        expect(busy.has(id)).toBe(false);
        expect(resident.delete(id)).toBe(true);
        closes++;
      };
      sessions.push(solve);
      return solve;
    };
    const pending = optimizeParallelSheets(job, initial, create, { deadline: 10_000 });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(peak).toBe(2);
    expect(opens).toBeGreaterThan(3);
    expect(closes).toBe(opens);
    expect(resident.size).toBe(0);
  });

  it.each([1, 3])(
    'does not count initialization as a failure and retries insertion after each of %s compression waves',
    async (limit) => {
      const { job, initial } = fixture([['a'], ['b']]);
      job.settings.sheetInsertionFailures = limit;
      const calls: string[] = [];
      const { create } = factory(async (index, child, _signal, _offer, _budget, warm) => {
        if (warm && count(child) === warm.placements.length) {
          calls.push(`compress:${index}`);
          return;
        }
        calls.push(warm ? 'warm' : 'cold');
        return undefined;
      });
      const onResult = vi.fn();
      const pending = optimizeParallelSheets(job, initial, create, {
        deadline: performance.now() + 20_000,
        onResult,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual(initial);
      expect(calls).toEqual([
        'warm',
        'cold',
        ...Array.from({ length: limit }, () => ['compress:0', 'compress:1', 'warm', 'cold']).flat(),
      ]);
      expect(onResult).not.toHaveBeenCalled();
    },
  );

  it.each([1, 3, 6, 8])(
    'honors the configured concurrency ceiling of %s and visits every board once per wave',
    async (concurrency) => {
      const { job, initial } = fixture(Array.from({ length: 7 }, () => ['a']));
      job.settings.sheetConcurrency = concurrency;
      job.settings.sheetInsertionFailures = 2;
      let running = 0,
        peak = 0;
      const compressed: number[] = [];
      const { create, sessions } = factory(async (index, child, _signal, _offer, budget, warm) => {
        if (!warm || count(child) !== warm.placements.length) return;
        compressed.push(index);
        expect(budget).toBe(1000);
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 100));
        running--;
        return row(child);
      });
      const pending = optimizeParallelSheets(job, initial, create, { deadline: 10_000 });
      await vi.advanceTimersByTimeAsync(2000);
      const result = await pending;
      expect(peak).toBe(Math.min(concurrency, 7));
      expect(compressed).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6]);
      expect(result.sheets).toHaveLength(7);
      expect(validate(job, result).status).toBe('passed');
      expect(sessions.every((session) => vi.mocked(session.endSheet!).mock.calls.length > 0)).toBe(
        true,
      );
      for (const session of sessions) {
        expect(vi.mocked(session.beginSheet!).mock.calls[0][0].parts).toEqual(job.parts);
        expect(vi.mocked(session.beginSheet!).mock.calls[0][0].settings.sheetCount).toBeUndefined();
      }
    },
  );

  it('fills target zero from pending then the last source in priority order, publishes only atomic snapshots and deletes empty tails', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c', 'd']], ['e']);
    const before = structuredClone(initial);
    const order: string[] = [];
    const snapshots: Result[] = [];
    const controller = new AbortController();
    let oldOffer: ((result: Result) => void) | undefined;
    let stale: Result | undefined;
    const { create, sessions } = factory(async (index, child, _signal, offer, _budget, warm) => {
      if (index !== 0 || !warm || count(child) === warm.placements.length) return;
      const added = child.parts.find(
        (part) => part.quantity > warm.placements.filter((p) => p.partId === part.id).length,
      )!;
      order.push(added.id);
      if (!oldOffer) {
        oldOffer = offer;
        stale = row(child);
      } else oldOffer?.(stale!);
      return row(child);
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: Infinity,
      signal: controller.signal,
      onResult: (result) => {
        expect(validate(job, result).status).toBe('passed');
        snapshots.push(structuredClone(result));
        if (result.sheets!.length === 1) controller.abort();
        result.sheets!.length = 0;
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(order).toEqual(['e', 'd', 'c', 'b']);
    expect(snapshots.map((snapshot) => snapshot.sheets!.length)).toEqual([3, 3, 2, 1]);
    expect(initial).toEqual(before);
    expect(result.sheets).toHaveLength(1);
    expect(sessions[2].beginSheet).not.toHaveBeenCalled();
    expect(sessions[2].endSheet).not.toHaveBeenCalled();
    expect(result.sheets![0].result.placements).toHaveLength(5);
  });

  it('removes the highest copy from a source without moving its survivors', async () => {
    const { job, initial } = fixture([['a'], ['b', 'b']]);
    const controller = new AbortController();
    const survivor = structuredClone(initial.sheets![1].result.placements[0]);
    const { create } = factory(async (index, child, _signal, _offer, _budget, warm) =>
      index === 0 && warm && count(child) > warm.placements.length ? row(child) : undefined,
    );
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: Infinity,
      signal: controller.signal,
      onResult: (result) => {
        if (result.sheets![1]?.job.parts[0].quantity === 1) controller.abort();
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.sheets![1].result.placements).toEqual([survivor]);
    expect(result.sheets![1].result.usedLengthMm).toBe(initial.sheets![1].result.usedLengthMm);
    expect(validate(job, result).status).toBe('passed');
  });

  it('rolls back failed warm validation, tries cold with its own budget and never exposes the temporary target', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    job.settings.sheetInsertionFailures = 1;
    const budgets: number[] = [];
    const onResult = vi.fn();
    const { create } = factory(async (_index, child, _signal, _offer, budget, warm) => {
      budgets.push(budget!);
      if (warm) return { ...row(child), placements: [] };
      return undefined;
    });
    const pending = optimizeParallelSheets(job, initial, create, { deadline: 20_000, onResult });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(initial);
    expect(budgets).toEqual([10_000, 2500, 1000, 1000, 10_000, 2500]);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('rolls back both boards when aggregate validation rejects a valid target candidate', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    job.settings.sheetInsertionFailures = 1;
    const onResult = vi.fn();
    let aggregateChecks = 0;
    const { create } = factory(async (_index, child) => row(child));
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: performance.now() + 20_000,
      onResult,
      validate: async (child, result) => {
        if (!result.sheets) return validate(child, result);
        aggregateChecks++;
        expect(validate(job, result).status).toBe('passed');
        return { ...passed, status: 'failed', errors: ['aggregate rejected'] };
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(initial);
    expect(aggregateChecks).toBe(6);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('uses a validated cold fallback after a warm failure without publishing the warm candidate', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    const controller = new AbortController();
    const budgets: number[] = [];
    const snapshots: Result[] = [];
    const { create } = factory(async (_index, child, _signal, _offer, budget, warm) => {
      budgets.push(budget!);
      if (warm) throw Error('Warm start insertion failed: no placement');
      return row(child);
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: Infinity,
      signal: controller.signal,
      onResult: (result) => {
        snapshots.push(result);
        controller.abort();
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(budgets).toEqual([10_000, 2500]);
    expect(snapshots).toHaveLength(1);
    expect(result.sheets).toHaveLength(1);
    expect(validate(job, result).status).toBe('passed');
  });

  it.each(['solve', 'validate', 'aggregate'] as const)(
    'returns on Stop during hung %s and rejects late candidates',
    async (mode) => {
      const { job, initial } = fixture([['a'], ['b']]);
      const controller = new AbortController();
      let offer: ((result: Result) => void) | undefined;
      let lateResult: Result | undefined;
      let resolveLate: ((value: Validation) => void) | undefined;
      const onResult = vi.fn();
      const { create, sessions } = factory(async (_index, child, _signal, callback) => {
        offer = callback;
        lateResult = row(child);
        if (mode === 'solve') return new Promise(() => {});
        return lateResult;
      });
      const pending = optimizeParallelSheets(job, initial, create, {
        deadline: Infinity,
        signal: controller.signal,
        onResult,
        validate: async (child, result) => {
          if (mode === 'aggregate' && !result.sheets) return validate(child, result);
          return new Promise((resolve) => {
            resolveLate = resolve;
          });
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();
      expect(await pending).toEqual(initial);
      resolveLate?.(passed);
      offer?.(lateResult!);
      await vi.advanceTimersByTimeAsync(1000);
      expect(onResult).not.toHaveBeenCalled();
      expect(sessions[0].endSheet).toHaveBeenCalled();
    },
  );

  it('clips the warm budget to deadline and waits out a sub-50ms remainder without starting work', async () => {
    const first = fixture([['a'], ['b']]);
    const budgets: number[] = [];
    const { create } = factory(async (_index, _child, signal, _offer, budget) => {
      budgets.push(budget!);
      expect(signal?.aborted).toBe(false);
      return new Promise(() => {});
    });
    const pending = optimizeParallelSheets(first.job, first.initial, create, {
      deadline: performance.now() + 70,
    });
    await vi.advanceTimersByTimeAsync(70);
    expect(await pending).toEqual(first.initial);
    expect(budgets).toEqual([70]);
    const second = fixture([['a'], ['b']]);
    const small = optimizeParallelSheets(second.job, second.initial, create, {
      deadline: performance.now() + 40,
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(await small).toEqual(second.initial);
    expect(budgets).toEqual([70]);
  });

  it('keeps independent failure counts, resets a reduced source, and does not reset failures for shorter compression', async () => {
    const { job, initial } = fixture([['a'], ['b', 'b'], ['c']]);
    job.settings.sheetInsertionFailures = 3;
    const compressionCounts = [0, 0, 0];
    let moved = false;
    const { create } = factory(async (index, child, _signal, _offer, _budget, warm) => {
      if (warm && count(child) === warm.placements.length) {
        compressionCounts[index]++;
        return row(child, count(child) * 10 + 10 - compressionCounts[index]);
      }
      if (
        index === 0 &&
        compressionCounts[0] === 1 &&
        !moved &&
        child.parts.some((part) => part.id === 'b')
      ) {
        moved = true;
        return row(child);
      }
      return undefined;
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: performance.now() + 20_000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(moved).toBe(true);
    expect(compressionCounts).toEqual([3, 3, 3]);
    expect(result.sheets!.map((sheet) => count(sheet.job))).toEqual([2, 1, 1]);
    expect(validate(job, result).status).toBe('passed');
  });

  it.each([Infinity, 2500])(
    'continues a complete final single board past the failure limit until %s',
    async (duration) => {
      const { job, initial } = fixture([['a']]);
      job.settings.sheetInsertionFailures = 1;
      const controller = new AbortController();
      const signals: AbortSignal[] = [];
      const budgets: number[] = [];
      const { create } = factory(async (_index, _child, signal, _offer, budget) => {
        signals.push(signal!);
        budgets.push(budget!);
        return new Promise(() => {});
      });
      let settled = false;
      const pending = optimizeParallelSheets(job, initial, create, {
        deadline: Number.isFinite(duration) ? performance.now() + duration : Infinity,
        signal: controller.signal,
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(2500);
      if (!Number.isFinite(duration)) {
        expect(settled).toBe(false);
        controller.abort();
      }
      expect(await pending).toEqual(initial);
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(budgets.slice(0, 2)).toEqual([1000, 1000]);
      if (Number.isFinite(duration)) expect(budgets[2]).toBe(400);
    },
  );

  it('accepts multiple improving candidates in one compression slice but rejects equal, longer and stale offers', async () => {
    const { job, initial } = fixture([['a']]);
    const controller = new AbortController();
    const seeds: string[] = [];
    let oldOffer: ((result: Result) => void) | undefined;
    const { create } = factory(async (_index, child, _signal, offer) => {
      oldOffer = offer;
      for (const [delay, length] of [
        [10, 19],
        [20, 19],
        [30, 21],
        [40, 18],
      ]) {
        setTimeout(() => offer?.({ ...row(child, length), seed: String(length) }), delay);
      }
      return new Promise(() => {});
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: Infinity,
      signal: controller.signal,
      onResult: (result) => {
        seeds.push(result.sheets![0].result.seed);
      },
    });
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    const result = await pending;
    oldOffer?.({ ...result.sheets![0].result, usedLengthMm: 17 });
    await vi.advanceTimersByTimeAsync(100);
    expect(seeds).toEqual(['19', '18']);
    expect(result.sheets![0].result.usedLengthMm).toBe(18);
  });
});
