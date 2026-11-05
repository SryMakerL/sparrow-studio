import { afterEach, expect, it, vi } from 'vitest';
import { SheetWorkerSession } from '../src/engine/workers/sheetSession';
import { DEFAULT_SETTINGS, newPart, type Job, type Result } from '../src/engine/model';
import { sheetStripSolver } from '../src/engine/workers/sheetSolver';

vi.mock('../src/engine/sheets', () => ({
  isInitialPlacementFailure: (error: string) => error.startsWith('No valid initial placement'),
}));

const catalog = (): Job => ({
  name: 'session',
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

it('reuses one worker and selects only validated internal snapshots across attempts', async () => {
  const workers: MockWorker[] = [];
  const steps: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    postMessage(message: Record<string, unknown>) {
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type === 'session-step') {
        steps.push(message);
        const index = steps.length;
        queueMicrotask(() => {
          if (index === 2) {
            this.send({
              type: 'attempt-error',
              attemptId: message.attemptId,
              message: 'Warm start insertion failed: no space',
            });
          } else {
            this.send({
              type: 'candidate',
              attemptId: message.attemptId,
              snapshotId: index * 10,
              sequence: 1,
              report: 'Constructed',
              elapsedMs: 1,
              solution: {
                strip_width: 10,
                layout: {
                  placed_items: [
                    { item_id: 0, transformation: { rotation: 0, translation: [0, 0] } },
                  ],
                },
              },
            });
            this.send({ type: 'finished', attemptId: message.attemptId });
          }
        });
      }
    }
    send(data: Record<string, unknown>) {
      this.onmessage?.({ data: { ...data, runId: 1, documentRevision: 7 } });
    }
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  const session = new SheetWorkerSession(job, 7, 2);
  const first = (await session.attempt(job))!;
  session.accept(structuredClone(first));
  await expect(
    session.attempt(job, undefined, undefined, 2500, structuredClone(first)),
  ).resolves.toBeUndefined();
  const third = await session.attempt(job, undefined, undefined, 2500, first);
  expect(third).toBeDefined();
  expect(workers).toHaveLength(1);
  expect(steps[1]).toMatchObject({ initialSnapshot: 10, retainSnapshot: 10, mode: 'compress' });
  expect(steps[2]).toMatchObject({ initialSnapshot: 10, retainSnapshot: 10 });
  session.close();
});

it('hard-stops a stuck session and reinitializes without stale snapshot IDs', async () => {
  vi.useFakeTimers();
  const posted: Record<string, unknown>[] = [];
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      if (message.type === 'session-init')
        queueMicrotask(() =>
          this.onmessage?.({ data: { type: 'session-ready', runId: 1, documentRevision: 1 } }),
        );
    }
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  const session = new SheetWorkerSession(job, 1);
  const first = session.attempt(job, undefined, undefined, 100);
  await vi.advanceTimersByTimeAsync(201);
  await expect(first).resolves.toBeUndefined();
  expect(posted.some((message) => message.type === 'stop')).toBe(true);
  const initial: Result = {
    documentRevision: 1,
    solverRevision: 'external',
    seed: '42',
    elapsedSeconds: 0,
    usedLengthMm: 30,
    placements: [{ partId: job.parts[0].id, copyIndex: 0, xMm: 20, yMm: 20, angleDeg: 0 }],
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
  const second = session.attempt(job, undefined, undefined, 100, initial);
  await vi.advanceTimersByTimeAsync(1);
  expect(workers).toHaveLength(2);
  const steps = posted.filter((message) => message.type === 'session-step');
  expect(steps[1]).toMatchObject({
    initialSnapshot: undefined,
    retainSnapshot: undefined,
    initialPlacement: {
      used_length_mm: 30,
      placements: [{ item_id: 0, rotation: 0, translation: [20, 20] }],
    },
  });
  session.close();
  await expect(second).resolves.toBeUndefined();
});

it.each([30_000, Infinity])(
  'sends one search step with remaining budget and cooperatively cancels Stop (%s)',
  async (budget) => {
    const posted: Record<string, unknown>[] = [];
    class MockWorker {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(message: Record<string, unknown>) {
        posted.push(message);
        if (message.type === 'session-init')
          queueMicrotask(() =>
            this.onmessage?.({ data: { type: 'session-ready', runId: 1, documentRevision: 1 } }),
          );
        if (message.type === 'session-cancel')
          queueMicrotask(() =>
            this.onmessage?.({
              data: {
                type: 'finished',
                runId: 1,
                documentRevision: 1,
                attemptId: message.attemptId,
              },
            }),
          );
      }
    }
    vi.stubGlobal('Worker', MockWorker);
    const session = new SheetWorkerSession(catalog(), 1);
    const controller = new AbortController();
    const pending = session.attempt(catalog(), controller.signal, undefined, budget);
    await vi.waitFor(() =>
      expect(posted.some((message) => message.type === 'session-step')).toBe(true),
    );
    const request = posted.find((message) => message.type === 'session-step')!;
    expect(request.mode).toBe('search');
    if (budget === Infinity) expect(request.budgetMs).toBeNull();
    else expect(request.budgetMs).toBeGreaterThan(29_000);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(posted.at(-1)).toMatchObject({ type: 'session-cancel', attemptId: request.attemptId });
    expect(posted.some((message) => message.type === 'stop')).toBe(false);
    session.close();
  },
);

it('restores an unknown snapshot as raw external coordinates using the full catalog', async () => {
  const posted: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      if (message.type === 'session-init' || message.type === 'session-step')
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: message.type === 'session-init' ? 'session-ready' : 'finished',
              runId: 1,
              documentRevision: 1,
              attemptId: message.attemptId,
            },
          }),
        );
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  job.parts.push({ ...job.parts[0], id: 'second-type' });
  job.parts[0].quantity = 0;
  const subset = { ...job, parts: [job.parts[1]] };
  const initial: Result = {
    documentRevision: 1,
    solverRevision: 'external',
    seed: '42',
    elapsedSeconds: 0,
    usedLengthMm: 45.123456789,
    placements: [
      { partId: 'second-type', copyIndex: 0, xMm: 30.123456789, yMm: 20.987654321, angleDeg: 0 },
    ],
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
  const session = new SheetWorkerSession(job, 1);
  await session.attempt(subset, undefined, undefined, 2500, initial);
  const request = posted.find((message) => message.type === 'session-step')!;
  expect(request).toMatchObject({
    quantities: [0, 1],
    initialSnapshot: undefined,
    initialPlacement: {
      used_length_mm: initial.usedLengthMm,
      placements: [{ item_id: 1, rotation: 0, translation: [30.123456789, 20.987654321] }],
    },
    mode: 'compress',
  });
  session.close();
});

it('forks independent sheet sessions inheriting requested threads without dropping zero-demand catalog IDs', async () => {
  const posted: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      if (message.type === 'session-init')
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: 'session-ready',
              runId: 1,
              documentRevision: 7,
            },
          }),
        );
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const attempt = sheetStripSolver(7, 6);
  const first = attempt.forkSheet!();
  const second = attempt.forkSheet!();
  const job = catalog();
  job.parts.unshift({ ...job.parts[0], id: 'unused', quantity: 0 });
  await Promise.all([first.beginSheet!(job), second.beginSheet!(job)]);
  expect(posted.filter((message) => message.type === 'session-init')).toEqual([
    expect.objectContaining({ threads: 6, document: job }),
    expect.objectContaining({ threads: 6, document: job }),
  ]);
  first.endSheet!();
  expect(posted.filter((message) => message.type === 'stop')).toHaveLength(1);
  second.endSheet!();
  expect(posted.filter((message) => message.type === 'stop')).toHaveLength(2);
});

it('waits for worker completion after a pause request without destroying the session', async () => {
  vi.useFakeTimers();
  let worker: MockWorker;
  let attemptId: unknown;
  const posted: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      worker = this;
    }
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type === 'session-step') attemptId = message.attemptId;
    }
    send(message: Record<string, unknown>) {
      this.onmessage?.({ data: { runId: 1, documentRevision: 1, ...message } });
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const session = new SheetWorkerSession(catalog(), 1);
  const controller = new AbortController();
  const pending = session.attempt(catalog(), controller.signal, undefined, 1000);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  let idle = false;
  const confirmed = session.waitForIdle().then(() => {
    idle = true;
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(idle).toBe(false);
  expect(posted.at(-1)?.type).toBe('session-cancel');
  worker!.send({ type: 'finished', attemptId });
  await confirmed;
  await pending;
  expect(idle).toBe(true);
  expect(posted.some((message) => message.type === 'stop')).toBe(false);
  session.close();
});

it('ignores stale candidates and keeps the worker on a cooperative cancellation', async () => {
  vi.useFakeTimers();
  const workers: MockWorker[] = [];
  const posted: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type === 'session-step')
        queueMicrotask(() => {
          this.send({ type: 'candidate', attemptId: -1, snapshotId: 1 });
        });
      if (message.type === 'session-cancel')
        queueMicrotask(() => this.send({ type: 'finished', attemptId: message.attemptId }));
    }
    send(data: Record<string, unknown>) {
      this.onmessage?.({ data: { ...data, runId: 1, documentRevision: 1 } });
    }
    constructor() {
      workers.push(this);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  const session = new SheetWorkerSession(job, 1);
  const controller = new AbortController();
  const offer = vi.fn();
  const pending = session.attempt(job, controller.signal, offer);
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toBeUndefined();
  expect(offer).not.toHaveBeenCalled();
  expect(workers).toHaveLength(1);
  expect(posted.some((message) => message.type === 'stop')).toBe(false);
  session.close();
  expect(posted.at(-1)?.type).toBe('stop');
});
