import type { Job, Placement, Result, Ring } from '../model';
import { SOLVER_REVISION, POLICY } from '../model';
import { normalizeJob, bounds, area } from '../geometry/normalize';
import { validate, transform, distance } from '../geometry/validate';
import polygonClipping from 'polygon-clipping';

/** Continuous rotation is searched with finite 5-degree samples, not an exact optimizer. */
export async function solvePolygon(
  job: Job,
  signal?: AbortSignal,
  onCandidate?: (r: Result) => void,
  budgetMs = 2500,
  initialPlacement?: Result,
): Promise<Result | undefined> {
  job = normalizeJob(job);
  const snapshot = job.settings.sheetStock;
  if (!snapshot) throw Error('Sheet stock required.');
  const stock =
    snapshot.kind === 'polygon'
      ? snapshot
      : {
          ...snapshot,
          outer: [
            [0, 0],
            [snapshot.lengthMm, 0],
            [snapshot.lengthMm, snapshot.widthMm],
            [0, snapshot.widthMm],
          ] as Ring,
          holes: [] as Ring[],
        };
  const started = performance.now(),
    deadline = started + budgetMs;
  const stopped = () => signal?.aborted || performance.now() >= deadline;
  const copies = job.parts.flatMap((p) =>
    Array.from({ length: p.quantity }, (_, copyIndex) => ({ part: p, copyIndex })),
  );
  copies.sort((a, b) => Math.abs(area(b.part.outer)) - Math.abs(area(a.part.outer)));
  let best: Result | undefined;
  let operations = 0;
  const outsideArea = (ring: Ring) =>
    polygonClipping
      .difference([ring], [stock.outer, ...stock.holes])
      .reduce(
        (n, p) => n + Math.abs(area(p[0])) - p.slice(1).reduce((m, h) => m + Math.abs(area(h)), 0),
        0,
      );
  for (let round = 0; !stopped(); round++) {
    const order = [...copies];
    if (round > 0) {
      // New orders also act as local remove-and-reinsert searches of the greedy layout.
      const offset = round % Math.max(1, order.length);
      order.push(...order.splice(0, offset));
      if (round % 3 === 0)
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
    }
    const placements: Placement[] =
      round === 0 && initialPlacement ? structuredClone(initialPlacement.placements) : [];
    const rings: Ring[] = placements.map((placement) =>
      transform(job.parts.find((part) => part.id === placement.partId)!.outer, placement),
    );
    for (const { part, copyIndex } of order) {
      if (
        placements.some(
          (placement) => placement.partId === part.id && placement.copyIndex === copyIndex,
        )
      )
        continue;
      let chosen: Placement | undefined, chosenRing: Ring | undefined;
      const angles =
        part.rotations.kind === 'discrete'
          ? part.rotations.degrees
          : Array.from({ length: 72 }, (_, i) => ((i + round) % 72) * 5);
      for (const angleDeg of angles) {
        if (stopped()) break;
        const rotated = transform(part.outer, {
          partId: part.id,
          copyIndex,
          xMm: 0,
          yMm: 0,
          angleDeg,
        });
        const b = bounds(rotated);
        const candidates: [number, number][] = [];
        const gap = job.settings.clearanceMm;
        const sample = (ring: Ring): Ring =>
          ring.filter((_, i) => i % Math.max(1, Math.ceil(ring.length / 96)) === 0);
        const anchors = sample([...stock.outer, ...stock.holes.flat(), ...rings.flat()]);
        for (const target of anchors)
          for (const vertex of sample(rotated)) {
            candidates.push([target[0] - vertex[0], target[1] - vertex[1]]);
            if (gap > 0)
              for (const [dx, dy] of [
                [gap, 0],
                [-gap, 0],
                [0, gap],
                [0, -gap],
              ])
                candidates.push([target[0] - vertex[0] + dx, target[1] - vertex[1] + dy]);
          }
        for (let y = 0; y <= 12; y++)
          for (let x = 0; x <= 12; x++)
            candidates.push([
              ((stock.lengthMm - (b[2] - b[0])) * x) / 12 - b[0],
              ((stock.widthMm - (b[3] - b[1])) * y) / 12 - b[1],
            ]);
        candidates.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        for (const [xMm, yMm] of candidates) {
          if (++operations % 64 === 0) {
            await new Promise<void>((r) => setTimeout(r, 0));
            if (stopped()) break;
          }
          if (stopped()) break;
          const placement = { partId: part.id, copyIndex, xMm, yMm, angleDeg };
          const ring = rotated.map(([x, y]): [number, number] => [x + xMm, y + yMm]);
          const box = bounds(ring);
          if (
            box[0] < -POLICY.linearMm ||
            box[1] < -POLICY.linearMm ||
            box[2] > stock.lengthMm + POLICY.linearMm ||
            box[3] > stock.widthMm + POLICY.linearMm ||
            outsideArea(ring) > POLICY.overlapMm2
          )
            continue;
          if (
            rings.some(
              (other) =>
                polygonClipping
                  .intersection([ring], [other])
                  .some((p) => Math.abs(area(p[0])) > POLICY.overlapMm2) ||
                (gap > 0 && distance(ring, other) + POLICY.linearMm < gap),
            )
          )
            continue;
          if (
            !chosenRing ||
            box[2] < bounds(chosenRing)[2] - POLICY.linearMm ||
            (Math.abs(box[2] - bounds(chosenRing)[2]) <= POLICY.linearMm &&
              (box[1] < bounds(chosenRing)[1] - POLICY.linearMm ||
                (Math.abs(box[1] - bounds(chosenRing)[1]) <= POLICY.linearMm &&
                  angleDeg < chosen!.angleDeg)))
          ) {
            chosen = placement;
            chosenRing = ring;
          }
          break;
        }
        if (chosen && part.rotations.kind === 'continuous') break;
      }
      if (!chosen || !chosenRing) break;
      placements.push(chosen);
      rings.push(chosenRing);
    }
    if (placements.length === copies.length && !stopped()) {
      const result: Result = {
        documentRevision: 0,
        solverRevision: SOLVER_REVISION,
        seed: String(round),
        elapsedSeconds: (performance.now() - started) / 1000,
        usedLengthMm: Math.max(...rings.map((r) => bounds(r)[2])),
        placements,
        validation: {
          status: 'pending',
          overlapAreaMm2: null,
          maxBoundaryViolationMm: null,
          minClearanceMm: null,
          errors: [],
        },
      };
      if (!best || result.usedLengthMm < best.usedLengthMm) {
        result.validation = validate(job, result);
        if (result.validation.status === 'passed') {
          best = result;
          onCandidate?.(result);
        }
      }
      if (best && job.settings.solverPreset === 'fast') break;
    }
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return best;
}
