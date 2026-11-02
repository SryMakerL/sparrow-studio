import type { GeometryReply, GeometryRequest } from './protocol';

export function geometryTask(
  request: GeometryRequest,
  signal?: AbortSignal,
): Promise<GeometryReply> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Geometry work aborted.', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const abort = () => done(undefined, new DOMException('Geometry work aborted.', 'AbortError'));
    const timeout = setTimeout(
      () =>
        done(
          undefined,
          Error(
            'Geometry work exceeded 30 seconds. Use fewer vertices or a coarser approximation.',
          ),
        ),
      30_000,
    );
    function done(reply?: GeometryReply, error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(reply!);
    }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<GeometryReply>) => {
      if (data.runId !== request.runId || data.documentRevision !== request.documentRevision)
        return;
      done(data, data.type === 'error' ? Error(data.message) : undefined);
    };
    worker.onerror = (e) => done(undefined, Error(e.message));
    worker.postMessage(request);
  });
}
