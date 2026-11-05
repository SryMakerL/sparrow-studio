import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { solveSheets, type StripAttempt } from '../src/engine/sheets';
import { validate } from '../src/engine/geometry/validate';

beforeEach(() => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 16 });
  vi.stubGlobal('crossOriginIsolated', false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('initializes a conserved plan then uses independent parallel board solvers', async () => {
  vi.useFakeTimers();
  const part = {
    ...newPart([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
    quantity: 5,
  };
  const input: Job = {
    name: 'Parallel integration',
    parts: [part],
    settings: {
      ...DEFAULT_SETTINGS,
      materialWidthMm: 10,
      sheetLengthMm: 20,
      sheetCount: 3,
      sheetCompressionSeconds: 1,
      sheetInsertionFailures: 1,
      timeLimitSeconds: 10,
    },
  };
  const layout = (child: Job): Result => ({
    documentRevision: 0,
    solverRevision: 'test',
    seed: '',
    elapsedSeconds: 0,
    usedLengthMm: child.parts[0].quantity * 10,
    placements: Array.from({ length: child.parts[0].quantity }, (_, copyIndex) => ({
      partId: part.id,
      copyIndex,
      xMm: copyIndex * 10,
      yMm: 0,
      angleDeg: 0,
    })),
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  });
  let active = 0,
    peak = 0,
    forks = 0;
  const closed: number[] = [];
  const initial: StripAttempt = async (child) => layout(child);
  initial.forkSheet = () => {
    const id = forks++;
    const solve: StripAttempt = async (child) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return layout(child);
    };
    solve.endSheet = () => closed.push(id);
    return solve;
  };
  const snapshots: Result[] = [];
  const pending = solveSheets(input, initial, { onCurrentRound: (next) => snapshots.push(next) });
  await vi.advanceTimersByTimeAsync(10_000);
  const outcome = await pending;
  expect(forks).toBe(3);
  expect(peak).toBeGreaterThan(1);
  expect(new Set(closed).size).toBe(3);
  expect(outcome.result.sheets?.map((sheet) => sheet.job.parts[0].quantity)).toEqual([2, 2, 1]);
  expect(outcome.result.unplaced).toEqual([]);
  expect(snapshots.every((next) => validate(input, next).status === 'passed')).toBe(true);
  expect(validate(input, outcome.result).status).toBe('passed');
});
