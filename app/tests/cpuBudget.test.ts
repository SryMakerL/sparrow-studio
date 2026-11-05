import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuBudget } from '../src/engine/cpuBudget';

afterEach(() => vi.unstubAllGlobals());

describe('CPU budget', () => {
  it.each([
    [1, 1, 7],
    [2, 2, 3],
    [4, 4, 1],
    [6, 6, 1],
    [8, 8, 1],
    [0, 7, 1],
  ])('budgets eight logical threads for request %s', (requested, effective, cap) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('SharedArrayBuffer', class {});
    expect(cpuBudget(requested)).toEqual({
      logicalThreads: 8,
      automaticThreads: 7,
      effectiveThreads: effective,
      concurrencyCap: cap,
    });
  });

  it.each([false, true])('uses one thread when shared memory is unavailable (isolated: %s)', (isolated) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    vi.stubGlobal('crossOriginIsolated', isolated);
    if (isolated) vi.stubGlobal('SharedArrayBuffer', undefined);
    expect(cpuBudget(6)).toEqual({
      logicalThreads: 8,
      automaticThreads: 7,
      effectiveThreads: 1,
      concurrencyCap: 7,
    });
  });

  it.each([0, -2, 1, 1.9])('keeps at least one thread on low-core hardware (%s)', (cores) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('SharedArrayBuffer', class {});
    expect(cpuBudget(6)).toEqual({
      logicalThreads: 1,
      automaticThreads: 1,
      effectiveThreads: 1,
      concurrencyCap: 1,
    });
  });

  it('clamps logical and requested threads to 64', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 128 });
    vi.stubGlobal('crossOriginIsolated', true);
    vi.stubGlobal('SharedArrayBuffer', class {});
    expect(cpuBudget(128)).toEqual({
      logicalThreads: 64,
      automaticThreads: 63,
      effectiveThreads: 64,
      concurrencyCap: 1,
    });
  });

  it.each([undefined, {}])('falls back to one thread in an unknown environment (%s)', (navigatorValue) => {
    vi.stubGlobal('navigator', navigatorValue);
    vi.stubGlobal('crossOriginIsolated', undefined);
    vi.stubGlobal('SharedArrayBuffer', undefined);
    expect(cpuBudget()).toEqual({
      logicalThreads: 1,
      automaticThreads: 1,
      effectiveThreads: 1,
      concurrencyCap: 1,
    });
  });
});
