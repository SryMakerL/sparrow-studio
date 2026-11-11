import { afterEach, expect, it, vi } from 'vitest';
import { SheetWorkerSession } from '../src/engine/workers/sheetSession';
import { DEFAULT_SETTINGS, newPart, type Job } from '../src/engine/model';

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

<<<<<<< HEAD
it('returns and retains the last equal-width rearrangement for the next warm insertion', async () => {
=======
it('keeps the last equal-width compression candidate as the next warm-start snapshot', async () => {
>>>>>>> dev
  const steps: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type !== 'session-step') return;
      steps.push(message);
      queueMicrotask(() => {
        for (const [snapshotId, y] of steps.length === 2
          ? [
<<<<<<< HEAD
              [20, 0],
              [21, 20],
=======
              [20, 1],
              [21, 5],
>>>>>>> dev
            ]
          : [[10, 0]]) {
          this.send({
            type: 'candidate',
            attemptId: message.attemptId,
            snapshotId,
            solution: {
              strip_width: 10,
              layout: {
                placed_items: [
                  { item_id: 0, transformation: { rotation: 0, translation: [0, y] } },
                ],
              },
            },
          });
        }
        this.send({ type: 'finished', attemptId: message.attemptId });
      });
    }
    send(data: Record<string, unknown>) {
      this.onmessage?.({ data: { ...data, runId: 1, documentRevision: 7 } });
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  const session = new SheetWorkerSession(job, 7);
  const initial = (await session.attempt(job))!;
  session.accept(initial);
<<<<<<< HEAD
  const rearranged = (await session.attempt(job, undefined, undefined, 1000, initial))!;
  expect(rearranged.placements[0].yMm).toBe(20);
  session.accept(rearranged);
  const insertionJob = { ...job, parts: job.parts.map((part) => ({ ...part, quantity: 2 })) };
  await session.attempt(insertionJob, undefined, undefined, 1000, rearranged);
=======
  const latest = (await session.attempt(job, undefined, undefined, 1000, initial))!;
  expect(latest.placements[0].yMm).toBe(5);
  session.accept(latest);
  const child = { ...job, parts: job.parts.map((part) => ({ ...part, quantity: 2 })) };
  await session.attempt(child, undefined, undefined, 1000, latest);
>>>>>>> dev
  expect(steps[2]).toMatchObject({ initialSnapshot: 21, retainSnapshot: 21, mode: 'search' });
  session.close();
});

it('does not dispatch a cold step when a warm-start snapshot is unavailable', async () => {
  const steps: Record<string, unknown>[] = [];
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(message: Record<string, unknown>) {
      if (message.type === 'session-init')
        queueMicrotask(() => this.send({ type: 'session-ready' }));
      if (message.type !== 'session-step') return;
      steps.push(message);
      queueMicrotask(() => {
        this.send({
          type: 'candidate',
          attemptId: message.attemptId,
          snapshotId: 10,
          solution: {
            strip_width: 10,
            layout: {
              placed_items: [{ item_id: 0, transformation: { rotation: 0, translation: [0, 0] } }],
            },
          },
        });
        this.send({ type: 'finished', attemptId: message.attemptId });
      });
    }
    send(data: Record<string, unknown>) {
      this.onmessage?.({ data: { ...data, runId: 1, documentRevision: 7 } });
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  const job = catalog();
  job.parts.unshift({ ...job.parts[0], id: 'unused-priority-part', quantity: 0 });
  const session = new SheetWorkerSession(job, 7);
  const initial = (await session.attempt(job))!;
  initial.placements = initial.placements.map((placement) => ({
    ...placement,
    partId: job.parts[1].id,
    xMm: 0.125,
    yMm: 0.25,
  }));
  session.close();
  const child = {
    ...job,
    parts: job.parts.map((part, index) => ({ ...part, quantity: index === 1 ? 2 : 0 })),
  };
  await expect(session.attempt(child, undefined, undefined, 1000, initial)).resolves.toBeDefined();
  expect(steps).toHaveLength(2);
  expect(steps[1]).toMatchObject({
    initialSnapshot: undefined,
    retainSnapshot: undefined,
    mode: 'search',
    initialPlacement: {
      used_length_mm: initial.usedLengthMm,
      placements: [{ item_id: 1, rotation: 0, translation: [0.125, 0.25] }],
    },
  });
  await expect(session.attempt(job)).resolves.toBeDefined();
  expect(steps).toHaveLength(3);
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
  const second = session.attempt(job, undefined, undefined, 100);
  await vi.advanceTimersByTimeAsync(1);
  expect(workers).toHaveLength(2);
  const steps = posted.filter((message) => message.type === 'session-step');
  expect(steps[1]).toMatchObject({ initialSnapshot: undefined, retainSnapshot: undefined });
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
