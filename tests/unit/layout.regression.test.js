/**
 * layout.regression.test.js — golden-coordinate guard.
 *
 * Ports the byte-identical regression check from _selftest/selftest.html into
 * the fast Node tier: with Math.random() === 0 the v6.4 gap formulas reduce to
 *   horizontal gap = 3 + 0 - 1 = 2 px
 *   vertical gap   = 4 + 0 - 1 = 3 px (+ 14 px safety) = 395 px row advance
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

  it('produces byte-identical coordinates to the v6.4 formulas', () => {
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
      [0, 395],
      [506, 395],
    ]);
    expect(out.every((p) => p.width === 504 && p.height === 378)).toBe(true);
  });

  it('keeps the published DEFAULT_OPTIONS contract', () => {
    const Layout = loadLayout();
    expect(Layout.DEFAULT_OPTIONS).toMatchObject({
      columns: 2,
      targetHeightCm: 10,
      baseGapPx: 4,
      horizontalBaseGapPx: 3,
      gapRandomPx: 5,
      gapJitterPx: 1,
      verticalGapPx: 14,
      pxPerCm: 37.8,
      startX: 0,
      startY: 0,
    });
    expect(Layout.VERSION).toMatch(/^v\d+\.\d+$/);
  });
});
