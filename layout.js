/**
 * layout.js — Stage 1 (Layout)
 *
 * Version: v7.0
 *
 * Pure data/math only. Computes the FULL layout — which photo goes at
 * which X/Y pixel coordinate — with randomized spacing between photos.
 *
 * STRICT CONSTRAINT: this file must NEVER touch Excel/ExcelJS, the DOM,
 * canvas, or file reading. It receives plain metadata + an options object
 * and returns a plain data array. No repositioning happens outside here.
 */
(function (global) {
  'use strict';

  const DEFAULT_OPTIONS = {
    columns: 2,
    targetHeightCm: 10,
    baseGapPx: 4,            // ~1 mm base gap — vertical row stack
    horizontalBaseGapPx: 3,  // v6.4: horizontal-only base gap (was 4 → 3, -1px)
    gapRandomPx: 5,          // extra random gap offset (0..5 px)
    gapJitterPx: 1,          // micro-randomization: -1 / 0 / +1 px around each gap
    verticalGapPx: 14,   // ~3.7 mm explicit safety gap between rows
    pxPerCm: 37.8,       // 1 cm ≈ 37.8 px
    startX: 0,           // left origin (px)
    startY: 0            // top origin (px)
  };

  // Positive finite number, otherwise fallback.
  function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  // Finite number allowed to be 0, otherwise fallback.
  function nonNegativeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  // Integer clamped to [min, max], otherwise fallback.
  function intInRange(value, min, max, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  }

  // Hard floor: gaps must stay strictly positive so randomization can never
  // produce touching or overlapping photos (no negative spacing).
  const MIN_GAP_PX = 1;

  // Micro-jitter: a uniform integer in [-jitterPx, +jitterPx] (i.e. -1/0/+1
  // when jitterPx = 1). jitterPx = 0 disables micro-randomization entirely.
  function microJitter(jitterPx) {
    return Math.floor(Math.random() * (2 * jitterPx + 1)) - jitterPx;
  }

  // Base gap + a uniform offset in [0, gapRandomPx] + micro-jitter, floored at
  // MIN_GAP_PX so randomization can never produce touching/overlapping photos.
  function randomGap(baseGapPx, gapRandomPx, jitterPx) {
    const offset = Math.floor(Math.random() * (gapRandomPx + 1));
    return Math.max(MIN_GAP_PX, baseGapPx + offset + microJitter(jitterPx));
  }

  /**
   * calculateLayout
   *
   * Places photos left-to-right, wrapping after `columns` photos per row.
   *   - Every photo keeps a uniform height equal to the target height in px,
   *     with a width scaled to preserve its aspect ratio.
   *   - Horizontal X is cumulative: previous widths + randomized gaps.
   *   - Vertical Y advances strictly below the tallest image of the preceding
   *     row (+ randomized gap), guaranteeing zero overlap.
   *
   * @param {Array}  processedImages - [{ id, originalName, width, height }]
   * @param {Object} options - { columns, targetHeightCm, baseGapPx, horizontalBaseGapPx, gapRandomPx, gapJitterPx, pxPerCm, startX, startY }
   * @returns {Array} - [{ id, originalName, x, y, width, height }]
   */
  function calculateLayout(processedImages, options) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});

    const columns = intInRange(opts.columns, 1, 10, DEFAULT_OPTIONS.columns);
    const pxPerCm = positiveNumber(opts.pxPerCm, DEFAULT_OPTIONS.pxPerCm);
    const targetHeightCm = positiveNumber(
      opts.targetHeightCm,
      DEFAULT_OPTIONS.targetHeightCm
    );
    const baseGapPx = intInRange(opts.baseGapPx, 0, 1000, DEFAULT_OPTIONS.baseGapPx);
    const horizontalBaseGapPx = intInRange(
      opts.horizontalBaseGapPx,
      0,
      1000,
      DEFAULT_OPTIONS.horizontalBaseGapPx
    );
    const verticalGapPx = intInRange(
      opts.verticalGapPx,
      0,
      1000,
      DEFAULT_OPTIONS.verticalGapPx
    );
    const gapRandomPx = intInRange(
      opts.gapRandomPx,
      0,
      1000,
      DEFAULT_OPTIONS.gapRandomPx
    );
    const gapJitterPx = intInRange(
      opts.gapJitterPx,
      0,
      100,
      DEFAULT_OPTIONS.gapJitterPx
    );
    const startX = nonNegativeNumber(opts.startX, 0);
    const startY = nonNegativeNumber(opts.startY, 0);

    const targetHeightPx = Math.max(1, Math.round(targetHeightCm * pxPerCm));

    const images = Array.isArray(processedImages) ? processedImages : [];
    const layout = [];

    let col = 0;
    let x = startX;
    let y = startY;
    let rowMaxHeight = 0;

    images.forEach((img) => {
      const aspect =
        img && img.width > 0 && img.height > 0 ? img.width / img.height : 1;
      const width = Math.max(1, Math.round(targetHeightPx * aspect));

      layout.push({
        id: img && img.id !== undefined ? img.id : layout.length,
        originalName:
          img && img.originalName !== undefined ? img.originalName : '',
        x: x,
        y: y,
        width: width,
        height: targetHeightPx
      });

      rowMaxHeight = Math.max(rowMaxHeight, targetHeightPx);
      col += 1;

      if (col < columns) {
        // Advance right within the same row: previous width + a fresh gap.
        // v6.4: horizontal spacing uses its own base (4 -> 3 px, -1px). The
        // randomization parameters (gapRandomPx + gapJitterPx) are UNCHANGED,
        // so horizontal gaps remain variable between images. The vertical
        // row-wrap below deliberately keeps `baseGapPx` so the v6.1/v6.2
        // zero-overlap band is preserved byte-for-byte.
        x += width + randomGap(horizontalBaseGapPx, gapRandomPx, gapJitterPx);
      } else {
        // Wrap: next row begins strictly below the tallest image in this row,
        // plus the accumulated gap stack: rowMaxHeight + randomized gap +
        // micro-jitter + safety vertical gap. This increment runs UNCONDITIONALLY
        // on every row transition (row 1, 2, 3, … N) and accumulates on the
        // current `y`, so clearance is uniform across ALL subsequent rows.
        //   y_next = current_y + rowMaxHeight + gapPx + microJitter + verticalGapPx
        x = startX;
        y += rowMaxHeight + randomGap(baseGapPx, gapRandomPx, gapJitterPx) + verticalGapPx;
        col = 0;
        rowMaxHeight = 0;
      }
    });

    return layout;
  }

  global.Layout = {
    VERSION: 'v7.0',
    calculateLayout: calculateLayout,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS
  };
})(window);
