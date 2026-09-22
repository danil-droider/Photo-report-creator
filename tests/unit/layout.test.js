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
    // v18.0 — the full 6–24 cm stepper ladder (2 cm steps).
    for (const cm of [6, 8, 10, 12, 14, 16, 18, 20, 22, 24]) {
      const [photo] = Layout.calculateLayout(
        [{ id: 0, width: 800, height: 600 }],
        { targetHeightCm: cm }
      );
      expect(photo.height).toBe(Math.round(cm * PX_PER_CM));
    }
  });

  it('honors startX / startY as the origin', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // neutral jitter => exact y
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
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // every jitter resolves to 0

    const out = Layout.calculateLayout(
      Array.from({ length: 4 }, (_, i) => ({
        id: i,
        width: 800,
        height: 600,
      })),
      { columns: 2, targetHeightCm: 10 }
    );

    const height = Math.round(10 * PX_PER_CM);
    // random=0.5 -> horizontal offset floor(0.5*6)=3 with jitter 0, so the
    // horizontal gap stays 3 + 3 + 0 = 6 px. BOTH v8.0 vertical jitters are 0
    // too, which exposes the bare 1 mm base gap: 1 mm * 3.7795 px/mm = 4 px.
    expect(out[0].x).toBe(0);
    expect(out[1].x).toBe(504 + 6);
    expect(out[2].x).toBe(0);
    expect(out[2].y).toBe(height + 4); // row height + the strict 1 mm gap
    expect(out[3]).toMatchObject({ x: 504 + 6, y: height + 4 });
  });

  it('places every photo on its own row when columns = 1', () => {
    const Layout = loadLayout();
    const out = Layout.calculateLayout(
      Array.from({ length: 3 }, (_, i) => ({ id: i, width: 800, height: 600 })),
      { columns: 1, targetHeightCm: 10 }
    );
    const ys = out.map((p) => p.y);
    // v8.0 — the top row may sit 0 or 1 px below the origin: the per-photo
    // jitter is applied to every photo, and the clamp only stops it going
    // negative. The row ORDER is what this test guards.
    expect(ys[0]).toBeGreaterThanOrEqual(0);
    expect(ys[0]).toBeLessThanOrEqual(1);
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
        if (cur.x === 0) {
          // New row — a wrap always lands back on startX. v8.0: rows are
          // detected on the unjittered x axis, and the distance is measured
          // from the REAL bottom edge of the row above, so even both jitters at
          // their extremes cannot make two photos touch or overlap.
          const above = [];
          for (let j = i - 1; j >= 0; j--) {
            if (j < i - 1 && out[j].x === 0) break;
            above.push(out[j]);
          }
          const bottom = Math.max(...above.map((p) => p.y + p.height));
          expect(cur.y - bottom).toBeGreaterThanOrEqual(1);
        } else {
          // Same row: strictly positive horizontal distance.
          expect(cur.x - (prev.x + prev.width)).toBeGreaterThanOrEqual(1);
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

  it('clamps columns into [1, 15] and falls back on junk', () => {
    const Layout = loadLayout();
    // Portrait fixtures on purpose: landscape photos are hard-capped at
    // 3 per row, so a 15-wide row can only be asserted with uncapped photos.
    const imgs = Array.from({ length: 16 }, (_, i) => ({
      id: i,
      width: 600,
      height: 800,
    }));
    // v18.0 — junk clamps, it never falls back: columns: 0 clamps to the 1
    // floor, 99 clamps to the new 15 ceiling, and only non-numeric junk
    // ('x') hits the DEFAULT_OPTIONS fallback (now 4).
    expect(Layout.calculateLayout(imgs, { columns: 0 })).toHaveLength(16);
    const oneWide = Layout.calculateLayout(imgs, { columns: 0 });
    // v8.0 — a first-row photo may sit 1 px below the origin, so "same row" is
    // asserted as the [0, 1] per-photo jitter band, never as an exact y.
    const inTopRow = (photos) => photos.every((p) => p.y >= 0 && p.y <= 1);
    expect(inTopRow([oneWide[0]])).toBe(true);
    expect(oneWide[1].y).toBeGreaterThan(1); // row 2 sits a whole row below
    const fourWide = Layout.calculateLayout(imgs, { columns: 'x' });
    expect(inTopRow(fourWide.slice(0, 4))).toBe(true);
    expect(fourWide[4].y).toBeGreaterThan(1);
    const fifteenWide = Layout.calculateLayout(imgs, { columns: 99 });
    expect(inTopRow(fifteenWide.slice(0, 15))).toBe(true);
    expect(fifteenWide[15].y).toBeGreaterThan(1);
  });

  it('falls back to defaults for negative/zero height, pxPerCm and origins', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // neutral jitter => exact y
    const [photo] = Layout.calculateLayout(
      [{ id: 0, width: 800, height: 600 }],
      {
        targetHeightCm: -5,
        pxPerCm: 0,
        startX: -1,
        startY: -1,
        rowGapPx: NaN,
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

describe('Layout.calculateLayout — v18.0 expanded ranges', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Horizontal photo: width > height. */
  const landscape = (i) => ({ id: i, width: 800, height: 600 });
  /** Vertical photo: never counted against the landscape cap. */
  const portrait = (i) => ({ id: i, width: 600, height: 800 });

  /**
   * Group a layout into rows by the row origin: every wrap lands back on
   * startX (0 here). v8.0 — a shared `y` can no longer define a row, because
   * the per-photo jitter moves each photo by up to +/-1 px; the x axis is the
   * unjittered one.
   */
  function rowsOf(out) {
    const rows = [];
    for (const photo of out) {
      if (photo.x === 0) rows.push([photo]);
      else rows[rows.length - 1].push(photo);
    }
    return rows;
  }

  it('converts every 6–24 cm stop through H_px = H_cm × 37.8', () => {
    const Layout = loadLayout();
    for (const cm of [6, 8, 10, 12, 14, 16, 18, 20, 22, 24]) {
      const [photo] = Layout.calculateLayout([portrait(0)], {
        targetHeightCm: cm,
        columns: 1,
      });
      expect(photo.height).toBe(Math.round(cm * PX_PER_CM));
    }
    // The ladder's extremes, spelled out: 226.8 → 227 px, 907.2 → 907 px.
    expect(Math.round(6 * PX_PER_CM)).toBe(227);
    expect(Math.round(24 * PX_PER_CM)).toBe(907);
  });

  it('places 15 portrait photos in one row at columns: 15', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const out = Layout.calculateLayout(
      Array.from({ length: 15 }, (_, i) => portrait(i)),
      { columns: 15 }
    );

    expect(out).toHaveLength(15);
    expect(out.every((p) => p.y === 0)).toBe(true);
    // Strictly increasing x: no overlap, and no clipping concern — the
    // floating-shape X axis simply grows (Stage 2 consumes it as-is).
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x).toBeGreaterThan(out[i - 1].x);
    }
    expect(out[0].height).toBe(Math.round(10 * PX_PER_CM));
  });

  it('keeps the 3-per-row landscape cap at columns: 15', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const out = Layout.calculateLayout(
      Array.from({ length: 5 }, (_, i) => landscape(i)),
      { columns: 15 }
    );

    const rows = rowsOf(out);
    expect(rows.map((row) => row.length)).toEqual([3, 2]);
  });
});

describe('Layout.calculateLayout — v8.0 1 mm row gap + vertical jitter', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Portrait fixture: the landscape cap never interferes with row counting. */
  const photo = (i) => ({ id: i, width: 600, height: 800 });

  const series = (count) => Array.from({ length: count }, (_, i) => photo(i));

  /**
   * Group a layout into rows by the row origin: every wrap lands back on
   * startX (0 here). v8.0 — a shared `y` can no longer define a row, because
   * the per-photo jitter moves each photo by up to +/-1 px; the x axis is the
   * unjittered one.
   */
  function rowsOf(out) {
    const rows = [];
    for (const entry of out) {
      if (entry.x === 0) rows.push([entry]);
      else rows[rows.length - 1].push(entry);
    }
    return rows;
  }

  /**
   * Per-photo distance from the REAL bottom edge of the row above (its lowest
   * photo, jitter included) — exactly what the 1 mm base gap plus the two
   * jitters produce.
   */
  function rowDistances(rows) {
    const distances = [];
    for (let r = 1; r < rows.length; r++) {
      const bottom = Math.max(...rows[r - 1].map((p) => p.y + p.height));
      for (const entry of rows[r]) distances.push(entry.y - bottom);
    }
    return distances;
  }

  it('publishes the gap constants: 1 mm * 3.7795 px/mm, rounded to 4 px', () => {
    const Layout = loadLayout();
    expect(Layout.ROW_GAP_MM).toBe(1);
    expect(Layout.PX_PER_MM).toBe(3.7795);
    expect(Layout.ROW_GAP_PX).toBe(4);
    expect(Layout.ROW_GAP_PX).toBe(
      Math.round(Layout.ROW_GAP_MM * Layout.PX_PER_MM)
    );
    expect(Layout.JITTER_RANGE_PX).toBe(3);
    expect(Layout.PHOTO_JITTER_PX).toBe(1);
    expect(Layout.MIN_ROW_GAP_PX).toBe(2);
    expect(Layout.DEFAULT_OPTIONS.rowGapPx).toBe(Layout.ROW_GAP_PX);
    expect(Layout.DEFAULT_OPTIONS.rowJitterPx).toBe(Layout.JITTER_RANGE_PX);
    expect(Layout.DEFAULT_OPTIONS.photoJitterPx).toBe(Layout.PHOTO_JITTER_PX);
  });

  it('separates rows by exactly 4 px (1 mm) when both jitters are neutral', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // both jitters resolve to 0

    const out = Layout.calculateLayout(series(8), {
      columns: 2,
      targetHeightCm: 10,
    });
    const height = Math.round(10 * PX_PER_CM); // 378
    const rows = rowsOf(out);

    expect(rows).toHaveLength(4);
    rows.forEach((row) => expect(row).toHaveLength(2));
    expect(out.map((p) => p.y)).toEqual([
      0, 0,
      height + 4, height + 4,
      2 * (height + 4), 2 * (height + 4),
      3 * (height + 4), 3 * (height + 4),
    ]);
    // The bare 4 px really is 1 mm on the row-to-row axis. rowDistances()
    // reports one distance per photo, i.e. 3 row gaps x 2 photos.
    expect(rowDistances(rows)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(Layout.ROW_GAP_PX).toBe(Math.round(1 * Layout.PX_PER_MM));
  });

  it('never overlaps 5+ rows and keeps every row distance inside [1, 8] px', () => {
    const Layout = loadLayout();

    for (const seed of [1, 42, 12345, 987654]) {
      vi.spyOn(Math, 'random').mockImplementation(mulberry32(seed));

      const out = Layout.calculateLayout(series(20), { columns: 4 });
      const rows = rowsOf(out);

      expect(rows).toHaveLength(5);
      rows.forEach((row) => expect(row).toHaveLength(4));

      for (const distance of rowDistances(rows)) {
        // Row gap (2..7 px) + per-photo jitter (-1..+1 px) => [1, 8] px, so a
        // zero or negative distance (touching / overlapping) is impossible.
        expect(distance).toBeGreaterThanOrEqual(1);
        expect(distance).toBeLessThanOrEqual(
          Layout.ROW_GAP_PX + Layout.JITTER_RANGE_PX + Layout.PHOTO_JITTER_PX
        );
      }

      // The per-photo jitter bands every single row to a 2 px spread ...
      for (const row of rows) {
        const ys = row.map((p) => p.y);
        expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(
          2 * Layout.PHOTO_JITTER_PX
        );
      }

      // ... and no pair of photos may ever touch, vertically or horizontally.
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
  });

  it('floors the inter-row distance at exactly 1 px at the low RNG extreme', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0); // row jitter -3, photo jitter -1

    const out = Layout.calculateLayout(series(10), { columns: 2 });
    const rows = rowsOf(out);

    // gap = max(2, 4 - 3) = 2 px, minus the next row's -1 px photo jitter.
    // 5 rows of 2 => 4 row gaps, each reported once per photo.
    expect(rows).toHaveLength(5);
    expect(rowDistances(rows)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(out.every((p) => p.y >= 0)).toBe(true); // never crosses the origin
  });

  it('reaches 1 mm + 3 px row jitter + 1 px photo jitter at the high extreme', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.999999); // both jitters maxed

    const out = Layout.calculateLayout(series(10), { columns: 2 });
    const height = Math.round(10 * PX_PER_CM);

    // gap = 4 + 3 = 7 px and every photo sits 1 px lower inside its row, so
    // each of the 4 row gaps measures exactly 8 px (once per photo).
    expect(rowDistances(rowsOf(out))).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    out.forEach((p, i) => {
      expect(p.y).toBe(1 + Math.floor(i / 2) * (height + 8));
    });
  });

  it('sanitizes junk rowGapPx / rowJitterPx / photoJitterPx to the defaults', () => {
    const Layout = loadLayout();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const out = Layout.calculateLayout(series(4), {
      columns: 2,
      rowGapPx: 'junk',
      rowJitterPx: NaN,
      photoJitterPx: undefined,
    });
    const height = Math.round(10 * PX_PER_CM);

    // Junk falls back to the published defaults, so the gap stays 4 px (1 mm).
    expect(out.map((p) => p.y)).toEqual([0, 0, height + 4, height + 4]);
  });
});

