import { describe, expect, it } from 'vitest';
import { normalizeJob } from '../src/engine/geometry/normalize';
import { solverInput } from '../src/engine/import/sparrow';
import { stitchBoards } from '../src/engine/virtualSheets';
import {
  DEFAULT_SHEET_CYCLE_BUDGET,
  newPart,
  type Job,
  type Result,
  type SheetCycleBudget,
} from '../src/engine/model';
import {
  normalizeSheetCycleBudget,
  SHEET_CYCLE_BUDGET_RANGES,
} from '../src/engine/sheetCycleBudget';
import { parseProject, serializeProject } from '../src/project/file';
import {
  addParts,
  DEFAULT_SOLVER_SETTINGS,
  jobKey,
  newProject,
  projectJob,
  startBlockers,
} from '../src/project/model';

const projectFixture = () =>
  addParts(newProject('Cycle settings'), [
    newPart([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
  ]);
const customBudget: SheetCycleBudget = {
  localMs: 401,
  globalMs: 702,
  evacuationMs: 503,
  localPercent: 91,
  globalPercent: 82,
  evacuationPercent: 73,
  maxRounds: 99,
  stallRounds: 8,
};
const fields = Object.keys(DEFAULT_SHEET_CYCLE_BUDGET) as (keyof SheetCycleBudget)[];
const withBudget = (job: Job, sheetCycleBudget: unknown): Job => ({
  ...job,
  settings: { ...job.settings, sheetCycleBudget } as Job['settings'],
});

function resultFixture(job: Job): Result {
  return {
    documentRevision: 0,
    solverRevision: 'cycle-settings-test',
    seed: '1',
    elapsedSeconds: 0,
    usedLengthMm: 10,
    placements: [{ partId: job.parts[0].id, copyIndex: 0, xMm: 0, yMm: 0, angleDeg: 0 }],
    validation: {
      status: 'passed',
      overlapAreaMm2: 0,
      maxBoundaryViolationMm: 0,
      minClearanceMm: null,
      errors: [],
    },
  };
}

describe('sheet cycle budget settings', () => {
  it('defaults new projects and missing legacy settings to longer search without round caps', () => {
    const budget: SheetCycleBudget = {
      localMs: 10000,
      globalMs: 10000,
      evacuationMs: 3000,
      localPercent: 60,
      globalPercent: 60,
      evacuationPercent: 25,
      maxRounds: 0,
      stallRounds: 0,
    };
    expect(DEFAULT_SHEET_CYCLE_BUDGET).toEqual(budget);
    const project = projectFixture();
    expect(project.settings).toMatchObject({
      timeLimitSeconds: null,
      sheetCycleBudget: budget,
    });
    expect(DEFAULT_SOLVER_SETTINGS).not.toHaveProperty('sheetCompressionSeconds');
    expect(project.settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(projectJob(project).settings).not.toHaveProperty('sheetCompressionSeconds');
    const { sheetCycleBudget: _budget, ...legacy } = project.settings;
    const parsed = parseProject({ ...project, settings: legacy });
    expect(parsed.settings).toMatchObject({
      timeLimitSeconds: null,
      sheetCycleBudget: budget,
    });
    expect(parsed.settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(normalizeJob(projectJob(parsed)).settings).toMatchObject({
      timeLimitSeconds: null,
      sheetCycleBudget: budget,
    });
    expect(normalizeJob(projectJob(parsed)).settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(legacy).not.toHaveProperty('sheetCycleBudget');
    expect(legacy).not.toHaveProperty('sheetCompressionSeconds');
  });

  it('preserves explicitly stored old defaults instead of upgrading them', () => {
    const budget: SheetCycleBudget = {
      localMs: 200,
      globalMs: 350,
      evacuationMs: 250,
      localPercent: 40,
      globalPercent: 45,
      evacuationPercent: 40,
      maxRounds: 32,
      stallRounds: 3,
    };
    const project = projectFixture();
    project.settings.sheetCompressionSeconds = 10;
    project.settings.sheetCycleBudget = { ...budget };
    const parsed = parseProject(JSON.parse(serializeProject(project)));
    expect(parsed).toEqual(project);
    expect(normalizeJob(projectJob(parsed)).settings).toMatchObject({
      timeLimitSeconds: null,
      sheetCycleBudget: budget,
    });
    expect(projectJob(parsed).settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(normalizeJob(projectJob(parsed)).settings).not.toHaveProperty('sheetCompressionSeconds');
    expect(normalizeSheetCycleBudget({ localMs: 200, globalMs: 350 })).toEqual({
      ...DEFAULT_SHEET_CYCLE_BUDGET,
      localMs: 200,
      globalMs: 350,
    });
    parsed.settings.sheetCycleBudget.globalMs = 999;
    expect(project.settings.sheetCycleBudget).toEqual(budget);
    expect(DEFAULT_SHEET_CYCLE_BUDGET.globalMs).toBe(10000);
  });

  it('serializes configured budgets into virtual board WASM inputs only', () => {
    const project = projectFixture();
    project.stock = { packing: 'sheets', strip: project.stock.strip, lengthMm: 1000, quantity: 2 };
    project.settings.sheetCycleBudget = { ...customBudget, maxRounds: 0, stallRounds: 0 };
    const job = projectJob(project);
    const stock = job.settings.sheetStocks![0];
    const virtual = stitchBoards(job, [stock, stock]);
    expect(JSON.parse(solverInput(virtual.job)).board_cycle).toEqual(
      project.settings.sheetCycleBudget,
    );
    expect(JSON.parse(solverInput(projectJob(projectFixture()))).board_cycle).toBeUndefined();
  });
  it('round-trips every budget field and passes it to jobs without changing jobKey or version', () => {
    const project = projectFixture();
    project.stock = { packing: 'sheets', strip: project.stock.strip, lengthMm: 1000, quantity: 1 };
    const key = jobKey(projectJob(project));
    project.settings.sheetCycleBudget = { ...customBudget };
    const parsed = parseProject(JSON.parse(serializeProject(project)));
    expect(parsed).toEqual(project);
    expect(parsed.version).toBe(1);
    expect(projectJob(parsed).settings.sheetCycleBudget).toEqual(customBudget);
    expect(normalizeJob(projectJob(parsed)).settings.sheetCycleBudget).toEqual(customBudget);
    expect(jobKey(projectJob(parsed))).toBe(key);
    for (const field of fields) {
      const changed = projectFixture();
      const oldKey = jobKey(projectJob(changed));
      changed.settings.sheetCycleBudget[field] = customBudget[field];
      expect(jobKey(projectJob(changed))).toBe(oldKey);
    }
    parsed.stock.strip.widthMm += 1;
    expect(jobKey(projectJob(parsed))).not.toBe(key);
  });

  it('fills legacy and partial budgets independently without mutating input objects', () => {
    const project = projectFixture();
    const { sheetCycleBudget: _missing, ...legacy } = project.settings;
    expect(parseProject({ ...project, settings: legacy }).settings.sheetCycleBudget).toEqual(
      DEFAULT_SHEET_CYCLE_BUDGET,
    );
    const job = projectJob(project);
    const { sheetCycleBudget: _jobMissing, ...jobSettings } = job.settings;
    expect(normalizeJob({ ...job, settings: jobSettings }).settings.sheetCycleBudget).toEqual(
      DEFAULT_SHEET_CYCLE_BUDGET,
    );
    for (const partial of [{}, { localMs: 999 }, { globalPercent: 100, stallRounds: 0 }]) {
      const expected = { ...DEFAULT_SHEET_CYCLE_BUDGET, ...partial };
      expect(normalizeSheetCycleBudget(partial)).toEqual(expected);
      expect(
        parseProject({ ...project, settings: { ...legacy, sheetCycleBudget: partial } }).settings
          .sheetCycleBudget,
      ).toEqual(expected);
      expect(normalizeJob(withBudget(job, partial)).settings.sheetCycleBudget).toEqual(expected);
    }
    for (const field of fields) {
      const partial = { ...customBudget };
      delete (partial as Partial<SheetCycleBudget>)[field];
      const expected = { ...customBudget, [field]: DEFAULT_SHEET_CYCLE_BUDGET[field] };
      expect(normalizeSheetCycleBudget(partial)).toEqual(expected);
      expect(
        parseProject({ ...project, settings: { ...legacy, sheetCycleBudget: partial } }).settings
          .sheetCycleBudget,
      ).toEqual(expected);
    }
    const partial = { localMs: 999 };
    normalizeSheetCycleBudget(partial);
    expect(partial).toEqual({ localMs: 999 });
  });

  it('keeps defaults and new projects isolated from mutable budget objects', () => {
    const first = newProject('First');
    const second = newProject('Second');
    first.settings.sheetCycleBudget.localMs = 777;
    expect(second.settings.sheetCycleBudget).toEqual(DEFAULT_SHEET_CYCLE_BUDGET);
    expect(DEFAULT_SOLVER_SETTINGS.sheetCycleBudget).toEqual(DEFAULT_SHEET_CYCLE_BUDGET);
    const normalized = normalizeSheetCycleBudget(undefined);
    normalized.globalMs = 999;
    expect(DEFAULT_SHEET_CYCLE_BUDGET.globalMs).toBe(10000);
    const job = projectJob(second);
    job.settings.sheetCycleBudget!.evacuationMs = 888;
    expect(second.settings.sheetCycleBudget.evacuationMs).toBe(3000);
  });

  it.each(fields)('accepts %s endpoints in files, jobs and start blockers', (field) => {
    const project = projectFixture();
    const { min, max } = SHEET_CYCLE_BUDGET_RANGES[field];
    for (const value of [min, max]) {
      const budget = { ...DEFAULT_SHEET_CYCLE_BUDGET, [field]: value };
      const changed = { ...project, settings: { ...project.settings, sheetCycleBudget: budget } };
      expect(
        parseProject(JSON.parse(serializeProject(changed))).settings.sheetCycleBudget[field],
      ).toBe(value);
      expect(
        normalizeJob(withBudget(projectJob(project), budget)).settings.sheetCycleBudget![field],
      ).toBe(value);
      expect(startBlockers(changed)).toEqual([]);
    }
  });

  it.each(fields)('rejects illegal %s values in files, jobs and start blockers', (field) => {
    const project = projectFixture();
    const job = projectJob(project);
    const { min, max } = SHEET_CYCLE_BUDGET_RANGES[field];
    for (const value of [
      min - 1,
      max + 1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      null,
      '3',
      true,
      undefined,
    ]) {
      const budget = { ...DEFAULT_SHEET_CYCLE_BUDGET, [field]: value };
      const changed = { ...project, settings: { ...project.settings, sheetCycleBudget: budget } };
      expect(() => normalizeSheetCycleBudget(budget)).toThrow(/sheet cycle budget/);
      expect(() => parseProject(changed)).toThrow(/sheet cycle budget/);
      expect(() => normalizeJob(withBudget(job, budget))).toThrow(/sheet cycle budget/);
      expect(startBlockers(changed as typeof project)).toEqual([expect.stringContaining(field)]);
    }
  });

  it('rejects null, arrays, primitives and unknown fields instead of silently defaulting them', () => {
    const project = projectFixture();
    const job = projectJob(project);
    for (const budget of [
      null,
      [],
      0,
      false,
      'budget',
      { extra: 1 },
      { ...DEFAULT_SHEET_CYCLE_BUDGET, extra: undefined },
    ]) {
      expect(() => normalizeSheetCycleBudget(budget)).toThrow(/sheet cycle budget/);
      expect(() =>
        parseProject({ ...project, settings: { ...project.settings, sheetCycleBudget: budget } }),
      ).toThrow(/sheet cycle budget/);
      expect(() => normalizeJob(withBudget(job, budget))).toThrow(/sheet cycle budget/);
      expect(
        startBlockers({
          ...project,
          settings: { ...project.settings, sheetCycleBudget: budget },
        } as typeof project),
      ).toHaveLength(1);
    }
  });

  it('preserves disabled round thresholds and independent stage percentages', () => {
    const project = projectFixture();
    project.settings.sheetCycleBudget = {
      ...DEFAULT_SHEET_CYCLE_BUDGET,
      localPercent: 100,
      globalPercent: 100,
      evacuationPercent: 100,
      maxRounds: 0,
      stallRounds: 0,
    };
    project.settings.timeLimitSeconds = 30;
    project.settings.sheetCompressionSeconds = 2;
    const parsed = parseProject(JSON.parse(serializeProject(project)));
    expect(parsed.settings.sheetCycleBudget).toEqual(project.settings.sheetCycleBudget);
    expect(startBlockers(parsed)).toEqual([]);
    expect(normalizeJob(projectJob(parsed)).settings).toMatchObject({
      sheetCycleBudget: { maxRounds: 0, stallRounds: 0 },
      timeLimitSeconds: 30,
    });
    expect(normalizeJob(projectJob(parsed)).settings).not.toHaveProperty('sheetCompressionSeconds');
  });

  it('backfills legacy saved solution jobs and partial nested sheet jobs', () => {
    const project = projectFixture();
    project.stock = { packing: 'sheets', strip: project.stock.strip, lengthMm: 1000, quantity: 1 };
    const job = projectJob(project);
    delete job.settings.sheetCycleBudget;
    const sheetJob: Job = {
      ...job,
      settings: {
        ...job.settings,
        sheetStocks: undefined,
        sheetCount: undefined,
        sheetStock: job.settings.sheetStocks![0],
      },
    };
    project.solutions = [
      {
        id: 'saved',
        createdAt: '2026-11-11T00:00:00Z',
        job,
        stopReason: 'Complete',
        result: {
          ...resultFixture(job),
          placements: [],
          unplaced: [],
          sheets: [{ job: sheetJob, result: resultFixture(sheetJob) }],
        },
      },
    ];
    const legacy = parseProject(JSON.parse(serializeProject(project)));
    expect(legacy.solutions[0].job.settings.sheetCycleBudget).toEqual(DEFAULT_SHEET_CYCLE_BUDGET);
    expect(legacy.solutions[0].result.sheets![0].job.settings.sheetCycleBudget).toEqual(
      DEFAULT_SHEET_CYCLE_BUDGET,
    );
    expect(project.solutions[0].job.settings.sheetCycleBudget).toBeUndefined();
    const partial = JSON.parse(serializeProject(project));
    partial.solutions[0].job.settings.sheetCycleBudget = { maxRounds: 0 };
    partial.solutions[0].result.sheets[0].job.settings.sheetCycleBudget = {
      localMs: 999,
      stallRounds: 0,
    };
    const parsed = parseProject(partial);
    expect(parsed.solutions[0].job.settings.sheetCycleBudget).toEqual({
      ...DEFAULT_SHEET_CYCLE_BUDGET,
      maxRounds: 0,
    });
    expect(parsed.solutions[0].result.sheets![0].job.settings.sheetCycleBudget).toEqual({
      ...DEFAULT_SHEET_CYCLE_BUDGET,
      localMs: 999,
      stallRounds: 0,
    });
    expect(parseProject(JSON.parse(serializeProject(parsed)))).toEqual(parsed);
    for (const sheetCompressionSeconds of [1, 10, 120, 0, 'invalid', null, {}]) {
      const saved = JSON.parse(serializeProject(parsed));
      saved.solutions[0].job.settings.sheetCompressionSeconds = sheetCompressionSeconds;
      saved.solutions[0].result.sheets[0].job.settings.sheetCompressionSeconds =
        sheetCompressionSeconds;
      const restored = parseProject(saved).solutions[0];
      expect(restored.job.settings).not.toHaveProperty('sheetCompressionSeconds');
      expect(restored.result.sheets![0].job.settings).not.toHaveProperty('sheetCompressionSeconds');
      expect(jobKey(restored.job)).toBe(jobKey(parsed.solutions[0].job));
      expect(jobKey(restored.result.sheets![0].job)).toBe(
        jobKey(parsed.solutions[0].result.sheets![0].job),
      );
    }
    partial.solutions[0].result.sheets[0].job.settings.sheetCycleBudget = null;
    expect(() => parseProject(partial)).toThrow();
  });
});
