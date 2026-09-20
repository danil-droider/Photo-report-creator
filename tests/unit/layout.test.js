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
    // v7.3 — portrait fixtures on purpose: landscape photos are hard-capped at
    // 3 per row, so a 10-wide row can only be asserted with uncapped photos.
    const imgs = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      width: 600,
      height: 800,
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


describe('Layout.calculateLayout — v7.3 landscape capacity cap', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Horizontal photo: width > height. */
  const landscape = (i) => ({ id: i, width: 800, height: 600 });
  /** Vertical photo: never counted against the cap. */
  const portrait = (i) => ({ id: i, width: 600, height: 800 });
  /** Exactly square: not a landscape photo either. */
  const square = (i) => ({ id: i, width: 800, height: 800 });

  const series = (count, make) =>
    Array.from({ length: count }, (_, i) => make(i));

  /** Group a layout into rows: every entry sharing a `y` is one row. */
  function rowsOf(out) {
    const rows = [];
    for (const photo of out) {
      const current = rows[rows.length - 1];
      if (current && current[0].y === photo.y) current.push(photo);
      else rows.push([photo]);
    }
    return rows;
  }

  it('hard-caps a row at 3 landscape photos even when columns = 4', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const out = Layout.calculateLayout(series(4, landscape), {
      columns: 4,
      targetHeightCm: 10,
    });
    const rows = rowsOf(out);

    expect(rows.map((row) => row.map((p) => p.id))).toEqual([
      [0, 1, 2],
      [3],
    ]);
    // Row 1 is one horizontal run, row 2 restarts at the origin below it.
    expect(new Set(rows[0].map((p) => p.y)).size).toBe(1);
    expect(rows[0][1].x).toBeGreaterThan(rows[0][0].x);
    expect(rows[0][2].x).toBeGreaterThan(rows[0][1].x);
    expect(rows[1][0].x).toBe(0);
    expect(rows[1][0].y).toBeGreaterThan(rows[0][0].y);
  });

  it('splits any run of landscape photos into rows of 3 (columns: 4)', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    for (const [count, expected] of [
      [1, [1]],
      [2, [2]],
      [3, [3]],
      [4, [3, 1]],
      [7, [3, 3, 1]],
      [9, [3, 3, 3]],
      [10, [3, 3, 3, 1]],
    ]) {
      const rows = rowsOf(
        Layout.calculateLayout(series(count, landscape), { columns: 4 })
      );
      expect(rows.map((row) => row.length)).toEqual(expected);
      expect(rows.flat().map((p) => p.id)).toEqual(
        Array.from({ length: count }, (_, i) => i)
      );
    }
  });

  it('applies the same 3-photo cap at every print height preset', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    for (const targetHeightCm of [8, 10, 12, 15]) {
      const rows = rowsOf(
        Layout.calculateLayout(series(5, landscape), {
          columns: 4,
          targetHeightCm,
        })
      );
      expect(rows.map((row) => row.length)).toEqual([3, 2]);
      expect(
        rows
          .flat()
          .every((p) => p.height === Math.round(targetHeightCm * PX_PER_CM))
      ).toBe(true);
    }
  });


  it('never widens a lower user capacity: columns 2 stays 2 per row', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const rows = rowsOf(
      Layout.calculateLayout(series(6, landscape), { columns: 2 })
    );
    expect(rows.map((row) => row.length)).toEqual([2, 2, 2]);
  });

  it('keeps one landscape photo per row when columns = 1', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const out = Layout.calculateLayout(series(3, landscape), { columns: 1 });
    const rows = rowsOf(out);

    expect(rows.map((row) => row.length)).toEqual([1, 1, 1]);
    expect(new Set(out.map((p) => p.x)).size).toBe(1); // all at startX
  });

  it('does not cap portrait photos (columns: 4 keeps 4 per row)', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const rows = rowsOf(
      Layout.calculateLayout(series(6, portrait), { columns: 4 })
    );
    expect(rows.map((row) => row.length)).toEqual([4, 2]);
  });

  it('does not cap square photos — only width > height counts', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const rows = rowsOf(
      Layout.calculateLayout(series(5, square), { columns: 4 })
    );
    expect(rows.map((row) => row.length)).toEqual([4, 1]);
  });

  it('hard-wraps right after the 3rd landscape photo, even if a portrait follows', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const photos = [0, 1, 2].map(landscape); // 3 horizontals
    photos.push(portrait(3)); // would fit the 4th slot of columns: 4
    photos.push(landscape(4));

    const rows = rowsOf(Layout.calculateLayout(photos, { columns: 4 }));

    expect(rows.map((row) => row.map((p) => p.id))).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(rows[1][0].x).toBe(0); // the portrait opens row 2
    expect(rows[1][0].y).toBeGreaterThan(rows[0][0].y);
  });

  it('caps only the landscape count, leaving portrait fillers uncounted', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // L P L P | L L — row 1 fills up on `columns` (2 landscapes, 2 portraits),
    // row 2 holds the remaining 2 landscapes.
    const photos = [
      landscape(0),
      portrait(1),
      landscape(2),
      portrait(3),
      landscape(4),
      landscape(5),
    ];
    const rows = rowsOf(Layout.calculateLayout(photos, { columns: 4 }));

    expect(rows.map((row) => row.map((p) => p.id))).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });


  it('honors a stricter maxLandscapePerRow and sanitizes junk values', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const strict = rowsOf(
      Layout.calculateLayout(series(5, landscape), {
        columns: 4,
        maxLandscapePerRow: 2,
      })
    );
    expect(strict.map((row) => row.length)).toEqual([2, 2, 1]);

    // Junk falls back to the 3-photo default; out-of-range numbers are clamped
    // into [1, 10] by the shared intInRange() sanitizer (cap = 1 per row).
    const junk = rowsOf(
      Layout.calculateLayout(series(4, landscape), {
        columns: 4,
        maxLandscapePerRow: 'x',
      })
    );
    expect(junk.map((row) => row.length)).toEqual([3, 1]);

    for (const maxLandscapePerRow of [0, -1]) {
      const rows = rowsOf(
        Layout.calculateLayout(series(4, landscape), {
          columns: 4,
          maxLandscapePerRow,
        })
      );
      expect(rows.map((row) => row.length)).toEqual([1, 1, 1, 1]);
    }
  });

  it('never exceeds min(3, columns) landscapes per row for any seed or size', () => {
    const Layout = loadLayout();
    for (const columns of [1, 2, 3, 4]) {
      for (const n of [1, 4, 7, 11]) {
        for (const seed of [1, 42, 12345]) {
          vi.spyOn(Math, 'random').mockImplementation(mulberry32(seed));
          // Every 3rd photo is a portrait, so both wrap rules are exercised.
          const photos = Array.from({ length: n }, (_, i) =>
            i % 3 === 1 ? portrait(i) : landscape(i)
          );
          const out = Layout.calculateLayout(photos, { columns });

          expect(out).toHaveLength(n);
          for (const row of rowsOf(out)) {
            const horizontals = row.filter((p) => p.width > p.height).length;
            expect(horizontals).toBeLessThanOrEqual(Math.min(3, columns));
            expect(row.length).toBeLessThanOrEqual(columns);
          }
          vi.restoreAllMocks();
        }
      }
    }
  });
});

