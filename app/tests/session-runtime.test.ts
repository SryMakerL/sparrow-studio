import { afterEach, expect, it, vi } from 'vitest';

const { defaultInit, poolInit, step, construct } = vi.hoisted(() => ({
  defaultInit: vi.fn(),
  poolInit: vi.fn(),
  step: vi.fn(),
  construct: vi.fn(),
}));
vi.mock('../src/engine/wasm', () => ({
  supportsSIMD: true,
  loadSerialWasm: async () => ({
    default: defaultInit,
    thread_count: () => 1,
    SheetSession: class {
      constructor(...args: unknown[]) {
        construct(...args);
      }
      step = step;
      free() {}
    },
  }),
  loadThreadedWasm: async () => ({
    default: defaultInit,
    initThreadPool: poolInit,
    thread_count: () => 2,
    SheetSession: class {
      constructor(...args: unknown[]) {
        construct(...args);
      }
      step = step;
      free() {}
    },
  }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it('initializes WASM and the thread pool once for repeated session steps', async () => {
  const { DEFAULT_SETTINGS, newPart } = await import('../src/engine/model');
  const worker = { onmessage: undefined as unknown, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('../src/engine/workers/solver-runtime.worker');
  const send = (data: unknown) => (worker.onmessage as (event: unknown) => Promise<void>)({ data });
  const initializing = send({
    type: 'session-init',
    runId: 1,
    documentRevision: 1,
    threads: 2,
    document: {
      name: 'reuse',
      parts: [
        newPart([
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ]),
      ],
      settings: { ...DEFAULT_SETTINGS, materialWidthMm: 100, sheetLengthMm: 100 },
    },
  });
  await send({ type: 'pool-ready' });
  await initializing;
  await send({ type: 'pool-ready' });
  for (let id = 1; id <= 3; id++)
    await send({
      type: 'session-step',
      runId: 1,
      documentRevision: 1,
      attemptId: id,
      quantities: [1],
      seed: '1',
      mode: 'compress',
      budgetMs: 10,
    });
  expect(defaultInit).toHaveBeenCalledTimes(1);
  expect(poolInit).toHaveBeenCalledTimes(1);
  expect(construct).toHaveBeenCalledTimes(1);
  expect(step).toHaveBeenCalledTimes(3);
  expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'error')).toBe(false);
  expect(worker.postMessage).toHaveBeenCalledWith({
    type: 'session-ready',
    runId: 1,
    documentRevision: 1,
  });
});
