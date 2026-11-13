import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Job } from '../src/engine/model';
import { readSheetStage, type SheetStage } from '../src/engine/sheetStage';
import { SheetWorkerSession } from '../src/engine/workers/sheetSession';
import { sheetStripSolver } from '../src/engine/workers/sheetSolver';
import { splitVirtualResult, stitchBoards } from '../src/engine/virtualSheets';
import { sheetBoardNumber, sheetStageLabel } from '../src/ui/views/sheetStageLabel';

const catalog = (): Job => ({
  name: 'stage',
  parts: [
    newPart([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
  ],
  settings: { ...DEFAULT_SETTINGS, materialWidthMm: 100, sheetLengthMm: 100 },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockWorkers() {
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    step?: Record<string, unknown>;
    constructor() {
      workers.push(this);
    }
    postMessage(message: Record<string, unknown>) {
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type === 'session-step') this.step = message;
      if (message.type === 'session-cancel')
        queueMicrotask(() => this.send({ type: 'finished', attemptId: message.attemptId }));
    }
    send(data: Record<string, unknown>) {
      this.onmessage?.({ data: { runId: 1, documentRevision: 7, ...data } });
    }
    stage(stage: Record<string, unknown>) {
      this.send({ type: 'sheet-stage', attemptId: this.step?.attemptId, ...stage });
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  return workers;
}

it('normalizes stage defaults and clears board identity on global or evacuation', () => {
  expect(readSheetStage({ stage: 'local', boardIndex: 2 })).toEqual({
    stage: 'local',
    boardIndex: 2,
    phase: 'Compression',
  });
  expect(readSheetStage({ stage: 'global', boardIndex: 2 })).toEqual({
    stage: 'global',
    phase: 'Exploration',
  });
  expect(readSheetStage({ stage: 'evacuation', boardIndex: 2 })).toEqual({ stage: 'evacuation' });
  for (const boardIndex of [undefined, -1, 0.5, NaN, '1'])
    expect(readSheetStage({ stage: 'local', boardIndex })).toBeUndefined();
});

it.each([
  [undefined, 'Insertion', 'Joint search'],
  [undefined, 'Compression', 'Joint compression'],
  [{ stage: 'local', boardIndex: 2 }, 'Insertion', 'Board 3 · local compression'],
  [
    { stage: 'local', boardIndex: 0, phase: 'Exploration' },
    'Compression',
    'Board 1 · local compression · exploration',
  ],
  [{ stage: 'global' }, 'Compression', 'Global exploration'],
  [{ stage: 'global', phase: 'Compression' }, 'Insertion', 'Global compression'],
  [{ stage: 'evacuation' }, 'Insertion', 'Board evacuation'],
] as [SheetStage | undefined, 'Insertion' | 'Compression', string][])(
  'formats live stage %j during %s',
  (stage, phase, expected) => {
    expect(sheetStageLabel(stage, phase)).toBe(expected);
  },
);

it('forwards stage before any candidate, ignoring stale identities and aborted attempts', async () => {
  vi.useFakeTimers();
  const workers = mockWorkers();
  const job = catalog();
  const session = new SheetWorkerSession(job, 7);
  const controller = new AbortController();
  const stages = vi.fn();
  const candidate = vi.fn();
  const pending = session.attempt(
    job,
    controller.signal,
    candidate,
    1000,
    undefined,
    undefined,
    stages,
  );
  await vi.advanceTimersByTimeAsync(1);
  const worker = workers[0];
  const stage = {
    type: 'sheet-stage',
    attemptId: worker.step!.attemptId,
    stage: 'local',
    boardIndex: 1,
  };
  worker.send({ ...stage, runId: 2 });
  worker.send({ ...stage, documentRevision: 8 });
  worker.send({ ...stage, attemptId: -1 });
  worker.stage({ stage: 'local', boardIndex: 1 });
  expect(stages.mock.calls).toEqual([[{ stage: 'local', boardIndex: 1, phase: 'Compression' }]]);
  expect(candidate).not.toHaveBeenCalled();
  worker.stage({ stage: 'global', boardIndex: 1, phase: 'Compression' });
  expect(stages).toHaveBeenLastCalledWith({ stage: 'global', phase: 'Compression' });
  controller.abort();
  worker.stage({ stage: 'local', boardIndex: 0 });
  expect(stages).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await pending;
  const next = session.attempt(job, undefined, undefined, 1000, undefined, undefined, stages);
  await vi.advanceTimersByTimeAsync(1);
  worker.send(stage);
  expect(stages).toHaveBeenCalledTimes(2);
  worker.stage({ stage: 'evacuation' });
  expect(stages).toHaveBeenLastCalledWith({ stage: 'evacuation' });
  session.close();
  await next;
});

it('ignores stage messages from a disposed worker generation', async () => {
  vi.useFakeTimers();
  const workers = mockWorkers();
  const job = catalog();
  const session = new SheetWorkerSession(job, 7);
  const stages = vi.fn();
  const first = session.attempt(job, undefined, undefined, 1000, undefined, undefined, stages);
  await vi.advanceTimersByTimeAsync(1);
  session.close();
  await first;
  const second = session.attempt(job, undefined, undefined, 1000, undefined, undefined, stages);
  await vi.advanceTimersByTimeAsync(1);
  workers[0].send({
    type: 'sheet-stage',
    attemptId: workers[1].step!.attemptId,
    stage: 'local',
    boardIndex: 0,
  });
  expect(stages).not.toHaveBeenCalled();
  workers[1].stage({ stage: 'global' });
  expect(stages).toHaveBeenCalledWith({ stage: 'global', phase: 'Exploration' });
  session.close();
  await second;
});

it('passes the seventh StripAttempt callback through the solver facade', async () => {
  vi.useFakeTimers();
  const workers = mockWorkers();
  const job = catalog();
  const solve = sheetStripSolver(7);
  await solve.beginSheet!(job);
  const stages = vi.fn();
  const pending = solve(job, undefined, undefined, 1000, undefined, undefined, stages);
  await vi.advanceTimersByTimeAsync(1);
  workers[0].stage({ stage: 'local', boardIndex: 0 });
  expect(stages).toHaveBeenCalledWith({ stage: 'local', boardIndex: 0, phase: 'Compression' });
  solve.endSheet!();
  await pending;
});

it('keeps original virtual board numbering when empty candidate boards are filtered', () => {
  const job = catalog();
  const stock = {
    id: 'stock',
    name: 'Board',
    kind: 'rectangle' as const,
    lengthMm: 100,
    widthMm: 100,
    quantity: 2,
    priority: 0,
  };
  const virtual = stitchBoards(job, [stock, stock]);
  const result = splitVirtualResult(job, virtual, {
    documentRevision: 7,
    solverRevision: 'test',
    seed: '1',
    elapsedSeconds: 0,
    usedLengthMm: 111,
    placements: [{ partId: job.parts[0].id, copyIndex: 0, xMm: 101, yMm: 0, angleDeg: 0 }],
    validation: {
      status: 'pending',
      overlapAreaMm2: null,
      maxBoundaryViolationMm: null,
      minClearanceMm: null,
      errors: [],
    },
  });
  expect(result?.sheets).toHaveLength(1);
  expect(result!.sheets![0].result.physicalBoardIndex).toBe(1);
  expect(sheetBoardNumber(structuredClone(result!.sheets![0].result), 0)).toBe(2);
  expect(sheetBoardNumber({}, 0)).toBe(1);
});
