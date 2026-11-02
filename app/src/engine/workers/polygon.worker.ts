import { solvePolygon } from './polygonSolver';
import type { Job, Result } from '../model';
let controller: AbortController | undefined;
self.onmessage = async ({
  data,
}: MessageEvent<{ type: string; job: Job; budgetMs: number; initialPlacement?: Result }>) => {
  if (data.type === 'stop') {
    controller?.abort();
    return;
  }
  controller?.abort();
  controller = new AbortController();
  try {
    const result = await solvePolygon(
      data.job,
      controller.signal,
      (result) => self.postMessage({ type: 'candidate', result }),
      data.budgetMs,
      data.initialPlacement,
    );
    self.postMessage({ type: 'finished', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
