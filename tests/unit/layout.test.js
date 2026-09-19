/**
 * layout.test.js — Stage 1 pure-math properties: aspect retention, uniform
 * height, row wrapping, the positive-gap floor, no-overlap invariants and the
 * option sanitizers. Runs in plain Node against the real layout.js.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadWindiModule, mulberry32 } from '../helpers/window-shim.js';

function loadLayout() {
  const win = {};
  loadWindiModule(win, 'layout.js');
  return win.Layout;
}

const PX_PER_CM = 37.8;

describe('Layout.calculateLayout — scaling and aspect ratio', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves each photo’s aspect ratio at a uniform height', () => {
    const Layout = loadLayout();
    const out = Layout.calculateLayout(
      [
        { id: 0, width: 800, height: 600 },
        { id: 1, width: 600, height: 800 },
        { id: 2, width: 1000, height: 1000 },
      ],
      { columns: 3, targetHeightCm: 10 }
    );

    const height = Math.round(10 * PX_PER_CM); // 378
    expect(out.map((p) => p.height)).toEqual([height, height, height]);
    expect(out[0].width).toBe(Math.round(height * (800 / 600))); // 504
    expect(out[1].width).toBe(Math.round(height * (600 / 800))); // 284
    expect(out[2].width).toBe(height); // square
  });

  it('scales the target height with the chosen cm preset', () => {
    const Layout = loadLayout();
    for (const cm of [8, 10, 12, 15]) {
      const [photo] = Layout.calculateLayout(
        [{ id: 0, width: 800, height: 600 }],
        { targetHeightCm: cm }
      );
      expect(photo.height).toBe(Math.round(cm * PX_PER_CM));
    }
  });

  it('honors startX / startY as the origin', () => {
    const Layout = loadLayout();
    const [first, second] = Layout.calculateLayout(
      [
        { id: 0, width: 800, height: 600 },
        { id: 1, width: 800, height: 600 },
      ],
      { columns: 2, startX: 100, startY: 50 }
    );
    expect(first.x).toBe(100);
    expect(first.y).toBe(50);
    expect(second.x).toBeGreaterThan(first.x);
    expect(second.y).toBe(first.y); // same row
  });

  it('passes through id and originalName', () => {
    const Layout = loadLayout();
    const [a, b] = Layout.calculateLayout(
      [
        { id: 7, originalName: 'a.jpg', width: 100, height: 50 },
        { width: 100, height: 50 },
      ],
      { columns: 2 }
    );
    expect(a.id).toBe(7);
    expect(a.originalName).toBe('a.jpg');
    expect(b.id).toBe(1); // array index fallback
    expect(b.originalName).toBe('');
  });
});

describe('Layout.calculateLayout — row wrapping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('wraps rows after `columns` photos and advances y below the row', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // gap = base + floor(0.5*6)

    const out = Layout.calculateLayout(
      Array.from({ length: 4 }, (_, i) => ({
        id: i,
        width: 800,
        height: 600,
      })),
      { columns: 2, targetHeightCm: 10 }
    );

    const height = Math.round(10 * PX_PER_CM);
    // random=0.5 -> offset floor(0.5*6)=3, jitter floor(0.5*3)-1=0
    // horizontal gap = 3 + 3 + 0 = 6;  vertical gap = 4 + 3 + 0 = 7
    expect(out[0].x).toBe(0);
    expect(out[1].x).toBe(504 + 6);
    expect(out[2].x).toBe(0);
    expect(out[2].y).toBe(height + 7 + 14); // row height + gap + safety
    expect(out[3]).toMatchObject({ x: 504 + 6, y: height + 7 + 14 });
  });

  it('places every photo on its own row when columns = 1', () => {
    const Layout = loadLayout();
    const out = Layout.calculateLayout(
      Array.from({ length: 3 }, (_, i) => ({ id: i, width: 800, height: 600 })),
      { columns: 1, targetHeightCm: 10 }
    );
    const ys = out.map((p) => p.y);
    expect(ys[0]).toBe(0);
    expect(ys[1]).toBeGreaterThan(ys[0]);
    expect(ys[2]).toBeGreaterThan(ys[1]);
    expect(new Set(out.map((p) => p.x)).size).toBe(1); // all at startX
  });
});

describe('Layout.calculateLayout — gap floor and no-overlap invariants', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never produces a gap below 1 px at the extremes of the RNG', () => {
    const Layout = loadLayout();
    for (const value of [0, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(value);
      const out = Layout.calculateLayout(
        Array.from({ length: 6 }, (_, i) => ({
          id: i,
          width: 800,
          height: 600,
        })),
        { columns: 2, targetHeightCm: 10 }
      );
      for (let i = 1; i < out.length; i++) {
        const prev = out[i - 1];
        const cur = out[i];
        if (cur.y === prev.y) {
          // Same row: strictly positive horizontal distance.
          expect(cur.x - (prev.x + prev.width)).toBeGreaterThanOrEqual(1);
        } else {
          // New row: y must clear the entire previous row plus the safety gap.
          expect(cur.y - (prev.y + prev.height)).toBeGreaterThanOrEqual(15);
        }
      }
      vi.restoreAllMocks();
    }
  });

  it('no two photos overlap for a range of columns, counts and seeds', () => {
    const Layout = loadLayout();
    for (const columns of [1, 2, 3, 4]) {
      for (const n of [0, 1, 2, 3, 7, 10]) {
        for (const seed of [1, 42, 12345]) {
          const rng = mulberry32(seed);
          vi.spyOn(Math, 'random').mockImplementation(rng);
          const images = Array.from({ length: n }, (_, i) => ({
            id: i,
            width: 400 + i * 37,
            height: 300 + (i % 3) * 111,
          }));
          const out = Layout.calculateLayout(images, {
            columns,
            targetHeightCm: 10,
          });
          expect(out).toHaveLength(n);
          for (let a = 0; a < out.length; a++) {
            for (let b = a + 1; b < out.length; b++) {
              const A = out[a];
              const B = out[b];
              const separated =
                A.x + A.width <= B.x ||
                B.x + B.width <= A.x ||
                A.y + A.height <= B.y ||
                B.y + B.height <= A.y;
              expect(separated).toBe(true);
            }
          }
          vi.restoreAllMocks();
        }
      }
    }
  });
});

describe('Layout.calculateLayout — option sanitizing and degenerate input', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clamps columns into [1, 10] and falls back on junk', () => {
    const Layout = loadLayout();
    const imgs = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      width: 800,
      height: 600,
    }));
    // columns: 0 -> default 2; 99 -> clamped to 10; 'x' -> default 2.
    expect(Layout.calculateLayout(imgs, { columns: 0 })).toHaveLength(12);
    const tenWide = Layout.calculateLayout(imgs, { columns: 99 });
    expect(tenWide.slice(0, 10).every((p) => p.y === 0)).toBe(true);
    expect(tenWide[10].y).toBeGreaterThan(0);
    expect(Layout.calculateLayout(imgs, { columns: 'x' })).toHaveLength(12);
  });

  it('falls back to defaults for negative/zero height, pxPerCm and origins', () => {
    const Layout = loadLayout();
    const [photo] = Layout.calculateLayout(
      [{ id: 0, width: 800, height: 600 }],
      {
        targetHeightCm: -5,
        pxPerCm: 0,
        startX: -1,
        startY: -1,
        baseGapPx: NaN,
      }
    );
    expect(photo.height).toBe(Math.round(10 * PX_PER_CM)); // 10 cm default
    expect(photo.x).toBe(0);
    expect(photo.y).toBe(0);
  });

  it('treats zero/missing dimensions as a 1:1 aspect ratio', () => {
    const Layout = loadLayout();
    const [a, b] = Layout.calculateLayout(
      [
        { id: 0, width: 0, height: 0 },
        { id: 1 },
      ],
      { targetHeightCm: 10 }
    );
    expect(a.width).toBe(a.height);
    expect(b.width).toBe(b.height);
  });

  it('tolerates null entries and non-array input', () => {
    const Layout = loadLayout();
    const out = Layout.calculateLayout([
      null,
      { id: 1, width: 100, height: 50 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].width).toBe(out[0].height); // aspect fallback 1
    expect(Layout.calculateLayout(undefined)).toEqual([]);
    expect(Layout.calculateLayout('nope')).toEqual([]);
  });
});

