import polygonClipping from 'polygon-clipping';
import { jobStocks, stockGeometryKey } from '../stock';
import {
  LIMITS,
  POLICY,
  type Job,
  type Part,
  type Placement,
  type Point,
  type Result,
  type Ring,
  type Validation,
} from '../model';
import { area, bounds, intersects, normalizeJob, normalizePart } from './normalize';

export type WorldPart = { partId: string; copyIndex: number; outer: Ring; holes: Ring[] };
export const transform = (ring: Ring, p: Placement): Ring => {
  const angle = (p.angleDeg * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return ring.map(([x, y]) => [x * c - y * s + p.xMm, x * s + y * c + p.yMm]);
};
export function worldParts(doc: Job, result: Pick<Result, 'placements'>): WorldPart[] {
  const parts = new Map(doc.parts.map((p) => [p.id, p]));
  return result.placements.map((p) => {
    const part = parts.get(p.partId);
    if (!part) throw Error(`Unknown part ${p.partId}.`);
    return {
      partId: p.partId,
      copyIndex: p.copyIndex,
      outer: transform(part.outer, p),
      holes: part.holes.map((h) => transform(h, p)),
    };
  });
}
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    d = dx * dx + dy * dy;
  const t = d === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function distance(a: Ring, b: Ring): number {
  let min = Infinity;
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) {
      const p = a[i],
        q = a[(i + 1) % a.length],
        r = b[j],
        s = b[(j + 1) % b.length];
      if (intersects(p, q, r, s)) return 0;
      min = Math.min(
        min,
        pointSegmentDistance(p, r, s),
        pointSegmentDistance(q, r, s),
        pointSegmentDistance(r, p, q),
        pointSegmentDistance(s, p, q),
      );
    }
  return min;
}
export function validate(doc: Job, result: Result, serialized?: WorldPart[]): Validation {
  const v: Validation & { overlapAreaMm2: number; maxBoundaryViolationMm: number } = {
    status: 'failed',
    overlapAreaMm2: 0,
    maxBoundaryViolationMm: 0,
    minClearanceMm: null,
    errors: [],
  };
  try {
    if (result.sheets) return validateSheets(doc, result);
    if (doc.settings.sheetCount !== undefined)
      throw Error('A multi-sheet job requires a sheet aggregate.');
    doc = normalizeJob(doc);
    const extentLimit = doc.settings.virtualBoards ? 10_000_000 : LIMITS.extent;
    if (
      !Number.isFinite(result.usedLengthMm) ||
      result.usedLengthMm <= 0 ||
      result.usedLengthMm > extentLimit
    )
      throw Error(
        `Used length must be finite, positive, and at most ${extentLimit.toLocaleString('en-US')} mm.`,
      );
    if (
      doc.settings.sheetLengthMm !== undefined &&
      result.usedLengthMm > doc.settings.sheetLengthMm + POLICY.linearMm
    )
      throw Error('Layout exceeds sheet length.');
    if (
      !Array.isArray(result.placements) ||
      result.placements.length !== doc.parts.reduce((n, p) => n + p.quantity, 0)
    )
      throw Error('Layout does not contain exactly the demanded copies.');
    const parts = new Map(doc.parts.map((p) => [p.id, p]));
    const seen = new Set<string>();
    for (const p of result.placements) {
      const part = parts.get(p.partId);
      if (
        !part ||
        !Number.isInteger(p.copyIndex) ||
        p.copyIndex < 0 ||
        p.copyIndex >= part.quantity
      )
        throw Error('Unknown part or copy index.');
      if (
        Object.keys(p).some((k) => !['partId', 'copyIndex', 'xMm', 'yMm', 'angleDeg'].includes(k))
      )
        throw Error('Placements support rigid rotations and translations only.');
      if (![p.xMm, p.yMm, p.angleDeg].every(Number.isFinite))
        throw Error('Placement contains a non-finite transform.');
      const key = JSON.stringify([p.partId, p.copyIndex]);
      if (seen.has(key)) throw Error('Duplicate part copy.');
      seen.add(key);
      if (
        part.rotations.kind === 'discrete' &&
        !part.rotations.degrees.some(
          (a) => Math.abs(((((p.angleDeg - a) % 360) + 540) % 360) - 180) <= POLICY.angleDeg,
        )
      )
        throw Error(`Disallowed rotation for ${part.name}.`);
    }
    const expected = worldParts(doc, result),
      world = serialized ?? expected;
    if (world.length !== result.placements.length)
      throw Error('Serialized contour count differs from the layout.');
    const boxes = world.map((p, i) => {
      const original = parts.get(p.partId);
      if (
        !original ||
        p.partId !== result.placements[i].partId ||
        p.copyIndex !== result.placements[i].copyIndex ||
        p.holes.length !== original.holes.length
      )
        throw Error('Serialized part or hole identity differs from the layout.');
      if (serialized) {
        const expectedRings = [expected[i].outer, ...expected[i].holes];
        if (
          [p.outer, ...p.holes].some(
            (ring, j) =>
              ring.length !== expectedRings[j].length ||
              ring.some(
                (point, k) =>
                  point.length !== 2 ||
                  point.some((coordinate, axis) => coordinate !== expectedRings[j][k][axis]),
              ),
          )
        )
          throw Error('Serialized contours differ from the rigidly transformed input geometry.');
      }
      if (doc.settings.virtualBoards) {
        const origin = bounds(p.outer);
        const local = (ring: Ring): Ring => ring.map(([x, y]) => [x - origin[0], y - origin[1]]);
        normalizePart({ ...original, outer: local(p.outer), holes: p.holes.map(local) });
        const contained = doc.settings.virtualBoards.some((board) => {
          const outside = polygonClipping.difference([p.outer], [board.outer, ...board.holes]);
          return (
            outside.reduce(
              (sum, polygon) =>
                sum +
                Math.abs(area(polygon[0])) -
                polygon.slice(1).reduce((holes, ring) => holes + Math.abs(area(ring)), 0),
              0,
            ) <= POLICY.overlapMm2
          );
        });
        if (!contained) v.errors.push('Part must be completely contained in one physical board.');
      } else normalizePart({ ...original, outer: p.outer, holes: p.holes });
      const stock = doc.settings.sheetStock;
      if (stock?.kind === 'polygon') {
        const outside = polygonClipping.difference([p.outer], [stock.outer, ...stock.holes]);
        const outsideArea = outside.reduce(
          (n, poly) =>
            n + Math.abs(area(poly[0])) - poly.slice(1).reduce((m, h) => m + Math.abs(area(h)), 0),
          0,
        );
        if (outsideArea > POLICY.overlapMm2)
          v.errors.push('Part crosses polygon stock boundary or enters a stock hole.');
      }
      const b = bounds(p.outer);
      v.maxBoundaryViolationMm = Math.max(
        v.maxBoundaryViolationMm,
        -b[0],
        -b[1],
        b[2] - result.usedLengthMm,
        b[3] - doc.settings.materialWidthMm,
      );
      return b;
    });
    if (v.maxBoundaryViolationMm > POLICY.linearMm)
      v.errors.push(`Material boundary exceeded by ${v.maxBoundaryViolationMm} mm.`);
    let operations = 0;
    for (let i = 0; i < world.length; i++)
      for (let j = 0; j < i; j++) {
        const a = boxes[i],
          b = boxes[j];
        const boxDistance = Math.hypot(
          Math.max(0, a[0] - b[2], b[0] - a[2]),
          Math.max(0, a[1] - b[3], b[1] - a[3]),
        );
        if (boxDistance === 0) {
          const clipped = polygonClipping.intersection([world[i].outer], [world[j].outer]);
          const overlap = clipped.reduce(
            (total, poly) =>
              total +
              Math.abs(area(poly[0])) -
              poly.slice(1).reduce((n, h) => n + Math.abs(area(h)), 0),
            0,
          );
          if (!Number.isFinite(overlap)) throw Error('Intersection returned a non-finite area.');
          v.overlapAreaMm2 = Math.max(v.overlapAreaMm2, overlap);
          if (overlap > POLICY.overlapMm2 && v.errors.length < 20)
            v.errors.push(`Copies ${j + 1} and ${i + 1} overlap by ${overlap} mm².`);
        }
        if (
          doc.settings.clearanceMm > 0 &&
          (v.minClearanceMm === null || boxDistance < v.minClearanceMm)
        ) {
          operations += world[i].outer.length * world[j].outer.length;
          if (operations > 50_000_000)
            throw Error(
              'Clearance check exceeded its segment budget. Use fewer vertices or parts.',
            );
          const gap = distance(world[i].outer, world[j].outer);
          if (!Number.isFinite(gap)) throw Error('Clearance check returned a non-finite distance.');
          v.minClearanceMm = Math.min(v.minClearanceMm ?? Infinity, gap);
        }
      }
    if (v.minClearanceMm !== null && v.minClearanceMm + POLICY.linearMm < doc.settings.clearanceMm)
      v.errors.push(
        `Minimum clearance is ${v.minClearanceMm} mm; requested ${doc.settings.clearanceMm} mm.`,
      );
    v.status = v.errors.length ? 'failed' : 'passed';
  } catch (error) {
    v.errors.push(error instanceof Error ? error.message : String(error));
  }
  return v;
}
export function validateSheets(input: Job, result: Result): Validation {
  const validation: Validation = {
    status: 'failed',
    overlapAreaMm2: 0,
    maxBoundaryViolationMm: 0,
    minClearanceMm: null,
    errors: [],
  };
  try {
    const job = normalizeJob(input);
    if (
      !Array.isArray(result.sheets) ||
      !Array.isArray(result.unplaced) ||
      result.placements.length ||
      job.settings.sheetCount === undefined ||
      result.sheets.length > job.settings.sheetCount
    )
      throw Error('Invalid sheet aggregate.');
    const inventory = new Map(jobStocks(job).map((s) => [s.id, s]));
    const used = new Map<string, number>();
    const totals = new Map(job.parts.map((p) => [p.id, 0]));
    const identities = new Map(job.parts.map((p) => [p.id, p]));
    for (const sheet of result.sheets) {
      if (
        sheet.result.sheets !== undefined ||
        sheet.result.unplaced !== undefined ||
        sheet.job.settings.sheetCount !== undefined
      )
        throw Error('Nested sheet aggregates are not supported.');
      const snapshot = sheet.job.settings.sheetStock;
      if (snapshot) {
        const original = inventory.get(snapshot.id);
        if (!original || stockGeometryKey(original) !== stockGeometryKey(snapshot))
          throw Error('Sheet stock snapshot differs from inventory.');
        const count = (used.get(snapshot.id) ?? 0) + 1;
        if (count > original.quantity) throw Error('Sheet inventory exhausted.');
        used.set(snapshot.id, count);
        if (
          sheet.job.settings.sheetLengthMm !== original.lengthMm ||
          sheet.job.settings.materialWidthMm !== original.widthMm
        )
          throw Error('Sheet dimensions differ from inventory.');
      } else {
        if (
          job.settings.sheetStocks !== undefined ||
          sheet.job.settings.sheetLengthMm !== job.settings.sheetLengthMm ||
          sheet.job.settings.materialWidthMm !== job.settings.materialWidthMm
        )
          throw Error('Sheet settings differ from the job.');
      }
      if (sheet.job.settings.clearanceMm !== job.settings.clearanceMm)
        throw Error('Sheet clearance differs from the job.');
      for (const part of sheet.job.parts) {
        const original = identities.get(part.id);
        if (
          !original ||
          JSON.stringify([part.outer, part.holes, part.rotations]) !==
            JSON.stringify([original.outer, original.holes, original.rotations])
        )
          throw Error('Sheet part differs from the job.');
        totals.set(part.id, totals.get(part.id)! + part.quantity);
      }
      const checked = validate(sheet.job, sheet.result);
      if (checked.status !== 'passed') throw Error(checked.errors.join(' '));
    }
    const seen = new Set<string>();
    for (const entry of result.unplaced) {
      if (
        !totals.has(entry.partId) ||
        seen.has(entry.partId) ||
        !Number.isInteger(entry.quantity) ||
        entry.quantity <= 0
      )
        throw Error('Invalid unplaced quantity.');
      seen.add(entry.partId);
      totals.set(entry.partId, totals.get(entry.partId)! + entry.quantity);
    }
    if (job.parts.some((p) => totals.get(p.id) !== p.quantity))
      throw Error('Placed and unplaced quantities do not match the job.');
    validation.status = 'passed';
  } catch (error) {
    validation.errors.push(error instanceof Error ? error.message : String(error));
  }
  return validation;
}
export const netArea = (part: Pick<Part, 'outer' | 'holes'>) =>
  Math.abs(area(part.outer)) - part.holes.reduce((n, h) => n + Math.abs(area(h)), 0);
