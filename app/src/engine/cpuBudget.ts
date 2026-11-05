export const MAX_SOLVER_THREADS = 64;
export const MAX_SHEET_CONCURRENCY = 64;

export function cpuBudget(requestedThreads = 0) {
  const logicalThreads = Math.min(
    MAX_SOLVER_THREADS,
    Math.max(
      1,
      Math.floor(typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1),
    ),
  );
  const automaticThreads = Math.max(1, logicalThreads - 1);
  const sharedMemory =
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated &&
    typeof SharedArrayBuffer !== 'undefined';
  const effectiveThreads = sharedMemory
    ? Math.max(1, Math.min(requestedThreads || automaticThreads, logicalThreads))
    : 1;
  return {
    logicalThreads,
    automaticThreads,
    effectiveThreads,
    concurrencyCap: Math.max(1, Math.floor(automaticThreads / effectiveThreads)),
  };
}
