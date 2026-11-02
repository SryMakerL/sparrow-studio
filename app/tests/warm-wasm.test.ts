import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it.each(['pkg', 'pkg-nosimd'])(
  'runs incremental insertion in the compiled %s solver',
  async (pkg) => {
    vi.stubGlobal('postMessage', () => {});
    const wasm = await import(`../../web/wasm/${pkg}/sparrow_web.js`);
    wasm.initSync({ module: readFileSync(`../web/wasm/${pkg}/sparrow_web_bg.wasm`) });
    const input = {
      name: 'warm wasm',
      strip_height: 100,
      stock_length: 160,
      items: [
        {
          id: 0,
          demand: 2,
          allowed_orientations: [0],
          shape: { type: 'rectangle', data: { x_min: 0, y_min: 0, width: 50, height: 80 } },
        },
      ],
      initial_placement: {
        used_length_mm: 56,
        placements: [{ item_id: 0, rotation: 0, translation: [3, 3] }],
      },
    };
    const candidates: { strip_width: number; layout: { placed_items: unknown[] } }[] = [];
    wasm.run(
      JSON.stringify(input),
      10,
      '42',
      2,
      'fast',
      (text: string) => {
        const message = JSON.parse(text);
        if (message.type === 'candidate') candidates.push(message.solution);
      },
      () => true,
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.layout.placed_items.length === 2)).toBe(true);
    expect(candidates.every((candidate) => candidate.strip_width <= 160)).toBe(true);
    expect(candidates[0].strip_width).toBeGreaterThan(56);
    expect(() =>
      wasm.run(
        JSON.stringify({ ...input, stock_length: 60 }),
        10,
        '42',
        2,
        'fast',
        () => {},
        () => true,
      ),
    ).toThrow();
  },
  15000,
);
