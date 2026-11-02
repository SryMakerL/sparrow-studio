import { describe, expect, it } from 'vitest';
import { scheduleBoardCandidates, type BoardCandidateTask } from '../src/engine/boardScheduler';
import type { Job, Result, SheetStock } from '../src/engine/model';

const stock = (id: string, priority: number): SheetStock => ({
  id,
  name: id,
  kind: 'rectangle',
  widthMm: 100,
  lengthMm: 100,
  quantity: 1,
  priority,
});

const job: Job = {
  name: 'scheduler',
  parts: [
    {
      id: 'part',
      name: 'part',
      source: { format: 'svg' },
      outer: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      holes: [],
      approximationToleranceMm: 0,
      quantity: 2,
      rotations: { kind: 'discrete', degrees: [0] },
    },
  ],
  settings: {
    solverPreset: 'fast',
    materialWidthMm: 100,
    clearanceMm: 0,
    timeLimitSeconds: 10,
  },
};

const candidate = (task: BoardCandidateTask, quantity: number) => ({
  job: { ...job, parts: [{ ...job.parts[0], quantity }] },
  result: {
    documentRevision: 0,
    solverRevision: 'test',
    seed: String(task.taskId),
    elapsedSeconds: 0,
    usedLengthMm: quantity,
    placements: [],
    validation: {
      status: 'passed' as const,
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  } satisfies Result,
});

describe('board candidate scheduler', () => {
  it('commits one non-conflicting winner from each parallel batch', async () => {
    let running = 0;
    let maximumRunning = 0;
    const committed: string[] = [];
    const result = await scheduleBoardCandidates({
      concurrency: 2,
      stocks: [stock('low', 0), stock('high', 10), stock('last', 0)],
      parts: job.parts,
      generate: async (task) => {
        running++;
        maximumRunning = Math.max(maximumRunning, running);
        await new Promise((resolve) => setTimeout(resolve, task.taskId === 0 ? 5 : 0));
        running--;
        return candidate(task, task.taskId === 1 ? 2 : 1);
      },
      onCommit: (entry) => committed.push(entry.stock.id),
    });

    expect(maximumRunning).toBe(2);
    expect(committed).toEqual(['high']);
    expect(result.remaining.get('part')).toBe(0);
    expect(result.sheets).toHaveLength(1);
  });

  it('rejects stale candidates that over-consume the remaining pool', async () => {
    const result = await scheduleBoardCandidates({
      concurrency: 2,
      stocks: [stock('a', 0), stock('b', 0)],
      parts: [{ ...job.parts[0], quantity: 1 }],
      generate: async (task) => candidate(task, 1),
    });

    expect(result.sheets).toHaveLength(1);
    expect(result.remaining.get('part')).toBe(0);
  });
});
