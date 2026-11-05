import { describe, expect, it } from 'vitest';
import { normalizeJob } from '../src/engine/geometry/normalize';
import { newPart, type Part } from '../src/engine/model';
import { parseProject, projectFileName, serializeProject } from '../src/project/file';
import { arrangeParts } from '../src/project/layout';
import {
  addParts,
  nameImportedParts,
  commonRotations,
  differsFromDefaults,
  jobKey,
  newMachine,
  newProject,
  projectJob,
  resolvedParts,
  setDefaultRotations,
  setPartRotations,
  startBlockers,
} from '../src/project/model';
import { historyReducer, initialHistory } from '../src/ui/history';
import { parseAngles, rotationKind, rotationRule } from '../src/ui/rotations';

const square = (size: number, quantity = 1): Part => ({
  ...newPart([
    [0, 0],
    [size, 0],
    [size, size],
    [0, size],
  ]),
  quantity,
});

describe('project document', () => {
  it('accepts large part and stock quantities but rejects invalid integers', () => {
    for (const parts of [[square(10, 501)], [square(10, 25001)], Array.from({ length: 501 }, () => square(1))]) {
      const project = addParts(newProject('Large job'), parts);
      expect(startBlockers(project)).toEqual([]);
      expect(parseProject(JSON.parse(serializeProject(project))).parts).toHaveLength(parts.length);
      expect(normalizeJob(projectJob(project)).parts).toHaveLength(parts.length);
    }
    const project = addParts(newProject('Large inventory'), [square(10)]);
    const sheetProject = { ...project, stock: { packing: 'sheets' as const, strip: project.stock.strip, lengthMm: 1000, quantity: 501 } };
    expect(startBlockers(sheetProject)).toEqual([]);
    expect(parseProject(JSON.parse(serializeProject(sheetProject))).stock).toMatchObject({ quantity: 501 });
    for (const quantity of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { ...project, parts: [{ ...project.parts[0], quantity }] };
      expect(startBlockers(invalid).length).toBeGreaterThan(0);
      expect(() => parseProject(invalid)).toThrow();
    }
  });

  it('numbers imported part types across batches without changing existing parts or sources', () => {
    const first = nameImportedParts([], [square(10, 40), square(20)]);
    expect(first.map((part) => part.name)).toEqual(['001', '002']);
    const next = nameImportedParts(
      [...first, { name: '010' }, { name: 'Bracket' }],
      [square(30), square(40)],
    );
    expect(next.map((part) => part.name)).toEqual(['011', '012']);
    expect(next[0].quantity).toBe(1);
    expect(first[0].quantity).toBe(40);
    expect(first[0].source).toEqual(square(10).source);
    expect(nameImportedParts([{ name: '999' }], [square(1)])[0].name).toBe('1000');
    expect(first.map((part) => part.name)).toEqual(['001', '002']);
  });

  it('round-trips through a project file', () => {
    const project = addParts(newProject('Shop job'), [square(10, 3)]);
    expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it('defaults missing sheet controls independently and ignores the legacy timeout', () => {
    const project = addParts(newProject('Job'), [square(10)]);
    const { sheetCompressionSeconds: _, sheetInsertionFailures: __, ...legacy } = project.settings;
    for (const sheetStagnationSeconds of [undefined, 15, 45, -1]) {
      const parsed = parseProject({
        ...project,
        settings: { ...legacy, sheetStagnationSeconds },
      });
      expect(parsed.settings.sheetCompressionSeconds).toBe(10);
      expect(parsed.settings.sheetInsertionFailures).toBe(3);
    }
    expect(
      parseProject({ ...project, settings: { ...legacy, sheetCompressionSeconds: 20 } }).settings
        .sheetInsertionFailures,
    ).toBe(3);
    expect(
      parseProject({ ...project, settings: { ...legacy, sheetInsertionFailures: 8 } }).settings
        .sheetCompressionSeconds,
    ).toBe(10);
    const job = projectJob(project);
    const {
      sheetCompressionSeconds: _seconds,
      sheetInsertionFailures: _failures,
      ...settings
    } = job.settings;
    const normalized = normalizeJob({
      ...job,
      settings: { ...settings, sheetStagnationSeconds: 15 },
    } as typeof job);
    expect(normalized.settings.sheetCompressionSeconds).toBe(10);
    expect(normalized.settings.sheetInsertionFailures).toBe(3);
  });

  it.each([
    ['sheetCompressionSeconds', 1, 600],
    ['sheetInsertionFailures', 1, 100],
  ] as const)('validates %s in files, solver jobs and start blockers', (field, min, max) => {
    const project = addParts(newProject('Job'), [square(10)]);
    for (const value of [min, max]) {
      const changed = { ...project, settings: { ...project.settings, [field]: value } };
      const parsed = parseProject(JSON.parse(serializeProject(changed)));
      expect(parsed.settings[field]).toBe(value);
      expect(projectJob(parsed).settings[field]).toBe(value);
      expect(normalizeJob(projectJob(parsed)).settings[field]).toBe(value);
      expect(startBlockers(changed)).toEqual([]);
    }
    for (const value of [0, max + 1, 1.5, NaN, Infinity, null, '3']) {
      const changed = { ...project, settings: { ...project.settings, [field]: value } };
      expect(() => parseProject(changed)).toThrow(/invalid sheet/);
      const typed = changed as typeof project;
      expect(() => normalizeJob(projectJob(typed))).toThrow(/Sheet/);
      expect(startBlockers(typed)).toHaveLength(1);
    }
  });

  it('round-trips non-default sheet controls and passes both to the solver', () => {
    const project = addParts(newProject('Job'), [square(10)]);
    project.settings.sheetCompressionSeconds = 24;
    project.settings.sheetInsertionFailures = 7;
    const parsed = parseProject(JSON.parse(serializeProject(project)));
    expect(parsed).toEqual(project);
    expect(projectJob(parsed).settings).toMatchObject({
      sheetCompressionSeconds: 24,
      sheetInsertionFailures: 7,
    });
  });

  it('rejects other formats and versions', () => {
    const project = newProject('Shop job');
    expect(() => parseProject({ ...project, format: 'other' })).toThrow('unknown format');
    expect(() => parseProject({ ...project, version: 2 })).toThrow('version 2');
  });

  it('builds the solver job from the strip, the active machine and the settings', () => {
    const machine = newMachine('Laser', 0.5);
    const project = addParts(newProject('Job', machine), [square(10)]);
    const job = projectJob(project);
    expect(job.settings.materialWidthMm).toBe(1000);
    expect(job.settings.clearanceMm).toBe(0.5);
    expect(project.machines[0].id).not.toBe(machine.id);
  });

  it('treats renamed projects and parts as the same job, and a quantity change as a new one', () => {
    const project = addParts(newProject('Job'), [square(10)]);
    const key = jobKey(projectJob(project));
    expect(jobKey(projectJob({ ...project, name: 'Renamed' }))).toBe(key);
    const renamedPart = { ...project, parts: [{ ...project.parts[0], name: 'Bracket' }] };
    expect(jobKey(projectJob(renamedPart))).toBe(key);
    expect(
      jobKey(projectJob({ ...project, parts: [{ ...project.parts[0], quantity: 2 }] })),
    ).not.toBe(key);
  });

  it('explains why a job cannot start', () => {
    const empty = newProject('Job');
    expect(startBlockers(empty)).toEqual(['Import parts to nest.']);
    const zero = { ...empty, parts: [square(10, 0)] };
    expect(startBlockers(zero)[0]).toMatch('quantity above zero');
    const wide = {
      ...empty,
      parts: [square(10)],
      machines: [{ ...empty.machines[0], gapMm: 2000 }],
    };
    expect(startBlockers(wide)).toEqual(['The gap must be smaller than the strip width.']);
    expect(startBlockers({ ...empty, parts: [square(10)] })).toEqual([]);
  });

  it('makes safe file names', () => {
    expect(projectFileName('a/b: c.', 'svg')).toBe('a-b- c.svg');
    expect(projectFileName('   ', 'svg')).toBe('project.svg');
  });
});

describe('parts canvas arrangement', () => {
  it('places every part type once, without overlaps', () => {
    const parts = [square(30), square(10), square(20), square(5), square(25)];
    const { boxes, extent } = arrangeParts(parts);
    expect(boxes.size).toBe(parts.length);
    const all = [...boxes.values()];
    for (let i = 0; i < all.length; i++)
      for (let j = 0; j < i; j++) {
        const [a, b] = [all[i], all[j]];
        const apart = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
        expect(apart).toBe(true);
      }
    for (const box of all) {
      expect(box[0]).toBeGreaterThanOrEqual(extent[0]);
      expect(box[1]).toBeGreaterThanOrEqual(extent[1]);
      expect(box[2]).toBeLessThanOrEqual(extent[2]);
      expect(box[3]).toBeLessThanOrEqual(extent[3]);
    }
  });
});

describe('rotations', () => {
  it('names the common rules and parses custom angles', () => {
    expect(rotationKind(rotationRule('half'))).toBe('half');
    expect(rotationKind({ kind: 'discrete', degrees: [270, 0, 90, 180, 360] })).toBe('quarter');
    expect(rotationKind({ kind: 'discrete', degrees: [0, 45] })).toBe('custom');
    expect(parseAngles('0, 45 , 405')).toEqual({ kind: 'discrete', degrees: [0, 45] });
    expect(parseAngles('a')).toBeUndefined();
  });
});

describe('undo history', () => {
  it('coalesces edits with the same key and keeps solutions through undo', () => {
    const start = newProject('Job');
    let state = initialHistory(start);
    const named = (name: string) => ({ ...state.present, name });
    state = historyReducer(state, { type: 'edit', project: named('A'), key: 'name', at: 1000 });
    state = historyReducer(state, { type: 'edit', project: named('AB'), key: 'name', at: 1500 });
    expect(state.past).toHaveLength(1);
    const solution = {
      id: 's',
      createdAt: '',
      job: projectJob(start),
      result: {} as never,
      stopReason: 'Complete' as const,
    };
    state = historyReducer(state, { type: 'solutions', solutions: [solution] });
    state = historyReducer(state, { type: 'undo' });
    expect(state.present.name).toBe('Job');
    expect(state.present.solutions).toEqual([solution]);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.name).toBe('AB');
  });
});

describe('part defaults', () => {
  const half = { kind: 'discrete' as const, degrees: [0, 180] };
  const free = { kind: 'continuous' as const };
  const rules = (project: ReturnType<typeof newProject>) =>
    resolvedParts(project).map((part) => part.rotations);

  it('stores a rule only on parts that have their own', () => {
    let project = addParts(newProject('Job'), [square(10), { ...square(20), rotations: free }]);
    expect(project.parts.map(differsFromDefaults)).toEqual([false, true]);
    expect(project.parts[0].rotations).toBeUndefined();
    project = setDefaultRotations(project, { kind: 'discrete', degrees: [0] });
    expect(rules(project)).toEqual([{ kind: 'discrete', degrees: [0] }, free]);
    expect(projectJob(project).parts.map((part) => part.rotations)).toEqual(rules(project));
  });

  it('can give a part its own rule and take it back', () => {
    let project = addParts(newProject('Job'), [square(10)]);
    const id = project.parts[0].id;
    project = setPartRotations(project, [id], free);
    expect(differsFromDefaults(project.parts[0])).toBe(true);
    project = setPartRotations(project, [id], 'default');
    expect(differsFromDefaults(project.parts[0])).toBe(false);
    expect(rules(project)).toEqual([half]);
  });

  it('round-trips parts that follow the defaults through a project file', () => {
    const project = addParts(newProject('Job'), [square(10), { ...square(20), rotations: free }]);
    expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it('takes the most common rule as the defaults of a set of parts', () => {
    const parts = [square(1), { ...square(2), rotations: free }, { ...square(3), rotations: free }];
    expect(commonRotations(parts, half)).toEqual(free);
  });
});
