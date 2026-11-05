import { cpuBudget, MAX_SOLVER_THREADS } from '../cpuBudget';
import type { Start, SessionInit, SessionStep, SessionCancel, SolverMessage } from './protocol';

type PoolInit = {
  type: 'pool-init';
  threads: number;
  init: { module_or_path: WebAssembly.Module; memory: WebAssembly.Memory };
  receiver: number;
};
let dispose = () => {};
let skip = () => {};
let step: (request: SessionStep) => void = () => {};
let cancel: (request: SessionCancel) => void = () => {};

// Keep this coordinator idle: it owns every runtime and pool worker, and can
// terminate them even while the solver is blocked in synchronous WASM.
self.onmessage = ({
  data,
}: MessageEvent<
  Start | SessionInit | SessionStep | SessionCancel | { type: 'stop' } | { type: 'skip' }
>) => {
  if (data.type === 'stop') {
    dispose();
    self.close();
    return;
  }
  if (data.type === 'skip') {
    skip();
    return;
  }
  if (data.type === 'session-step') {
    step(data);
    return;
  }
  if (data.type === 'session-cancel') {
    cancel(data);
    return;
  }
  const requested = data.threads ?? 0;
  const threads = cpuBudget(requested).effectiveThreads;
  if (!Number.isInteger(requested) || requested < 0 || requested > MAX_SOLVER_THREADS) {
    self.postMessage({
      type: 'error',
      runId: data.runId,
      documentRevision: data.documentRevision,
      message: `Choose 0–${MAX_SOLVER_THREADS} solver threads (0 is automatic).`,
    });
    return;
  }
  const start = data;
  let phase = '';
  const isSession = start.type === 'session-init';
  const control =
    self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
      ? new Int32Array(isSession && start.control ? start.control : new SharedArrayBuffer(4))
      : undefined;
  function launch(count: number, fallbackReason?: string) {
    const runtime = new Worker(new URL('./solver-runtime.worker.ts', import.meta.url), {
      type: 'module',
    });
    const pool: Worker[] = [];
    let ready = false,
      closed = false;
    let activeAttempt: number | undefined;
    step = (request) => {
      if (!isSession || closed) return;
      if (!ready) {
        self.postMessage({
          type: 'attempt-error',
          runId: request.runId,
          documentRevision: request.documentRevision,
          attemptId: request.attemptId,
          message: 'Sheet session is not initialized.',
        });
        return;
      }
      activeAttempt = request.attemptId;
      if (control) Atomics.store(control, 0, 0);
      runtime.postMessage(request);
    };
    cancel = (request) => {
      if (!isSession || closed || activeAttempt !== request.attemptId) return;
      // The runtime cannot receive messages while its synchronous WASM step runs.
      if (control) Atomics.store(control, 0, 1);
      runtime.postMessage(request);
    };
    skip = () => {
      if (!isSession && !closed && phase === 'Exploration' && control)
        Atomics.compareExchange(control, 0, 0, 1);
    };
    dispose = () => {
      closed = true;
      clearTimeout(timer);
      runtime.terminate();
      pool.forEach((worker) => worker.terminate());
    };
    const fail = (message: string) => {
      if (closed) return;
      dispose();
      if (!ready && count > 1) launch(1, message);
      else
        self.postMessage({
          type: 'error',
          runId: start.runId,
          documentRevision: start.documentRevision,
          message,
        });
    };
    const timer = setTimeout(
      () => fail('Thread initialization timed out.'),
      count > 1 ? 8000 : 6000,
    );
    runtime.onmessage = ({ data: message }: MessageEvent<SolverMessage | PoolInit>) => {
      if (closed) return;
      if (message.type === 'pool-init') {
        if (pool.length || message.threads !== count) {
          fail('Invalid thread pool initialization.');
          return;
        }
        let initialized = 0;
        try {
          for (let i = 0; i < count; i++) {
            const worker = new Worker(new URL('./rayon.worker.ts', import.meta.url), {
              type: 'module',
            });
            pool.push(worker);
            worker.onmessage = ({ data }) => {
              if (closed) return;
              if (data.type === 'solver-log')
                self.postMessage({
                  ...data,
                  runId: start.runId,
                  documentRevision: start.documentRevision,
                  ...(isSession && activeAttempt !== undefined ? { attemptId: activeAttempt } : {}),
                });
              else if (data.type === 'error') fail(data.message);
              else if (data.type === 'ready' && ++initialized === count)
                runtime.postMessage({ type: 'pool-ready' });
            };
            worker.onerror = (event) => {
              event.preventDefault();
              fail(event.message || 'A solver thread failed.');
            };
            worker.postMessage(message);
          }
        } catch (error) {
          fail(String(error));
        }
        return;
      }
      if (message.type === 'solver-log') {
        self.postMessage({
          ...message,
          runId: start.runId,
          documentRevision: start.documentRevision,
        });
        return;
      }
      if (message.type === 'error') {
        fail(message.message);
        return;
      }
      if ((message.type === 'ready' && !isSession) || message.type === 'session-ready') {
        ready = true;
        clearTimeout(timer);
      }
      if (message.type === 'finished' || message.type === 'attempt-error')
        activeAttempt = undefined;
      if (message.type === 'phase') phase = message.phase;
      self.postMessage(message.type === 'ready' ? { ...message, fallbackReason } : message);
    };
    runtime.onerror = (event) => {
      event.preventDefault();
      fail(event.message || 'The solver runtime failed.');
    };
    runtime.postMessage({ ...start, threads: count, control: control?.buffer });
  }
  dispose();
  launch(
    threads,
    threads < requested
      ? 'Thread count reduced to this browser’s CPU and shared-memory capabilities.'
      : undefined,
  );
};
