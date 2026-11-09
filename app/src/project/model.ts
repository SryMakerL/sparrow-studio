import { normalizeSheetStocks, stockArea, stockGeometryKey, usedStockArea } from '../engine/stock';
import type { SheetStock } from '../engine/model';
import {
  MAX_SOLVER_THREADS,
  LIMITS,
  newId,
  type Job,
  type Part,
  type Preset,
  type Result,
  type RotationRule,
  type TimeLimit,
} from '../engine/model';

/** Identifies a sparrow studio project document, in browser storage and in files. */
export const PROJECT_FORMAT = 'sparrow-studio-project';
export const PROJECT_VERSION = 1;

/** One strip of fixed width; the solver minimizes the length it uses. */
export type Strip = { id: string; name: string; widthMm: number };
/** Stock keeps the strip dimensions shared by strip and fixed rectangular sheet jobs. */
export type Stock =
  | { packing: 'strip'; strip: Strip }
  | { packing: 'sheets'; strip: Strip; lengthMm: number; quantity: number; sheets?: SheetStock[] };

export function stockSheets(stock: Stock): SheetStock[] {
  if (stock.packing !== 'sheets') return [];
  return (
    stock.sheets ?? [
      {
        id: stock.strip.id,
        name: stock.strip.name,
        kind: 'rectangle',
        widthMm: stock.strip.widthMm,
        lengthMm: stock.lengthMm,
        quantity: stock.quantity,
        priority: 0,
      },
    ]
  );
}
export function setStockSheets(stock: Stock, sheets: SheetStock[]): Stock {
  const checked = normalizeSheetStocks(sheets, true),
    first = checked[0];
  return {
    packing: 'sheets',
    strip: first ? { id: first.id, name: first.name, widthMm: first.widthMm } : stock.strip,
    lengthMm: first?.lengthMm ?? (stock.packing === 'sheets' ? stock.lengthMm : 1000),
    quantity: checked.reduce((n, s) => n + s.quantity, 0),
    sheets: checked,
  };
}
/** Machine-specific solver inputs. Clamps and a separate sheet boundary distance come later. */
export type MachinePreset = { id: string; name: string; gapMm: number };
/** Local solving only, for now. */
export type SolveWith = 'local';
/** 0 lets the solver choose. */
export type Threads =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16
  | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24
  | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32;
export type SolverSettings = {
  solveWith: SolveWith;
  timeLimitSeconds: TimeLimit;
  sheetCompressionSeconds: number;
  sheetInsertionWarmStartSeconds: number;
  sheetInsertionFailures: number;
  preset: Preset;
  threads: Threads;
};
/** A solver result with the exact job it solved, so it stays valid when inputs change later. */
export type Solution = {
  id: string;
  createdAt: string;
  job: Job;
  result: Result;
  stopReason: 'Complete' | 'Stopped';
};
/** Settings every part follows unless it has its own. Reflection and nesting in holes join later. */
export type PartDefaults = { rotations: RotationRule };
/** A part as the project stores it: a setting is present only when the part has its own. */
export type ProjectPart = Omit<Part, 'rotations'> & { rotations?: RotationRule };
export type ProjectDocument = {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  name: string;
  parts: ProjectPart[];
  partDefaults: PartDefaults;
  stock: Stock;
  machines: MachinePreset[];
  machineId: string;
  settings: SolverSettings;
  /** Holds the latest saved solution. */
  solutions: Solution[];
};

export const TIME_LIMITS: TimeLimit[] = [null, 10, 30, 60, 120, 300, 600];

export const DEFAULT_SOLVER_SETTINGS: SolverSettings = {
  solveWith: 'local',
  timeLimitSeconds: null,
  sheetCompressionSeconds: 10,
  sheetInsertionWarmStartSeconds: 10,
  sheetInsertionFailures: 3,
  preset: 'standard',
  threads: 0,
};

export function newMachine(name = 'Default', gapMm = 0): MachinePreset {
  return { id: newId(), name, gapMm };
}

export function newProject(name: string, machine: MachinePreset = newMachine()): ProjectDocument {
  const copy = { ...machine, id: newId() };
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name,
    parts: [],
    partDefaults: { rotations: { kind: 'discrete', degrees: [0, 180] } },
    stock: { packing: 'strip', strip: { id: newId(), name: 'Material strip', widthMm: 1000 } },
    machines: [copy],
    machineId: copy.id,
    settings: { ...DEFAULT_SOLVER_SETTINGS },
    solutions: [],
  };
}

export function activeMachine(project: ProjectDocument): MachinePreset {
  return (
    project.machines.find((machine) => machine.id === project.machineId) ?? project.machines[0]
  );
}

/** The solver input for the current project, without validating its geometry. */
export function projectJob(project: ProjectDocument): Job {
  return {
    name: project.name,
    parts: resolvedParts(project),
    settings: {
      solverPreset: project.settings.preset,
      materialWidthMm: project.stock.strip.widthMm,
      clearanceMm: activeMachine(project).gapMm,
      timeLimitSeconds: project.settings.timeLimitSeconds,
      sheetCompressionSeconds: project.settings.sheetCompressionSeconds,
      sheetInsertionWarmStartSeconds: project.settings.sheetInsertionWarmStartSeconds,
      sheetInsertionFailures: project.settings.sheetInsertionFailures,
      ...(project.stock.packing === 'sheets'
        ? {
            sheetLengthMm: project.stock.lengthMm,
            sheetCount: stockSheets(project.stock).reduce((n, s) => n + s.quantity, 0),
            sheetStocks: stockSheets(project.stock),
          }
        : {}),
    },
  };
}

/** Compares jobs by the inputs that change a layout; names and file sources do not. */
export function jobKey(job: Job): string {
  return JSON.stringify({
    parts: job.parts
      .filter((part) => part.quantity > 0)
      .map(({ id, outer, holes, quantity, priority, rotations }) => [
        id,
        outer,
        holes,
        quantity,
        priority ?? 0,
        ruleKey(rotations),
      ]),
    width: job.settings.materialWidthMm,
    gap: job.settings.clearanceMm,
    sheetLengthMm: job.settings.sheetLengthMm,
    sheetCount: job.settings.sheetCount,
    sheetStocks: job.settings.sheetStocks?.map(stockGeometryKey),
    sheetStock: job.settings.sheetStock && stockGeometryKey(job.settings.sheetStock),
  });
}

export const copyCount = (parts: { quantity: number }[]) =>
  parts.reduce((sum, part) => sum + part.quantity, 0);

/** Why a job cannot start yet. An empty list means it can. Which conditions belong here is still open. */
export function startBlockers(project: ProjectDocument): string[] {
  const reasons: string[] = [];
  const width = project.stock.strip.widthMm;
  const gap = activeMachine(project).gapMm;
  const copies = copyCount(project.parts);
  if (!project.parts.length) reasons.push('Import parts to nest.');
  else if (copies === 0) reasons.push('Give at least one part a quantity above zero.');
  if (project.parts.some(part => !Number.isSafeInteger(part.quantity) || part.quantity < 0))
    reasons.push('Set nonnegative safe-integer part quantities.');
  if (!Number.isFinite(width) || width <= 0 || width > LIMITS.extent)
    reasons.push('Set a strip width in the Sheets tab.');
  if (!Number.isFinite(gap) || gap < 0) reasons.push('Set a valid gap in the Machine tab.');
  else if (project.stock.packing === 'strip' && Number.isFinite(width) && gap >= width)
    reasons.push('The gap must be smaller than the strip width.');
  if (
    !Number.isInteger(project.settings.sheetCompressionSeconds) ||
    project.settings.sheetCompressionSeconds < 1 ||
    project.settings.sheetCompressionSeconds > 600
  )
    reasons.push('Set a sheet compression duration from 1 to 600 seconds in Settings.');
  if (
    !Number.isInteger(project.settings.sheetInsertionWarmStartSeconds) ||
    project.settings.sheetInsertionWarmStartSeconds < 1 ||
    project.settings.sheetInsertionWarmStartSeconds > 600
  )
    reasons.push('Set a sheet insertion warm-start duration from 1 to 600 seconds in Settings.');
  if (
    !Number.isInteger(project.settings.sheetInsertionFailures) ||
    project.settings.sheetInsertionFailures < 1 ||
    project.settings.sheetInsertionFailures > 100
  )
    reasons.push('Set consecutive sheet insertion failures from 1 to 100 in Settings.');
  if (
    !Number.isInteger(project.settings.threads) ||
    project.settings.threads < 0 ||
    project.settings.threads > MAX_SOLVER_THREADS
  )
    reasons.push(`Choose Automatic or 1–${MAX_SOLVER_THREADS} solver threads in Settings.`);
  if (project.stock.packing === 'sheets') {
    if (project.stock.sheets !== undefined)
      try {
        normalizeSheetStocks(stockSheets(project.stock));
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    if (
      !Number.isFinite(project.stock.lengthMm) ||
      project.stock.lengthMm <= 0 ||
      project.stock.lengthMm > LIMITS.extent
    )
      reasons.push('Set a valid sheet length in the Sheets tab.');
    if (
      !Number.isSafeInteger(project.stock.quantity) ||
      project.stock.quantity < 1
    )
      reasons.push('Set a positive safe-integer sheet quantity.');
  }
  return reasons;
}

/** Net part area over actual sheet capacity, or the used rectangle for an open strip. */
export function utilization(job: Job, result: Result, netArea: (part: Part) => number): number {
  if (result.sheets) {
    const area = result.sheets.reduce(
      (sum, sheet) =>
        sum + sheet.job.parts.reduce((n, part) => n + netArea(part) * part.quantity, 0),
      0,
    );
    const capacity = result.sheets.reduce(
      (sum, sheet) =>
        sum +
        (sheet.job.settings.sheetStock
          ? stockArea(sheet.job.settings.sheetStock)
          : sheet.job.settings.materialWidthMm *
            (sheet.job.settings.sheetLengthMm ?? sheet.result.usedLengthMm)),
      0,
    );
    return capacity ? (area / capacity) * 100 : 0;
  }
  const area = job.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
  const capacity = job.settings.sheetStock
    ? stockArea(job.settings.sheetStock)
    : job.settings.materialWidthMm * (job.settings.sheetLengthMm ?? result.usedLengthMm);
  return capacity ? (area / capacity) * 100 : 0;
}

/** Net part area over the material to the left of the used-length boundary. */
export function usedUtilization(job: Job, result: Result, netArea: (part: Part) => number): number {
  const area = job.parts.reduce((sum, part) => sum + netArea(part) * part.quantity, 0);
  const capacity = job.settings.sheetStock
    ? usedStockArea(job.settings.sheetStock, result.usedLengthMm)
    : job.settings.materialWidthMm * result.usedLengthMm;
  return capacity ? (area / capacity) * 100 : 0;
}

/** Compares rotation rules by the angles they allow. */
export function ruleKey(rule: RotationRule): string {
  if (rule.kind === 'continuous') return 'free';
  const turn = (degrees: number) => ((degrees % 360) + 360) % 360;
  return [...new Set(rule.degrees.map(turn))].sort((a, b) => a - b).join(',');
}

export const differsFromDefaults = (part: ProjectPart) => part.rotations !== undefined;

/** The rule a part solves with: its own, or the defaults. */
export const effectiveRotations = (project: ProjectDocument, part: ProjectPart): RotationRule =>
  part.rotations ?? project.partDefaults.rotations;

/** The parts with every setting filled in, as the solver and the drawings use them. */
export const resolvedParts = (project: ProjectDocument): Part[] =>
  project.parts.map((part) => ({ ...part, rotations: effectiveRotations(project, part) }));

export const setDefaultRotations = (
  project: ProjectDocument,
  rotations: RotationRule,
): ProjectDocument => ({ ...project, partDefaults: { ...project.partDefaults, rotations } });

/** Give parts their own rotations, or `'default'` to follow the defaults again. */
export function setPartRotations(
  project: ProjectDocument,
  ids: string[],
  rotations: RotationRule | 'default',
): ProjectDocument {
  const chosen = new Set(ids);
  return {
    ...project,
    parts: project.parts.map((part) => {
      if (!chosen.has(part.id)) return part;
      const { rotations: _, ...rest } = part;
      return rotations === 'default' ? rest : { ...rest, rotations };
    }),
  };
}

/** Names newly imported types without renaming existing parts or their source metadata. */
export function nameImportedParts(existing: { name: string }[], parts: Part[]): Part[] {
  let number = existing.reduce(
    (max, part) =>
      /^\d+$/.test(part.name) && Number.isSafeInteger(Number(part.name))
        ? Math.max(max, Number(part.name))
        : max,
    0,
  );
  return parts.map((part) => ({ ...part, name: String(++number).padStart(3, '0') }));
}

/** Add parts. A part whose rule matches the defaults follows them; any other keeps its own. */
export function addParts(project: ProjectDocument, parts: Part[]): ProjectDocument {
  const defaultKey = ruleKey(project.partDefaults.rotations);
  const added = parts.map(
    ({ rotations, ...rest }): ProjectPart =>
      ruleKey(rotations) === defaultKey ? rest : { ...rest, rotations },
  );
  return { ...project, parts: [...project.parts, ...added] };
}

/** The rule most parts use, for the defaults of a project made from an existing set of parts. */
export function commonRotations(parts: Part[], fallback: RotationRule): RotationRule {
  const counts = new Map<string, { rule: RotationRule; count: number }>();
  for (const part of parts) {
    const key = ruleKey(part.rotations);
    const entry = counts.get(key) ?? { rule: part.rotations, count: 0 };
    counts.set(key, { ...entry, count: entry.count + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.rule ?? fallback;
}
