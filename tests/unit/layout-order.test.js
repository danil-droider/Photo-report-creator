/**
 * layout-order.test.js — Stage 1 sequence contract (v10.0).
 *
 * Pins the ONE ordering promise the whole app rests on: the array of processed
 * photos rendered on the main screen IS the layout order. Array index 0 is the
 * top-left (oldest) photo, index N is the bottom-right (newest) one, and every
 * index in between is placed strictly left-to-right, row by row.
 *
 * layout.js implements this by an unconditional forEach over the input array,
 * so what these tests really guard is that nothing ever sneaks in a re-sort, a
 * grouping by orientation/size, or an early row break. Runs in plain Node
 * against the real layout.js.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

function loadLayout() {
  const win = {};
  loadWindiModule(win, 'layout.js');
  return win.Layout;
}

/** Deterministic gaps + micro-jitter: randomGap() then always yields the floor. */
function freezeRandom() {
  vi.spyOn(Math, 'random').mockReturnValue(0);
}

/** `count` photos named after their index, with deliberately mixed aspects. */
function photoSequence(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    originalName: `Photo_${i}`,
    // 0.75, 1, 1.33, 0.75, ... — widths jitter so a size-based re-sort would
    // visibly break the left-to-right run.
    width: 600 + (i % 3) * 100,
    height: 800,
  }));
}

/**
 * Walk the layout and assert the row-major invariants:
 *   - a row holds exactly `columns` photos, except possibly the last one;
 *   - inside a row x strictly increases at an unchanged y;
 *   - a wrap lands back on `startX` on a strictly larger y.
 *
 * @returns {Array<Array<Object>>} the entries grouped into rows.
 */
function expectRowMajor(out, columns, startX) {
  const rows = [[]];

  for (let i = 0; i < out.length; i++) {
    const cur = out[i];

    if (i > 0) {
      const prev = out[i - 1];
      if (cur.y > prev.y) {
        // Wrap: left origin again, and only after a full row.
        expect(cur.x).toBe(startX);
        if (columns > 1) expect(prev.x).toBeGreaterThan(startX);
        rows.push([]);
      } else {
        // Same row: strictly to the right.
        expect(cur.y).toBe(prev.y);
        expect(cur.x).toBeGreaterThan(prev.x);
      }
    }

    rows[rows.length - 1].push(cur);
  }

  rows.forEach((row, k) => {
    expect(row.length).toBeLessThanOrEqual(columns);
    if (k < rows.length - 1) expect(row).toHaveLength(columns);
  });

  return rows;
}

describe('Layout.calculateLayout — v10.0 array-index order contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the processed-photo array order: index 0 first, index N last', () => {
    freezeRandom();
    const Layout = loadLayout();
    const photos = photoSequence(7);

    const out = Layout.calculateLayout(photos, { columns: 3 });

    expect(out.map((p) => p.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.map((p) => p.originalName)).toEqual(
      photos.map((p) => p.originalName)
    );
    expect(out).toHaveLength(photos.length);
  });

  it('never re-sorts by filename — only the array index decides', () => {
    freezeRandom();
    const Layout = loadLayout();
    // Newest-first, non-natural names: any internal sorting would reorder these.
    const names = ['IMG_4501.jpg', 'IMG_4400.jpg', 'photo_10.jpg', 'photo_2.jpg'];
    const photos = names.map((originalName, i) => ({
      id: i,
      originalName,
      width: 800,
      height: 600,
    }));

    const out = Layout.calculateLayout(photos, { columns: 2 });

    expect(out.map((p) => p.originalName)).toEqual(names);
  });

  it('places index 0 at the top-left origin (oldest photo first)', () => {
    freezeRandom();
    const Layout = loadLayout();

    const out = Layout.calculateLayout(photoSequence(5), {
      columns: 3,
      startX: 25,
      startY: 40,
    });

    expect(out[0]).toMatchObject({ id: 0, x: 25, y: 40 });
  });

  it('writes row 1 left-to-right, then row 2 left-to-right (columns: 3)', () => {
    freezeRandom();
    const Layout = loadLayout();

    const out = Layout.calculateLayout(photoSequence(7), { columns: 3 });
    const rows = expectRowMajor(out, 3, 0);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.map((p) => p.id))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6],
    ]);
    expect(rows[1][0].y).toBeGreaterThan(rows[0][0].y);
    expect(rows[2][0].y).toBeGreaterThan(rows[1][0].y);
  });

  it('wraps exactly every `columns` photos for every supported column count', () => {
    freezeRandom();
    const Layout = loadLayout();
    const total = 16;

    // v18.0 — the supported column count now spans 1–15.
    for (const columns of [1, 2, 3, 4, 6, 15]) {
      const out = Layout.calculateLayout(photoSequence(total), { columns });
      const rows = expectRowMajor(out, columns, 0);

      expect(out.map((p) => p.id)).toEqual(
        Array.from({ length: total }, (_, i) => i)
      );
      expect(rows).toHaveLength(Math.ceil(total / columns));
      expect(rows[rows.length - 1]).toHaveLength(
        total - columns * (rows.length - 1)
      );
    }
  });

  it('assigns positions by index, never by photo size', () => {
    freezeRandom();
    const Layout = loadLayout();
    // Widths are non-monotonic; the x run must still be strictly increasing.
    const photos = [
      { id: 0, width: 1200, height: 800 },
      { id: 1, width: 600, height: 800 },
      { id: 2, width: 1600, height: 800 },
    ];

    const out = Layout.calculateLayout(photos, { columns: 3 });

    expect(out.map((p) => p.width)).toEqual([
      Math.round(378 * 1.5),
      Math.round(378 * 0.75),
      Math.round(378 * 2),
    ]);
    expect(out[1].x).toBeGreaterThan(out[0].x);
    expect(out[2].x).toBeGreaterThan(out[1].x);
  });

  it('ends on the bottom-right slot when the last row is full', () => {
    freezeRandom();
    const Layout = loadLayout();

    const out = Layout.calculateLayout(photoSequence(6), { columns: 3 });
    const last = out[out.length - 1];

    expect(last.id).toBe(5);
    expect(last.y).toBe(Math.max(...out.map((p) => p.y))); // bottom-most row
    expect(last.x).toBe(Math.max(...out.map((p) => p.x))); // right-most column
  });

  it('keeps a partial last row left-aligned (newest photo, first column)', () => {
    freezeRandom();
    const Layout = loadLayout();

    const out = Layout.calculateLayout(photoSequence(7), { columns: 3 });
    const last = out[out.length - 1];

    expect(last.id).toBe(6);
    expect(last.y).toBe(Math.max(...out.map((p) => p.y))); // bottom-most row
    expect(last.x).toBe(0); // ...at the left origin, since row 3 holds one photo
  });
});
