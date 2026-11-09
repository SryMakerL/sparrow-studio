import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])(
  'restores warm coordinates after session loss in compiled %s',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({
      module: readFileSync(
        resolve(import.meta.dirname, '../../web/wasm', pkg, 'sparrow_web_bg.wasm'),
      ),
    });
    const rectangle = (id: number, size: number) => ({
      id,
      demand: 3,
      allowed_orientations: [0, 90],
      shape: { type: 'rectangle', data: { x_min: 0, y_min: 0, width: size, height: size } },
    });
    const input = JSON.stringify({
      name: 'warm recovery',
      strip_height: 100,
      stock_length: 120,
      items: [rectangle(0, 30), rectangle(1, 10)],
    });
    type Candidate = {
      type: string;
      snapshotId: number;
      solution: {
        strip_width: number;
        layout: {
          placed_items: {
            item_id: number;
            transformation: { rotation: number; translation: [number, number] };
          }[];
        };
      };
    };
    const run = (session: any, request: object) => {
      const messages: Candidate[] = [];
      session.step(JSON.stringify(request), '42', (text: string) =>
        messages.push(JSON.parse(text)),
      );
      expect(messages.at(-1)?.type).toBe('finished');
      return messages.filter((message) => message.type === 'candidate').at(-1)!;
    };
    const firstSession = new wasm.SheetSession(input, 1, 'fast');
    const original = run(firstSession, { quantities: [0, 1], mode: 'search', budget_ms: 0 });
    firstSession.free();
    const session = new wasm.SheetSession(input, 1, 'fast');
    const initial_placement = {
      used_length_mm: original.solution.strip_width,
      placements: original.solution.layout.placed_items.map((item) => ({
        item_id: item.item_id,
        rotation: item.transformation.rotation,
        translation: item.transformation.translation,
      })),
    };
    try {
      const restored = run(session, {
        quantities: [0, 2],
        mode: 'search',
        budget_ms: 0,
        initial_placement,
      });
      expect(restored.solution.layout.placed_items).toHaveLength(2);
      expect(restored.solution.layout.placed_items.every((item) => item.item_id === 1)).toBe(true);
      for (const placement of original.solution.layout.placed_items)
        expect(restored.solution.layout.placed_items).toContainEqual(placement);
      const inserted = run(session, {
        quantities: [0, 3],
        mode: 'search',
        budget_ms: 0,
        initial_snapshot: restored.snapshotId,
        retain_snapshot: restored.snapshotId,
      });
      expect(inserted.solution.layout.placed_items).toHaveLength(3);
      for (const placement of restored.solution.layout.placed_items)
        expect(inserted.solution.layout.placed_items).toContainEqual(placement);
      expect(() =>
        run(session, {
          quantities: [0, 500],
          mode: 'search',
          budget_ms: 0,
          initial_placement,
        }),
      ).toThrow(/Warm start insertion failed:/);
      expect(() =>
        run(session, {
          quantities: [0, 2],
          mode: 'search',
          budget_ms: 0,
          initial_placement: {
            ...initial_placement,
            placements: initial_placement.placements.map((placement) => ({
              ...placement,
              translation: [-1000, -1000],
            })),
          },
        }),
      ).toThrow(/Warm-start restoration failed/);
    } finally {
      session.free();
    }
  },
  15000,
);
