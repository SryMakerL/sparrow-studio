import { afterEach, beforeEach, expect, it, vi } from 'vitest';

class WorkerStub {
  static all: WorkerStub[] = [];
  messages: Record<string, unknown>[] = [];
  onmessage?: (event: { data: Record<string, unknown> }) => void;
  onerror?: (event: unknown) => void;
  constructor() { WorkerStub.all.push(this); }
  postMessage(message: Record<string, unknown>) { this.messages.push(message); }
  terminate() {}
}

const worker = { onmessage: undefined as unknown, postMessage: vi.fn(), close: vi.fn(), crossOriginIsolated: true };
const start = { type: 'start', runId: 1, documentRevision: 2 };
const send = (data: object) => (worker.onmessage as (event: { data: object }) => void)({ data });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  WorkerStub.all = [];
  worker.postMessage.mockClear();
  worker.crossOriginIsolated = true;
  vi.stubGlobal('self', worker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
  vi.stubGlobal('Worker', WorkerStub);
  await import('../src/workers/solver.worker');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each([1, 4, 8, 32])('accepts %i requested threads and initializes the selected pool', (threads) => {
  send({ ...start, threads });
  const runtime = WorkerStub.all[0];
  expect(runtime.messages[0]).toMatchObject({ ...start, threads });
  expect(worker.postMessage).not.toHaveBeenCalled();
  if (threads > 1) {
    runtime.onmessage?.({ data: { type: 'pool-init', threads, init: {}, receiver: 7 } });
    expect(WorkerStub.all).toHaveLength(threads + 1);
    for (const poolWorker of WorkerStub.all.slice(1)) poolWorker.onmessage?.({ data: { type: 'ready' } });
    expect(runtime.messages[1]).toEqual({ type: 'pool-ready' });
  }
});

it.each([0, 33, -1, 1.5, NaN, Infinity])('rejects invalid requested threads %s', (threads) => {
  send({ ...start, threads });
  expect(WorkerStub.all).toHaveLength(0);
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', runId: 1, documentRevision: 2, message: 'Choose 1–32 solver threads.' });
});

it.each([[1, 1], [8, 7], [64, 32]])('automatically chooses %i cores => %i threads', (cores, threads) => {
  vi.stubGlobal('navigator', { hardwareConcurrency: cores });
  send(start);
  expect(WorkerStub.all[0].messages[0]).toMatchObject({ threads });
});

it.each(['not isolated', 'no SharedArrayBuffer'])('falls back to one thread when %s', (reason) => {
  if (reason === 'not isolated') worker.crossOriginIsolated = false;
  else vi.stubGlobal('SharedArrayBuffer', undefined);
  send({ ...start, threads: 32 });
  const runtime = WorkerStub.all[0];
  expect(runtime.messages[0]).toMatchObject({ threads: 1, control: undefined });
  runtime.onmessage?.({ data: { type: 'ready', threads: 1 } });
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'ready', threads: 1, fallbackReason: 'Shared memory is unavailable in this browser session.' });
});
