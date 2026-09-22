/**
 * layout.regression.test.js — golden-coordinate guard.
 *
 * Ports the byte-identical regression check from _selftest/selftest.html into
 * the fast Node tier: with Math.random() === 0 the gap formulas reduce to
 *   horizontal gap = 3 + 0 - 1 = 2 px                        (unchanged v6.4)
 *   row advance    = 378 + max(2, 4 + (0 - 3)) - 1 = 379 px  (v8.0 stack)
 *   height = 10 cm * 37.8 = 378 px, width = 378 * 800/600 = 504 px.
 * Any accidental change to the layout math fails here in milliseconds.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

function loadLayout() {
  const win = {};
  loadWindiModule(win, 'layout.js');
  return win.Layout;
}

describe('Layout.calculateLayout golden regression', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces the pinned coordinates of the v8.0 formulas', () => {
    const Layout = loadLayout();
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0);

    const out = Layout.calculateLayout(
      [
        { id: 0, originalName: 'a', width: 800, height: 600 },
        { id: 1, originalName: 'b', width: 800, height: 600 },
        { id: 2, originalName: 'c', width: 800, height: 600 },
        { id: 3, originalName: 'd', width: 800, height: 600 },
      ],
      { columns: 2, targetHeightCm: 10 }
    );

    expect(spy).toHaveBeenCalled();
    expect(out.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [506, 0],
      [0, 379],
      [506, 379],
    ]);
    expect(out.every((p) => p.width === 504 && p.height === 378)).toBe(true);
  });

  it('keeps the published DEFAULT_OPTIONS contract', () => {
    const Layout = loadLayout();
    expect(Layout.DEFAULT_OPTIONS).toMatchObject({
      columns: 4, // v18.0 — matches the expanded stepper default
      targetHeightCm: 10,
      horizontalBaseGapPx: 3,
      gapRandomPx: 5,
      gapJitterPx: 1,
      // v8.0 — the vertical contract: rows are 1 mm apart (4 px) with +/-3 px
      // of row jitter and +/-1 px of per-photo jitter. baseGapPx and
      // verticalGapPx are gone with the old gap stack.
      rowGapPx: 4,
      rowJitterPx: 3,
      photoJitterPx: 1,
      pxPerCm: 37.8,
      startX: 0,
      startY: 0,
    });
    expect(Layout.VERSION).toMatch(/^v\d+\.\d+$/);
  });
});
