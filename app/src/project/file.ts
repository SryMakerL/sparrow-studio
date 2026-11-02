import { normalizeSheetStocks } from '../engine/stock';
import type { SheetStock } from '../engine/model';
import { validate } from '../engine/geometry/validate';
import { normalizeJob } from '../engine/geometry/normalize';
import { LIMITS } from '../engine/model';
import { normalizePart } from '../engine/geometry/normalize';
import { TIME_LIMITS, PROJECT_FORMAT, PROJECT_VERSION, type ProjectDocument } from './model';

const fail = (message: string): never => {
  throw Error(`Not a valid sparrow studio project: ${message}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);

/**
 * Check a project document from a file or from storage. Part geometry goes through the same
 * normalization as imports. Saved solutions are checked against their own complete job.
 */
export function parseProject(value: unknown): ProjectDocument {
  if (!isRecord(value)) return fail('expected an object.');
  if (value.format !== PROJECT_FORMAT) return fail('unknown format.');
  if (value.version !== PROJECT_VERSION)
    return fail(`version ${String(value.version)} is not supported.`);
  if (typeof value.name !== 'string' || !value.name.trim()) return fail('missing name.');
  if (!Array.isArray(value.parts)) return fail('parts must be a list.');
  const stock = value.stock;
  if (
    !isRecord(stock) ||
    !['strip', 'sheets'].includes(stock.packing as string) ||
    !isRecord(stock.strip)
  )
    return fail('invalid stock.');
  if (
    stock.packing === 'sheets' &&
    (!finite(stock.lengthMm) ||
      (stock.lengthMm as number) <= 0 ||
      (stock.lengthMm as number) > LIMITS.extent ||
      !Number.isInteger(stock.quantity) ||
      (stock.quantity as number) <
        (Array.isArray(stock.sheets) && stock.sheets.length === 0 ? 0 : 1) ||
      (stock.quantity as number) > LIMITS.copies)
  )
    return fail('invalid sheets.');
  const strip = stock.strip;
  if (typeof strip.id !== 'string' || typeof strip.name !== 'string' || !finite(strip.widthMm))
    return fail('invalid strip.');
  if (!Array.isArray(value.machines) || !value.machines.length)
    return fail('needs a machine preset.');
  for (const machine of value.machines)
    if (
      !isRecord(machine) ||
      typeof machine.id !== 'string' ||
      typeof machine.name !== 'string' ||
      !finite(machine.gapMm)
    )
      return fail('invalid machine preset.');
  if (typeof value.machineId !== 'string') return fail('missing active machine.');
  const settings = value.settings;
  if (
    !isRecord(settings) ||
    settings.solveWith !== 'local' ||
    !TIME_LIMITS.includes(settings.timeLimitSeconds as never) ||
    !['standard', 'fast'].includes(settings.preset as string) ||
    ![0, 1, 2, 3].includes(settings.threads as number)
  )
    return fail('invalid solver settings.');
  const sheetStagnationSeconds =
    settings.sheetStagnationSeconds === undefined ? 15 : settings.sheetStagnationSeconds;
  if (
    !Number.isInteger(sheetStagnationSeconds) ||
    (sheetStagnationSeconds as number) < 1 ||
    (sheetStagnationSeconds as number) > 600
  )
    return fail('invalid sheet no-improvement timeout.');
  if (!Array.isArray(value.solutions)) return fail('solutions must be a list.');
  const defaults = value.partDefaults;
  const rule = isRecord(defaults) ? defaults.rotations : undefined;
  const validRule =
    isRecord(rule) &&
    (rule.kind === 'continuous' ||
      (rule.kind === 'discrete' &&
        Array.isArray(rule.degrees) &&
        rule.degrees.length > 0 &&
        rule.degrees.every(finite)));
  if (!validRule) return fail('invalid part defaults.');
  const project = value as unknown as ProjectDocument;
  // Check each part with the rule it solves with, then keep only what it stores itself.
  const parts = project.parts.map((part) => {
    const { rotations, ...checked } = normalizePart({
      ...part,
      rotations: part.rotations ?? project.partDefaults.rotations,
    });
    return part.rotations ? { ...checked, rotations } : checked;
  });
  for (const solution of project.solutions) {
    if (
      !isRecord(solution) ||
      !solution.job ||
      !solution.result ||
      !['Complete', 'Stopped'].includes(solution.stopReason)
    )
      return fail('invalid solution.');
    normalizeJob(solution.job);
    const checked = validate(solution.job, solution.result);
    if (checked.status !== 'passed') return fail(`invalid solution: ${checked.errors.join(' ')}`);
  }
  return {
    ...project,
    stock:
      project.stock.packing === 'sheets' && project.stock.sheets !== undefined
        ? {
            ...project.stock,
            sheets: normalizeSheetStocks(project.stock.sheets as SheetStock[], true),
          }
        : project.stock,
    settings: { ...project.settings, sheetStagnationSeconds: sheetStagnationSeconds as number },
    parts,
  };
}

export const serializeProject = (project: ProjectDocument) => JSON.stringify(project, null, 2);

export function projectFileName(name: string, extension: string): string {
  const safe = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return `${safe || 'project'}.${extension}`;
}
