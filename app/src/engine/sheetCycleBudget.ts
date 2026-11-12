import type { SheetCycleBudget } from './model';

export const DEFAULT_SHEET_CYCLE_BUDGET: SheetCycleBudget = {
  localMs: 10000,
  globalMs: 10000,
  evacuationMs: 3000,
  localPercent: 60,
  globalPercent: 60,
  evacuationPercent: 25,
  maxRounds: 0,
  stallRounds: 0,
};

export const SHEET_CYCLE_BUDGET_RANGES: Record<
  keyof SheetCycleBudget,
  { min: number; max: number }
> = {
  localMs: { min: 1, max: 600000 },
  globalMs: { min: 1, max: 600000 },
  evacuationMs: { min: 1, max: 600000 },
  localPercent: { min: 1, max: 100 },
  globalPercent: { min: 1, max: 100 },
  evacuationPercent: { min: 1, max: 100 },
  maxRounds: { min: 0, max: 100000 },
  stallRounds: { min: 0, max: 100000 },
};

export function normalizeSheetCycleBudget(value: unknown): SheetCycleBudget {
  if (value === undefined) return { ...DEFAULT_SHEET_CYCLE_BUDGET };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid sheet cycle budget: expected an object.');
  for (const key of Object.keys(value))
    if (!Object.hasOwn(DEFAULT_SHEET_CYCLE_BUDGET, key))
      throw new Error(`Invalid sheet cycle budget: unknown field ${key}.`);
  const budget = { ...DEFAULT_SHEET_CYCLE_BUDGET };
  for (const key of Object.keys(budget) as (keyof SheetCycleBudget)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const number = (value as Record<string, unknown>)[key];
    const { min, max } = SHEET_CYCLE_BUDGET_RANGES[key];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max)
      throw new Error(
        `Invalid sheet cycle budget: ${key} must be an integer from ${min} to ${max}.`,
      );
    budget[key] = number;
  }
  return budget;
}
