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
    solve.waitForIdle = vi.fn(async () => {});
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
  it('reuses resident idle sessions and balances every opened generation on completion', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c']]);
    job.settings.sheetConcurrency = 2;
    const resident = new Set<number>();
    const uses = new Map<number, number>();
    let reused = false;
    const { create, sessions } = factory(async (index) => {
      expect(resident.has(index)).toBe(true);
      const count = (uses.get(index) ?? 0) + 1;
      uses.set(index, count);
      if (count > 1) reused = true;
    });
    const start = () => {
      const solve = create();
      const index = sessions.length - 1;
      solve.beginSheet = vi.fn(() => {
        expect(resident.has(index)).toBe(false);
        resident.add(index);
        uses.set(index, 0);
      });
      solve.endSheet = vi.fn(() => expect(resident.delete(index)).toBe(true));
      return solve;
    };
    const pending = optimizeParallelSheets(job, initial, start, { deadline: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(sessions).toHaveLength(3);
    expect(reused).toBe(true);
    expect(resident.size).toBe(0);
    for (const session of sessions) {
      const opened = vi.mocked(session.beginSheet!).mock.calls.length;
      expect(session.endSheet).toHaveBeenCalledTimes(opened);
      if (opened) expect(session.waitForIdle).toHaveBeenCalled();
    }
  });

  it.each([1, 3, 6, 8])(
    'separates resident sessions from the compute ceiling of %s',
    async (concurrency) => {
      const { job, initial } = fixture(Array.from({ length: 9 }, () => ['a']));
      job.settings.sheetConcurrency = concurrency;
      const controller = new AbortController();
      const resident = new Set<number>();
      const busy = new Set<number>();
      const compressed = new Set<number>();
      let residentPeak = 0;
      let computePeak = 0;
      const { create, sessions } = factory(async (index, child, signal, _offer, _budget, warm) => {
        expect(resident.has(index)).toBe(true);
        busy.add(index);
        signal?.addEventListener('abort', () => busy.delete(index), { once: true });
        computePeak = Math.max(computePeak, busy.size);
        try {
          if (warm && count(child) === warm.placements.length) {
            compressed.add(index);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 20);
              signal?.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          }
        } finally {
          busy.delete(index);
        }
      });
      const open = () => {
        const solve = create();
        const index = sessions.length - 1;
        solve.beginSheet = vi.fn(() => {
          expect(resident.has(index)).toBe(false);
          resident.add(index);
          residentPeak = Math.max(residentPeak, resident.size);
        });
        solve.endSheet = vi.fn(() => {
          expect(busy.has(index)).toBe(false);
          expect(resident.delete(index)).toBe(true);
        });
        return solve;
      };
      const pending = optimizeParallelSheets(job, initial, open, {
        deadline: Infinity,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(2000);
      controller.abort();
      const result = await pending;
      expect(computePeak).toBe(concurrency);
      expect(residentPeak).toBe(8);
      expect(compressed.size).toBe(9);
      expect(resident.size).toBe(0);
      expect(validate(job, result).status).toBe('passed');
    },
  );

  it('fills targets serially in board-index order while compressors run independently', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c']]);
    job.settings.sheetConcurrency = 3;
    const order: number[] = [];
    let filling = 0;
    const compressing = new Set<number>();
    let compressionDuringFill = false;
    const { create } = factory(async (index, child, signal, _offer, _budget, warm) => {
      if (warm && count(child) === warm.placements.length) {
        compressing.add(index);
        signal?.addEventListener('abort', () => compressing.delete(index), { once: true });
        if (filling) compressionDuringFill = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        compressing.delete(index);
        return;
      }
      if (compressing.size) compressionDuringFill = true;
      expect(filling++).toBe(0);
      order.push(index);
      await new Promise((resolve) => setTimeout(resolve, 5));
      filling--;
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: performance.now() + 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(order.slice(0, 6)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(compressionDuringFill).toBe(true);
  });

  it('pauses a source and waits for idle before deletion while unrelated compression continues', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c']]);
    job.settings.sheetConcurrency = 3;
    const controller = new AbortController();
    let enabled = false;
    let sourceIdleConfirmed = false;
    let releaseIdle!: () => void;
    const sourceIdle = new Promise<void>((resolve) => {
      releaseIdle = () => {
        sourceIdleConfirmed = true;
        resolve();
      };
    });
    let sourceSignal: AbortSignal | undefined;
    let closesAtSourceStart = 0;
    let unrelatedRuns = 0;
    let deleted = false;
    let unrelatedStillRunning = false;
    const { create, sessions } = factory(async (index, child, signal, _offer, budget, warm) => {
      if (warm && count(child) === warm.placements.length) {
        if (index === 2) {
          sourceSignal = signal;
          closesAtSourceStart = vi.mocked(sessions[2].endSheet!).mock.calls.length;
          enabled = true;
          return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, budget!);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
        }
        if (index === 1) {
          unrelatedRuns++;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return;
        }
        if (index === 2) return new Promise(() => {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        return;
      }
      if (enabled && index === 0 && child.parts.some((part) => part.id === 'c')) return row(child);
    });
    const start = () => {
      const solve = create();
      if (sessions.length === 3) solve.waitForIdle = () => sourceIdle;
      return solve;
    };
    const pending = optimizeParallelSheets(job, initial, start, {
      deadline: Infinity,
      signal: controller.signal,
      onResult: (result) => {
        if (result.sheets!.length === 2) {
          expect(sourceIdleConfirmed).toBe(true);
          deleted = true;
          unrelatedStillRunning = unrelatedRuns > 1;
        }
      },
    });
    await vi.advanceTimersByTimeAsync(1050);
    expect(sourceSignal?.aborted).toBe(true);
    expect(deleted).toBe(false);
    expect(sourceIdleConfirmed).toBe(false);
    expect(sessions[2].endSheet).toHaveBeenCalledTimes(closesAtSourceStart);
    const runsWhilePaused = unrelatedRuns;
    await vi.advanceTimersByTimeAsync(100);
    expect(unrelatedRuns).toBeGreaterThan(runsWhilePaused);
    expect(deleted).toBe(false);
    releaseIdle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(deleted).toBe(true);
    expect(sessions[2].endSheet).toHaveBeenCalledTimes(closesAtSourceStart + 1);
    expect(unrelatedStillRunning).toBe(true);
    controller.abort();
    const result = await pending;
    expect(validate(job, result).status).toBe('passed');
  });

  it('hard-stops all active workers on global Stop without waiting for unresponsive idle acknowledgements', async () => {
    const { job, initial } = fixture([['a'], ['b'], ['c']]);
    job.settings.sheetConcurrency = 3;
    const controller = new AbortController();
    const signals = new Map<number, AbortSignal>();
    const idle = new Map<number, () => void>();
    const acknowledged = new Set<number>();
    const resident = new Set<number>();
    const { create, sessions } = factory(async (index, child, signal, _offer, _budget, warm) => {
      if (!warm || count(child) !== warm.placements.length) return;
      signals.set(index, signal!);
      return new Promise(() => {});
    });
    const start = () => {
      const solve = create();
      const index = sessions.length - 1;
      solve.waitForIdle = () =>
        signals.has(index)
          ? new Promise<void>((resolve) =>
              idle.set(index, () => {
                acknowledged.add(index);
                resolve();
              }),
            )
          : Promise.resolve();
      solve.beginSheet = vi.fn(() => {
        expect(resident.has(index)).toBe(false);
        resident.add(index);
      });
      solve.endSheet = vi.fn(() => {
        expect(resident.delete(index)).toBe(true);
        if (signals.has(index)) expect(signals.get(index)!.aborted).toBe(true);
        idle.get(index)?.();
      });
      return solve;
    };
    let settled = false;
    const pending = optimizeParallelSheets(job, initial, start, {
      deadline: Infinity,
      signal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(signals.size).toBeGreaterThan(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
    const settledBeforeIdle = settled;
    const closedBeforeIdle = sessions.some(
      (session) => vi.mocked(session.endSheet!).mock.calls.length > 0,
    );
    for (const resolve of idle.values()) resolve();
    await pending;
    expect(settledBeforeIdle).toBe(true);
    expect(closedBeforeIdle).toBe(true);
    expect(acknowledged.size).toBe(idle.size);
    expect(resident.size).toBe(0);
    for (const session of sessions) {
      expect(session.endSheet).toHaveBeenCalledTimes(
        vi.mocked(session.beginSheet!).mock.calls.length,
      );
    }
  });

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
    expect(sessions[2].beginSheet).toHaveBeenCalledTimes(1);
    expect(sessions[2].endSheet).toHaveBeenCalledTimes(1);
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
    const controller = new AbortController();
    const onResult = vi.fn();
    const { create } = factory(async (_index, child, _signal, _offer, budget, warm) => {
      if (warm && count(child) === warm.placements.length) return;
      budgets.push(budget!);
      if (warm) return { ...row(child), placements: [] };
      controller.abort();
      return undefined;
    });
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: 20_000,
      onResult,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(initial);
    expect(budgets).toEqual([10_000, 2500]);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('rolls back both boards when aggregate validation rejects a valid target candidate', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    job.settings.sheetInsertionFailures = 1;
    const onResult = vi.fn();
    const controller = new AbortController();
    let aggregateChecks = 0;
    const { create } = factory(async (_index, child, _signal, _offer, _budget, warm) =>
      warm && count(child) === warm.placements.length ? undefined : row(child),
    );
    const pending = optimizeParallelSheets(job, initial, create, {
      deadline: performance.now() + 20_000,
      signal: controller.signal,
      onResult,
      validate: async (child, result) => {
        if (!result.sheets) return validate(child, result);
        aggregateChecks++;
        expect(validate(job, result).status).toBe('passed');
        controller.abort();
        return { ...passed, status: 'failed', errors: ['aggregate rejected'] };
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(initial);
    expect(aggregateChecks).toBe(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('uses a validated cold fallback after a warm failure without publishing the warm candidate', async () => {
    const { job, initial } = fixture([['a'], ['b']]);
    const controller = new AbortController();
    const budgets: number[] = [];
    const snapshots: Result[] = [];
    const { create } = factory(async (_index, child, _signal, _offer, budget, warm) => {
      if (warm && count(child) === warm.placements.length) return;
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
      expect(sessions.some((session) => vi.mocked(session.endSheet!).mock.calls.length > 0)).toBe(
        true,
      );
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
    const { create } = factory(async (index, child, signal, _offer, budget, warm) => {
      if (warm && count(child) === warm.placements.length) {
        compressionCounts[index]++;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, budget!);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        return row(child, count(child) * 10 + 10 - compressionCounts[index]);
      }
      if (
        index === 0 &&
        compressionCounts[0] >= 1 &&
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
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(moved).toBe(true);
    expect(compressionCounts.every((value) => value >= 3)).toBe(true);
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
        return new Promise<undefined>((resolve) => {
          signal?.addEventListener('abort', () => resolve(undefined), { once: true });
        });
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
      if (Number.isFinite(duration)) {
        expect(budgets[2]).toBeGreaterThan(0);
        expect(budgets[2]).toBeLessThanOrEqual(500);
      }
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
