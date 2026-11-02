import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { importDXF } from '../src/engine/import/dxf';
import { netArea } from '../src/engine/geometry/validate';

it.each(['_6.dxf', '_11.dxf', 'circle sheet.dxf'])(
  'reduces curve vertices at 0.05 mm for %s without losing contours',
  (file) => {
    const text = readFileSync(`../test/${file}`, 'utf8');
    const parse = (tolerance: number) =>
      importDXF(text, file, { scale: 1, tolerance, enclosed: 'holes' });
    const fine = parse(0.01);
    const coarse = parse(0.05);
    expect(fine.issues).toEqual([]);
    expect(coarse.issues).toEqual([]);
    expect(coarse.document.parts).toHaveLength(fine.document.parts.length);
    const vertices = (review: typeof fine) =>
      review.document.parts.reduce(
        (n, part) => n + part.outer.length + part.holes.reduce((m, ring) => m + ring.length, 0),
        0,
      );
    const area = (review: typeof fine) =>
      review.document.parts.reduce((n, part) => n + netArea(part), 0);
    expect(coarse.document.parts.map((part) => part.holes.length)).toEqual(
      fine.document.parts.map((part) => part.holes.length),
    );
    expect(vertices(coarse)).toBeLessThan(vertices(fine));
    expect(Math.abs(area(coarse) / area(fine) - 1)).toBeLessThan(0.01);
    console.log(
      JSON.stringify({
        file,
        fineVertices: vertices(fine),
        defaultVertices: vertices(coarse),
        areaChangePercent: (area(coarse) / area(fine) - 1) * 100,
      }),
    );
  },
);
