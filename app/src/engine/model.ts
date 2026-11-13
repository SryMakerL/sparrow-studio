export const MAX_SOLVER_THREADS = 32;
export type Point = [number, number];
export type Ring = Point[];
export type RotationRule = { kind: 'discrete'; degrees: number[] } | { kind: 'continuous' };
export type Part = {
  id: string;
  name: string;
  source: { format: 'svg' | 'dxf' | 'sparrow'; fileName?: string; entityId?: string };
  outer: Ring;
  holes: Ring[];
  approximationToleranceMm: number;
  quantity: number;
  priority: number;
  rotations: RotationRule;
};
export type SheetStock = {
  id: string;
  name: string;
  quantity: number;
  priority: number;
  widthMm: number;
  lengthMm: number;
} & (
  | { kind: 'rectangle' }
  | {
      kind: 'polygon';
      outer: Ring;
      holes: Ring[];
      source?: Part['source'];
      approximationToleranceMm?: number;
    }
);
export type Preset = 'standard' | 'fast';
export type TimeLimit = 10 | 30 | 60 | 120 | 300 | 600 | null;
export type SheetCycleBudget = {
  localMs: number;
  globalMs: number;
  evacuationMs: number;
  localPercent: number;
  globalPercent: number;
  evacuationPercent: number;
  maxRounds: number;
  stallRounds: number;
};
export { DEFAULT_SHEET_CYCLE_BUDGET } from './sheetCycleBudget';
/** Solver-facing settings of one strip packing job. */
export type JobSettings = {
  sheetCycleBudget?: SheetCycleBudget;
  sheetStocks?: SheetStock[];
  sheetStock?: SheetStock;
  /** Solver-internal domains of horizontally translated, unrotated physical boards. */
  virtualBoards?: { outer: Ring; holes: Ring[] }[];
  sheetLengthMm?: number;
  sheetCount?: number;
  /** @deprecated Compatibility only; ignored by the solver. */
  sheetCompressionSeconds?: number;
  sheetInsertionWarmStartSeconds?: number;
  sheetInsertionFailures?: number;
  solverPreset: Preset;
  materialWidthMm: number;
  clearanceMm: number;
  timeLimitSeconds: TimeLimit;
};
/** One complete nesting problem, as the solver and the geometry checks read it. */
export type Job = { name: string; parts: Part[]; settings: JobSettings };
export type Placement = {
  partId: string;
  copyIndex: number;
  xMm: number;
  yMm: number;
  angleDeg: number;
};
export type Validation = {
  status: 'pending' | 'passed' | 'failed';
  source?: 'solver';
  overlapAreaMm2: number | null;
  maxBoundaryViolationMm: number | null;
  minClearanceMm: number | null;
  errors: string[];
};
export type Result = {
  documentRevision: number;
  solverRevision: string;
  seed: string;
  elapsedSeconds: number;
  usedLengthMm: number;
  placements: Placement[];
  validation: Validation;
  /** Zero-based sheet search round; absent for strip results. */
  roundIndex?: number;
  /** Zero-based active board in a current-round snapshot. */
  currentSheetIndex?: number;
  /** Original virtual-domain board index for a split live candidate. */
  physicalBoardIndex?: number;
  sheets?: { job: Job; result: Result }[];
  unplaced?: { partId: string; quantity: number }[];
};
export const DEFAULT_SETTINGS: JobSettings = {
  solverPreset: 'standard',
  materialWidthMm: 1000,
  clearanceMm: 0,
  timeLimitSeconds: null,
};
export const SOLVER_REVISION = '7f0e10f946f70a86138d3938548a13ee46464f39+studio-stage-budgets-7';
export const LIMITS = { extent: 100000 };
// DXF exports draw the sheet on this layer; DXF import leaves it out unless chosen, so exports reimport as their parts.
export const SHEET_LAYER = 'SPARROW_SHEET';
export const defaultDXFLayers = (layers: string[]) =>
  layers.filter((layer) => layer !== SHEET_LAYER);
export const POLICY = { linearMm: 1e-6, overlapMm2: 1e-8, angleDeg: 1e-4 };
// getRandomValues also works on HTTP LAN addresses, unlike randomUUID.
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export function newPart(outer: Ring, name = 'Part'): Part {
  return {
    id: newId(),
    name,
    source: { format: 'svg' },
    outer,
    holes: [],
    approximationToleranceMm: 0,
    quantity: 1,
    priority: 0,
    rotations: { kind: 'discrete', degrees: [0, 180] },
  };
}
