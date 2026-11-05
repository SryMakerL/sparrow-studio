import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, newPart, type Document } from '../src/model';
import { normalizeDocument } from '../src/geometry/normalize';
import { documentPlacements } from '../src/geometry/placements';
import { labelPoints } from '../src/geometry/preparation';

const part = () => newPart([[0, 0], [10, 0], [10, 10], [0, 10]]);
const doc = (parts: Document['parts']): Document => ({ name: 'Scale regression', parts, settings: DEFAULT_SETTINGS });

it('accepts and renders 501 copies without truncation', () => {
  const document = normalizeDocument(doc([{ ...part(), quantity: 501 }]));
  expect(documentPlacements(document)).toHaveLength(501);
});

it('accepts 501 part types and their labels', () => {
  const document = normalizeDocument(doc(Array.from({ length: 501 }, part)));
  expect(document.parts).toHaveLength(501);
  expect(labelPoints(document.parts)).toHaveLength(501);
});

it('does not multiply geometry by quantity for a vertex cap', () => {
  expect(normalizeDocument(doc([{ ...part(), quantity: 25001 }])).parts[0].quantity).toBe(25001);
});

it('still rejects invalid quantities while allowing zero', () => {
  expect(normalizeDocument(doc([{ ...part(), quantity: 0 }])).parts[0].quantity).toBe(0);
  for (const quantity of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => normalizeDocument(doc([{ ...part(), quantity }]))).toThrow(/safe integer/);
  }
});
