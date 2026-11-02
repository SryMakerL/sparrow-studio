import { afterEach, expect, it, vi } from 'vitest';

const { initialize, start } = vi.hoisted(() => ({ initialize: vi.fn(), start: vi.fn() }));
vi.mock('../src/engine/wasm', () => ({
  loadThreadedWasm: async () => ({ default: initialize, wbg_rayon_start_worker: start }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

it('allocates an explicit 8 MiB stack before starting each Rayon worker', async () => {
  const worker = { onmessage: undefined as unknown, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('../src/engine/workers/rayon.worker');
  const init = { module_or_path: {}, memory: {} };
  await (worker.onmessage as (event: unknown) => Promise<void>)({ data: { init, receiver: 7 } });
  expect(initialize).toHaveBeenCalledWith({ ...init, thread_stack_size: 8 * 1024 * 1024 });
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'ready' });
  expect(start).toHaveBeenCalledWith(7);
});

it('preserves worker exception stacks for diagnosing WASM failures', async () => {
  const error = new Error('memory access out of bounds');
  initialize.mockRejectedValueOnce(error);
  const worker = { onmessage: undefined as unknown, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('../src/engine/workers/rayon.worker');
  await (worker.onmessage as (event: unknown) => Promise<void>)({
    data: { init: {}, receiver: 7 },
  });
  expect(worker.postMessage).toHaveBeenCalledWith({ type: 'error', message: error.stack });
  expect(start).not.toHaveBeenCalled();
});
