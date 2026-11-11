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
const job = (quantity = 5, count = 3, seconds: number | null = null): Job => ({
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
    seed: 'row',
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
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function finish(pending: ReturnType<typeof solveSheets>, ms = 100) {
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}
const quantity = (child: Job) => child.parts.reduce((sum, p) => sum + p.quantity, 0);

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
  });

  it('does not reset failed insertion count when compression improves length', async () => {
    const input = job(3, 2);
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
    input.settings.sheetLengthMm = 30;
    const controller = new AbortController();
    const published: string[] = [];
    const accepted = vi.fn();
    let compressed = false;
    let warmStart: Result | undefined;
    const solve: StripAttempt = async (child, _signal, offer, _budget, initial) => {
      if (quantity(child) > 1) {
        if (compressed && initial) {
          warmStart = structuredClone(initial);
          controller.abort();
        }
        return undefined;
      }
      const base = (await row(child))!;
      if (!initial) return { ...base, seed: 'initial' };
      compressed = true;
      const earlier = {
        ...base,
        seed: 'earlier',
        placements: base.placements.map((p) => ({ ...p, yMm: 1 })),
      };
      const latest = {
        ...base,
        seed: 'latest',
        placements: base.placements.map((p) => ({ ...p, yMm: 5 })),
      };
      offer?.(earlier);
      await Promise.resolve();
      offer?.(latest);
      return latest;
    };
    solve.acceptCandidate = accepted;
    const pending = solveSheets(input, solve, {
      signal: controller.signal,
      onSheet: (result) => published.push(result.sheets![0].result.seed),
    });
    await finish(pending);
    expect(warmStart?.seed).toBe('latest');
    expect(warmStart?.placements[0].yMm).toBe(5);
    expect(published).toEqual(['initial']);
    expect(accepted.mock.calls.some(([result]) => result.seed === 'latest')).toBe(true);
  });

  it('probes an impossible initial selection finitely and immediately moves to the next sheet', async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const outcome = await finish(
      solveSheets(
        job(5, 2),
        async (child) => {
          calls.push(quantity(child));
          throw Error(
            `No valid initial placement could be constructed for item ${child.parts[0].id}`,
          );
        },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.sheetIndex === 1) controller.abort();
          },
        },
      ),
    );
    expect(calls).toEqual([2, 1]);
    expect(outcome.result.sheets).toEqual([]);
    expect(outcome.result.unplaced![0].quantity).toBe(5);
    expect(outcome.result.elapsedSeconds).toBe(0);
  });

  it.each([true, false])(
    'uses compressed placements for warm insertion without cold fallback (warm succeeds: %s)',
    async (warmSucceeds) => {
      const input = job(3, 1);
      input.settings.sheetLengthMm = 40;
      input.settings.sheetInsertionWarmStartSeconds = 30;
      const controller = new AbortController();
      let compressed = false;
      const warm: number[] = [];
      const cold: number[] = [];
      setTimeout(() => controller.abort(), 50);
      const outcome = await finish(
        solveSheets(
          input,
          async (child, _signal, _offer, budget, initial) => {
            const n = quantity(child);
            if (initial && n === initial.placements.length) {
              compressed = true;
              return { ...(await row(child))!, seed: 'compressed' };
            }
            if (n > 1 && !compressed) return undefined;
            if (initial) {
              expect(budget).toBe(30_000);
              if (initial.placements.length === 1) expect(initial.seed).toBe('compressed');
              warm.push(n);
              if (!warmSucceeds) return undefined;
            } else if (compressed) {
              expect(budget).toBe(30_000);
              cold.push(n);
            }
            const result = (await row(child))!;
            return compressed ? result : { ...result, usedLengthMm: 11 };
          },
          {
            signal: controller.signal,
            onProgress: (p) => {
              if (p.roundIndex > 0) controller.abort();
            },
          },
        ),
      );
      expect(warm).toEqual(warmSucceeds ? [2, 3] : [2, 2, 2]);
      expect(cold).toEqual([]);
      expect(outcome.result.unplaced).toEqual(
        warmSucceeds ? [] : [{ partId: input.parts[0].id, quantity: 2 }],
      );
      expect(validate(input, outcome.result).status).toBe('passed');
    },
  );
});

describe('fixed budgets, cancellation and independent validation', () => {
  it('honors a global deadline before the final product window without spinning on a short remainder', async () => {
    const input = job(1, 1, 10);
    input.settings.sheetCompressionSeconds = 1;
    input.settings.sheetInsertionFailures = 20;
    const budgets: number[] = [];
    const signals: AbortSignal[] = [];
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
        normalize: async (child) => {
          await new Promise((resolve) => setTimeout(resolve, 7760));
          return normalizeJob(child);
        },
      },
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(9961);
    expect(settled).toBe(false);
    expect(budgets).toEqual([1000, 1000]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(38);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.elapsedSeconds).toBe(input.settings.timeLimitSeconds);
    expect(outcome.result.elapsedSeconds).toBeLessThan(
      input.settings.sheetCompressionSeconds * input.settings.sheetInsertionFailures,
    );
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
    await vi.advanceTimersByTimeAsync(3000);
    expect(budgets).toEqual([1000, 1000]);
  });

  it('keeps maximum final compression products in slices no longer than 600000ms', async () => {
    const input = job(1, 1);
    input.settings.sheetCompressionSeconds = 600;
    input.settings.sheetInsertionFailures = 100;
    const windowMs =
      input.settings.sheetCompressionSeconds * input.settings.sheetInsertionFailures * 1000;
    const budgets: number[] = [];
    const starts: number[] = [];
    const signals: AbortSignal[] = [];
    let settled = false;
    const pending = solveSheets(input, async (child, signal, _offer, budget, initial) => {
      if (!initial) return row(child);
      budgets.push(budget!);
      starts.push(performance.now());
      signals.push(signal!);
      return new Promise(() => {});
    }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(windowMs - 1);
    expect(settled).toBe(false);
    expect(budgets).toHaveLength(100);
    expect(budgets.every((budget) => budget > 0 && budget <= 600_000)).toBe(true);
    expect(budgets.slice(0, -1)).toEqual(Array(99).fill(600_000));
    expect(budgets.at(-1)).toBe(600_000 - 99 * 100);
    expect(starts.slice(1).map((at, i) => at - starts[i])).toEqual(Array(99).fill(600_100));
    expect(signals.at(-1)!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await pending;
    expect(outcome.reason).toBe('Complete');
    expect(outcome.result.elapsedSeconds).toBe(windowMs / 1000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(outcome.result.sheets).toHaveLength(1);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(budgets).toHaveLength(100);
  });

  it('keeps the compression deadline fixed despite late improving candidates and ignores candidates after expiry', async () => {
    const input = job(1, 1);
    input.settings.sheetLengthMm = 30;
    const controller = new AbortController();
    const published: Result[] = [];
    let compressionSignal: AbortSignal | undefined;
    let lateOffer: ((result: Result) => void) | undefined;
    let base: Result | undefined;
    let at = 0;
    const pending = solveSheets(
      input,
      async (child, signal, offer, budget, initial) => {
        base = (await row(child))!;
        if (!initial) return { ...base, usedLengthMm: 14, seed: 'initial' };
        expect(budget).toBe(10_000);
        at = performance.now();
        compressionSignal = signal;
        lateOffer = offer;
        for (const [delay, length] of [
          [1000, 13],
          [9000, 12],
          [9999, 11],
        ]) {
          setTimeout(() => offer?.({ ...base!, usedLengthMm: length, seed: `at-${delay}` }), delay);
        }
        return new Promise(() => {});
      },
      {
        signal: controller.signal,
        onSheet: (r) => published.push(r),
        onProgress: (p) => {
          if (p.roundIndex > 0) controller.abort();
        },
      },
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(compressionSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(performance.now() - at).toBe(10_000);
    expect(compressionSignal?.aborted).toBe(true);
    controller.abort();
    const outcome = await finish(pending);
    expect(outcome.result.sheets![0].result.usedLengthMm).toBe(11);
    const count = published.length;
    lateOffer?.({ ...base!, seed: 'too-late' });
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toHaveLength(count);
  });

  it.each(['stop', 'deadline'] as const)(
    'preserves verified work and aborts hung validation at %s',
    async (end) => {
      const input = job(3, 2, end === 'deadline' ? 10 : null);
      const controller = new AbortController();
      const checks: AbortSignal[] = [];
      let resolveLate!: () => void;
      const published: Result[] = [];
      const pending = solveSheets(input, row, {
        signal: controller.signal,
        onSheet: (r) => published.push(r),
        validate: async (child, result, signal) => {
          checks.push(signal!);
          if (checks.length === 1) return validate(child, result);
          return new Promise((resolve) => {
            resolveLate = () => resolve(validate(child, result));
          });
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(checks).toHaveLength(2);
      if (end === 'stop') controller.abort();
      else await vi.advanceTimersByTimeAsync(9900);
      const outcome = await pending;
      expect(outcome.reason).toBe(end === 'stop' ? 'Stopped' : 'Complete');
      expect(outcome.result.sheets![0].job.parts[0].quantity).toBe(2);
      expect(outcome.result.unplaced![0].quantity).toBe(1);
      expect(checks.every((s) => s.aborted)).toBe(true);
      expect(validate(input, outcome.result).status).toBe('passed');
      const count = published.length;
      resolveLate();
      await vi.advanceTimersByTimeAsync(1000);
      expect(published).toHaveLength(count);
      expect(checks).toHaveLength(2);
    },
  );

  it('clips cold and compression budgets to the hard global deadline and starts nothing afterward', async () => {
    const input = job(1, 1, 10);
    const budgets: number[] = [];
    const signals: AbortSignal[] = [];
    const pending = solveSheets(
      input,
      async (child, signal, _offer, budget, initial) => {
        budgets.push(budget!);
        signals.push(signal!);
        if (!initial) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return row(child);
        }
        return new Promise(() => {});
      },
      {
        normalize: async (child) => {
          await new Promise((resolve) => setTimeout(resolve, 9000));
          return normalizeJob(child);
        },
      },
    );
    const outcome = await finish(pending, 10_000);
    expect(budgets).toEqual([1000, 899]);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(outcome.result.elapsedSeconds).toBe(10);
    expect(outcome.result.unplaced).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(budgets).toHaveLength(2);
  });

  it('cancels a hung warm insertion at its configured per-attempt deadline', async () => {
    const input = job(2, 1);
    input.settings.sheetLengthMm = 30;
    input.settings.sheetInsertionWarmStartSeconds = 2;
    const controller = new AbortController();
    let warmSignal: AbortSignal | undefined;
    let coldRetries = 0;
    const pending = solveSheets(
      input,
      async (child, signal, _offer, budget, initial) => {
        if (initial) {
          if (quantity(child) > initial.placements.length) {
            expect(budget).toBe(2000);
            warmSignal = signal;
          }
          return new Promise(() => {});
        }
        if (warmSignal) {
          coldRetries++;
          return undefined;
        }
        return quantity(child) === 1 ? row(child) : undefined;
      },
      { signal: controller.signal },
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(warmSignal).toBeDefined();
    expect(warmSignal!.aborted).toBe(false);
    expect(coldRetries).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(warmSignal!.aborted).toBe(true);
    expect(coldRetries).toBe(0);
    controller.abort();
    await pending;
  });

  it('clips configured warm insertion budget to the remaining global deadline', async () => {
    const input = job(2, 1, 10);
    input.settings.sheetLengthMm = 30;
    input.settings.sheetInsertionWarmStartSeconds = 30;
    const budgets: number[] = [];
    const pending = solveSheets(
      input,
      async (child, _signal, _offer, budget, initial) => {
        if (initial) {
          budgets.push(budget!);
          return new Promise(() => {});
        }
        if (quantity(child) > 1) return undefined;
        return row(child);
      },
      {
        normalize: async (child) => {
          await new Promise((resolve) => setTimeout(resolve, 9000));
          return normalizeJob(child);
        },
      },
    );
    const outcome = await finish(pending, 10_000);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(1000);
    expect(outcome.result.elapsedSeconds).toBe(10);
    expect(outcome.result.unplaced![0].quantity).toBe(1);
  });

  it('rejects self-declared valid malformed candidates, longer and equal results, accepting a later verified improvement', async () => {
    const input = job(2, 1);
    input.settings.sheetLengthMm = 30;
    const controller = new AbortController();
    const published: Result[] = [];
    const accepted = vi.fn();
    const solve: StripAttempt = async (child, _signal, offer, _budget, initial) => {
      const base = (await row(child))!;
      if (!initial) return { ...base, usedLengthMm: 24, seed: 'initial' };
      offer?.({ ...base, usedLengthMm: 23, seed: 'invalid', placements: [] });
      setTimeout(() => offer?.({ ...base, usedLengthMm: 25, seed: 'longer' }), 10);
      setTimeout(() => offer?.({ ...base, usedLengthMm: 24, seed: 'equal' }), 20);
      setTimeout(() => offer?.({ ...base, usedLengthMm: 21, seed: 'verified' }), 30);
      return new Promise(() => {});
    };
    solve.acceptCandidate = accepted;
    const outcome = await finish(
      solveSheets(input, solve, {
        signal: controller.signal,
        onSheet: (r) => {
          published.push(r);
          if (r.sheets![0].result.seed === 'verified') controller.abort();
        },
      }),
    );
    expect(published.map((r) => r.sheets![0].result.seed)).toEqual(['initial', 'verified']);
    expect(accepted.mock.calls.map(([r]) => r.seed)).toEqual(['initial', 'verified']);
    expect(outcome.result.sheets![0].result.usedLengthMm).toBe(21);
    expect(validate(input, outcome.result).status).toBe('passed');
  });

  it('expires hung initial validation and ignores its later resolution and stale solver callback', async () => {
    const input = job(2, 2);
    const controller = new AbortController();
    let oldOffer: ((r: Result) => void) | undefined;
    let oldResult: Result | undefined;
    let resolveLate!: () => void;
    const signals: AbortSignal[] = [];
    const published: Result[] = [];
    const pending = solveSheets(
      input,
      async (child, _signal, offer) => {
        const result = (await row(child))!;
        if (!oldOffer) {
          oldOffer = offer;
          oldResult = result;
        }
        offer?.(result);
        return new Promise(() => {});
      },
      {
        signal: controller.signal,
        onSheet: (r) => published.push(r),
        validate: async (child, result, signal) => {
          signals.push(signal!);
          if (signals.length === 1)
            return new Promise((resolve) => {
              resolveLate = () => resolve(validate(child, result));
            });
          return validate(child, result);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(2499);
    expect(published).toEqual([]);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signals[0].aborted).toBe(true);
    controller.abort();
    const outcome = await pending;
    const count = published.length;
    resolveLate();
    oldOffer?.(oldResult!);
    await vi.advanceTimersByTimeAsync(100);
    expect(published).toHaveLength(count);
    expect(validate(input, outcome.result).status).toBe('passed');
  });

  it('does not count a missing warm-start snapshot as insertion failure or open another sheet', async () => {
    const input = job(3, 2);
    const progress: SheetProgress[] = [];
    let opened = 0;
    let seeded = false;
    const solve: StripAttempt = async (child, _signal, _offer, _budget, initial) => {
      if (initial) throw Error('The warm-start layout snapshot is unavailable.');
      const result = await row(child);
      if (quantity(child) <= 2) seeded = true;
      return result;
    };
    solve.beginSheet = () => {
      opened++;
    };
    const pending = solveSheets(input, solve, { onProgress: (next) => progress.push(next) });
    const rejected = expect(pending).rejects.toThrow('warm-start layout snapshot is unavailable');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(seeded).toBe(true);
    expect(opened).toBe(1);
    expect(progress.every((entry) => entry.insertionFailures === 0)).toBe(true);
  });

  it('does not count Stop during a warm insertion as another failed pass', async () => {
    const input = job(3, 2);
    input.settings.sheetLengthMm = 30;
    const controller = new AbortController();
    const failures: number[] = [];
    let compressions = 0;
    const pending = solveSheets(
      input,
      async (child, _signal, _offer, _budget, initial) => {
        if (initial && quantity(child) === initial.placements.length) {
          compressions++;
          return initial;
        }
        if (initial && compressions > 0) {
          controller.abort();
          return undefined;
        }
        return quantity(child) <= 2 ? row(child) : undefined;
      },
      { signal: controller.signal, onProgress: (next) => failures.push(next.insertionFailures) },
    );
    const outcome = await finish(pending);
    expect(outcome.reason).toBe('Stopped');
    expect(compressions).toBe(1);
    expect(failures.every((count) => count === 0)).toBe(true);
  });

  it('does not start work if already stopped, and propagates infrastructure errors', async () => {
    const controller = new AbortController();
    controller.abort();
    const solve = vi.fn(row);
    expect((await solveSheets(job(), solve, { signal: controller.signal })).reason).toBe('Stopped');
    expect(solve).not.toHaveBeenCalled();
    await expect(
      solveSheets(job(), async () => {
        throw Error('WASM binary failed to load');
      }),
    ).rejects.toThrow('failed to load');
  });
});

describe('rounds, inventory and incumbents', () => {
  it('ends automatic mode after three complete rounds without a best improvement', async () => {
    const rounds: number[] = [];
    const outcome = await finish(
      solveSheets(job(1, 1), async () => undefined, {
        onProgress: (p) => rounds.push(p.roundIndex),
      }),
    );
    expect([...new Set(rounds)]).toEqual([0, 1, 2]);
    expect(outcome.reason).toBe('Unplaceable');
    expect(outcome.result.unplaced![0].quantity).toBe(1);
  });

  it('publishes worse current rounds but preserves the incumbent and isolates callback mutations', async () => {
    const input = job(5, 2);
    const original = JSON.stringify(input);
    let round = 0;
    const current: Result[] = [];
    const published: Result[] = [];
    const outcome = await finish(
      solveSheets(input, (child) => (round === 0 ? row(child) : Promise.resolve(undefined)), {
        onProgress: (p) => {
          round = p.roundIndex;
        },
        onCurrentRound: (r) => {
          current.push(structuredClone(r));
          r.sheets!.forEach((s) => {
            s.result.placements.length = 0;
            s.job.parts[0].quantity = 999;
          });
          r.unplaced!.length = 0;
        },
        onSheet: (r) => {
          published.push(structuredClone(r));
          r.sheets!.length = 0;
        },
      }),
    );
    expect(round).toBe(3);
    expect(
      current.some((r) => r.roundIndex === 1 && !r.sheets!.length && r.unplaced![0].quantity === 5),
    ).toBe(true);
    expect(outcome.result.roundIndex).toBe(0);
    expect(outcome.result.unplaced).toEqual([{ partId: input.parts[0].id, quantity: 1 }]);
    expect(published.at(-1)!.unplaced).toEqual(outcome.result.unplaced);
    expect(
      [...current, ...published, outcome.result].every(
        (r) => validate(input, r).status === 'passed',
      ),
    ).toBe(true);
    expect(JSON.stringify(input)).toBe(original);
  });

  it('uses higher priority stock first, conserves inventory and prioritizes high priority parts', async () => {
    const input = job(1, 2);
    const low = { ...part(10, 1), priority: 0 };
    const high = { ...part(10, 1), priority: 9 };
    input.parts = [low, high];
    input.settings.sheetStocks = [
      {
        id: 'low',
        name: 'Low',
        kind: 'rectangle',
        widthMm: 10,
        lengthMm: 10,
        quantity: 1,
        priority: 0,
      },
      {
        id: 'high',
        name: 'High',
        kind: 'rectangle',
        widthMm: 10,
        lengthMm: 10,
        quantity: 1,
        priority: 9,
      },
    ];
    const outcome = await finish(solveSheets(input, row), 31_000);
    expect(outcome.result.sheets!.map((s) => s.job.settings.sheetStock!.id)).toEqual([
      'high',
      'low',
    ]);
    expect(outcome.result.sheets!.map((s) => s.job.parts[0].id)).toEqual([high.id, low.id]);
    expect(outcome.result.unplaced).toEqual([]);
    expect(validate(input, outcome.result).status).toBe('passed');
  });

  it('fills 50 squares as 30/20, never rolls back committed sheets and preserves input', async () => {
    const input = job(50, 2);
    input.parts = [part(60, 50)];
    input.settings.materialWidthMm = 100;
    input.settings.sheetLengthMm = 1800;
    const before = JSON.stringify(input);
    const current: Result[] = [];
    const outcome = await finish(
      solveSheets(input, row, { onCurrentRound: (r) => current.push(r) }),
      31_000,
    );
    expect(outcome.result.sheets!.map((s) => s.job.parts[0].quantity)).toEqual([30, 20]);
    expect(outcome.result.unplaced).toEqual([]);
    const committed = current.filter((r) => r.roundIndex === 0 && r.currentSheetIndex === 1);
    expect(committed.length).toBeGreaterThan(0);
    expect(
      committed.every(
        (r) => JSON.stringify(r.sheets![0]) === JSON.stringify(committed[0].sheets![0]),
      ),
    ).toBe(true);
    expect(validate(input, outcome.result).status).toBe('passed');
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('sheet project compatibility', () => {
  it('defaults legacy phase settings and roundtrips configuration without changing layout keys', () => {
    const project = addParts(newProject('Job'), [part(10, 1)]);
    const legacy = JSON.parse(serializeProject(project));
    delete legacy.settings.sheetCompressionSeconds;
    delete legacy.settings.sheetInsertionFailures;
    expect(parseProject(legacy).settings).toMatchObject({
      sheetCompressionSeconds: 10,
      sheetInsertionFailures: 3,
    });
    const legacyJob = projectJob(project);
    delete legacyJob.settings.sheetCompressionSeconds;
    delete legacyJob.settings.sheetInsertionFailures;
    expect(normalizeJob(legacyJob).settings).toMatchObject({
      sheetCompressionSeconds: 10,
      sheetInsertionFailures: 3,
    });
    const configured = {
      ...project,
      settings: { ...project.settings, sheetCompressionSeconds: 2, sheetInsertionFailures: 5 },
    };
    expect(parseProject(JSON.parse(serializeProject(configured)))).toEqual(configured);
    expect(projectJob(configured).settings).toMatchObject({
      sheetCompressionSeconds: 2,
      sheetInsertionFailures: 5,
    });
    expect(jobKey(projectJob(configured))).toBe(jobKey(projectJob(project)));
  });

  it.each([
    ...[0, -1, 601, 1.5, NaN, Infinity, null, '3'].map(
      (value) => ['sheetCompressionSeconds', value] as const,
    ),
    ...[0, -1, 101, 1.5, NaN, Infinity, null, '3'].map(
      (value) => ['sheetInsertionFailures', value] as const,
    ),
  ])('rejects invalid %s=%s at project, start and job boundaries', (key, value) => {
    const project = addParts(newProject('Job'), [part(10, 1)]);
    const invalid = { ...project, settings: { ...project.settings, [key]: value as number } };
    expect(() => parseProject(invalid)).toThrow(/sheet/i);
    expect(startBlockers(invalid)).toEqual([expect.stringMatching(/sheet/i)]);
    expect(() => normalizeJob(projectJob(invalid))).toThrow(/sheet/i);
  });

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
  });

  it('roundtrips verified sheets and rejects count, geometry, nested and boundary corruption', async () => {
    const input = job();
    const { result } = await finish(solveSheets(input, row), 31_000);
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
