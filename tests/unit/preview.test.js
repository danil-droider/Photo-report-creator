/**
 * preview.test.js — pure preview positioning math (v27.0).
 *
 * Runs the real preview.js in plain Node through the window shim. These tests
 * pin the parts that must stay identical to Stage 1 and Stage 2:
 *   - every Stage 1 rectangle is preserved unchanged;
 *   - the virtual sheet uses Excel's 64 x 20 px cell defaults;
 *   - the minimum desktop sheet is the 1280 x 720 (16:9) baseline;
 *   - bounds expand the sheet instead of clipping photos;
 *   - scaling multiplies coordinates without changing relative gaps;
 *   - fit/zoom math is clamped and stays focal-point stable.
 */
import { describe, it, expect } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

function loadPreview() {
  const win = {};
  loadWindiModule(win, 'preview.js');
  return win.Preview;
}

const LAYOUT = [
  { id: 0, originalName: 'a.jpg', x: 0, y: 0, width: 400, height: 378 },
  { id: 1, originalName: 'b.jpg', x: 404, y: 0, width: 400, height: 378 }
];

describe('Preview.createModel — exact Stage 1 geometry', () => {
  it('preserves every x/y/width/height value unchanged', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(LAYOUT, { width: 1200, height: 700 });

    expect(model.rects).toHaveLength(2);
    expect(model.rects[0]).toMatchObject({
      id: 0,
      originalName: 'a.jpg',
      x: 0,
      y: 0,
      width: 400,
      height: 378
    });
    expect(model.rects[1]).toMatchObject({
      id: 1,
      x: 404,
      y: 0,
      width: 400,
      height: 378
    });
  });

  it('uses Excel default cell geometry (64 x 20 px)', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(LAYOUT, { width: 1200, height: 700 });

    expect(model.cellWidth).toBe(64);
    expect(model.cellHeight).toBe(20);
    expect(model.rowHeaderWidth).toBe(44);
    expect(model.columnHeaderHeight).toBe(24);
  });

  it('keeps the minimum 1280 x 720 desktop sheet for a small layout', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(LAYOUT, { width: 1200, height: 700 });

    expect(model.columns).toBe(20);
    expect(model.rows).toBe(36);
    expect(model.sheetWidth).toBe(1280);
    expect(model.sheetHeight).toBe(720);
    expect(model.totalWidth).toBe(1280 + 44);
    expect(model.totalHeight).toBe(720 + 24);
  });

  it('expands the sheet to the real layout bounds instead of clipping', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(
      [{ x: 5000, y: 500, width: 100, height: 100 }],
      { width: 1200, height: 700 }
    );

    // ceil(5100 / 64) + 1 spare column = 81 columns x 64 = 5184 px.
    expect(model.columns).toBe(81);
    expect(model.sheetWidth).toBe(5184);
    // 600 px needs 31 rows, which is still below the 36-row desktop minimum.
    expect(model.rows).toBe(36);
    expect(model.sheetHeight).toBe(720);
  });

  it('ignores malformed entries without touching valid ones', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(
      [null, { x: 10, y: 20, width: 0, height: 100 }, LAYOUT[0]],
      { width: 1200, height: 700 }
    );

    expect(model.rects).toHaveLength(1);
    expect(model.rects[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 400,
      height: 378
    });
  });
});

describe('Preview.calculateFitScale', () => {
  it('picks the smaller viewport ratio and never magnifies beyond 1', () => {
    const Preview = loadPreview();
    const scale = Preview.calculateFitScale(
      { width: 1324, height: 744 },
      { width: 1200, height: 700 }
    );

    expect(scale).toBeCloseTo(Math.min(1200 / 1324, 700 / 744, 1), 10);
  });

  it('returns 1 when the sheet or viewport cannot be measured', () => {
    const Preview = loadPreview();
    expect(
      Preview.calculateFitScale({ width: 0, height: 0 }, { width: 1, height: 1 })
    ).toBe(1);
    expect(
      Preview.calculateFitScale({ width: 10, height: 10 }, { width: 0, height: 0 })
    ).toBe(1);
  });
});

describe('Preview scaling — relative gaps stay exact', () => {
  it('scales positions by direct multiplication, preserving the gap', () => {
    const Preview = loadPreview();
    const model = Preview.createModel(LAYOUT, { width: 1200, height: 700 });
    const scale = model.fitScale;

    const firstRight = model.rects[0].x + model.rects[0].width;
    const originalGap = model.rects[1].x - firstRight;
    const scaledFirstRight = (model.rects[0].x + model.rects[0].width) * scale;
    const scaledSecondLeft = model.rects[1].x * scale;

    expect(scaledFirstRight).toBeCloseTo(firstRight * scale, 10);
    expect(scaledSecondLeft - scaledFirstRight).toBeCloseTo(
      originalGap * scale,
      10
    );
    expect(originalGap).toBe(4);
  });
});

describe('Preview.zoomAtPoint — focal zoom', () => {
  it('keeps the content point under the same viewport point', () => {
    const Preview = loadPreview();
    const before = { scale: 1, scrollLeft: 100, scrollTop: 50 };
    const point = { x: 200, y: 100 };
    const after = Preview.zoomAtPoint(before, 2, point);

    // Content point before: (100 + 200) / 1 = 300; after: 300 * 2 - 200 = 400.
    expect(after.scale).toBe(2);
    expect(after.scrollLeft).toBeCloseTo(400, 10);
    expect(after.scrollTop).toBeCloseTo(200, 10);

    // Re-projecting the same content point lands back on the focal point.
    expect((after.scrollLeft + point.x) / after.scale).toBeCloseTo(300, 10);
    expect((after.scrollTop + point.y) / after.scale).toBeCloseTo(150, 10);
  });

  it('clamps to the supplied zoom limits', () => {
    const Preview = loadPreview();
    const low = Preview.zoomAtPoint(
      { scale: 1, scrollLeft: 0, scrollTop: 0 },
      0.001,
      { x: 0, y: 0 },
      { min: 0.25, max: 4 }
    );
    const high = Preview.zoomAtPoint(
      { scale: 1, scrollLeft: 0, scrollTop: 0 },
      99,
      { x: 0, y: 0 },
      { min: 0.25, max: 4 }
    );

    expect(low.scale).toBe(0.25);
    expect(high.scale).toBe(4);
  });
});

describe('Preview.getColumnName', () => {
  it('names columns A..Z, AA..', () => {
    const Preview = loadPreview();
    expect(Preview.getColumnName(0)).toBe('A');
    expect(Preview.getColumnName(25)).toBe('Z');
    expect(Preview.getColumnName(26)).toBe('AA');
    expect(Preview.getColumnName(27)).toBe('AB');
  });
});

