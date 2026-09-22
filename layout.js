/**
 * layout.js — Stage 1 (Layout)
 *
 * Version: v8.0
 *
 * Pure data/math only. Computes the FULL layout — which photo goes at
 * which X/Y pixel coordinate — with randomized spacing between photos.
 *
 * v8.0 — 1 MM INTER-ROW GAP + HYBRID VERTICAL JITTER. The old vertical gap
 * stack (baseGapPx + random offset + micro-jitter + a 14 px "safety" gap) is
 * gone. A row transition now advances by:
 *     ROW_GAP_PX + row-level jitter, floored at MIN_ROW_GAP_PX
 * where ROW_GAP_PX = Math.round(1 mm * 3.7795 px/mm) = 4 px, so consecutive
 * rows sit one REAL millimetre apart at the CSS/print reference density
 * (96 DPI). The row-level jitter is a uniform integer in [-3, +3] px, so the
 * effective gap lands in [2, 7] px. Each photo is ADDITIONALLY shifted inside
 * its own row by a per-photo jitter of [-1, +1] px.
 * Zero overlap is preserved: the next row starts below the REAL bottom edge of
 * the previous row (rowMaxBottom — the lowest photo of that row) and the 2 px
 * gap floor absorbs the next row's -1 px upward jitter, so the closest
 * possible distance between photos of adjacent rows is exactly 1 px
 * (strictly positive — they can never touch or overlap).
 * The X axis is untouched: horizontal gaps, the column count, the landscape
 * cap and the uniform target height keep their exact previous behaviour.
 *
 * v7.4 — the columns clamp widens from [1, 10] to [1, 15] so Stage 1 honours
 * every stop the expanded stepper markup (v18.0) can emit, and the junk-input
 * fallback moves to the new app default (4 columns). Everything else — the
 * landscape cap (Math.min(maxLandscapePerRow, columns)), the HORIZONTAL gap
 * stack and the H_px = H_cm × 37.8 conversion, which already accepts any
 * height in the 6–24 cm stepper range — is untouched.
 *
 * v7.3 — landscape capacity cap: horizontal photos (width > height) may never
 * put more than `maxLandscapePerRow` entries (default 3) into one row, and
 * never more than the user's configured `columns`, so a lower setting (1 or 2)
 * always wins. The cap is a HARD wrap: it fires right after the 3rd landscape
 * photo has been placed, so the next photo opens a new row even when it is a
 * portrait. Portrait and square photos keep the plain `columns` behaviour.
 *
 * STRICT CONSTRAINT: this file must NEVER touch Excel/ExcelJS, the DOM,
 * canvas, or file reading. It receives plain metadata + an options object
 * and returns a plain data array. No repositioning happens outside here.
 */
(function (global) {
  'use strict';

  // --- v8.0 vertical gap constants -----------------------------------------
  // 1 mm at the CSS/print reference density (96 px per inch => 3.7795 px/mm),
  // rounded to whole pixels because every coordinate here is an integer.
  // Deliberately declared BEFORE DEFAULT_OPTIONS, which reads ROW_GAP_PX.
  const PX_PER_MM = 3.7795;
  const ROW_GAP_MM = 1;
  const ROW_GAP_PX = Math.round(ROW_GAP_MM * PX_PER_MM); // = 4 px

  // Row-level jitter: a uniform integer in [-3, +3] px around the 1 mm base.
  const JITTER_RANGE_PX = 3;

  // Per-photo jitter: a uniform integer in [-1, +1] px inside the row.
  const PHOTO_JITTER_PX = 1;

  // Hard floor for the inter-row gap. 2 px = the 1 px minimum distance the
  // spec demands PLUS the 1 px a photo may travel upward inside the next row;
  // with a 1 px floor the two photos would merely touch.
  const MIN_ROW_GAP_PX = 2;

  const DEFAULT_OPTIONS = {
    columns: 4,              // v7.4: matches the v18.0 stepper default
    targetHeightCm: 10,
    maxLandscapePerRow: 3,   // v7.3: hard cap on HORIZONTAL photos per row
    horizontalBaseGapPx: 3,  // v6.4: horizontal-only base gap (was 4 -> 3, -1px)
    gapRandomPx: 5,          // extra random HORIZONTAL gap offset (0..5 px)
    gapJitterPx: 1,          // horizontal micro-randomization: -1 / 0 / +1 px
    rowGapPx: ROW_GAP_PX,    // v8.0: strict 1 mm inter-row gap (4 px)
    rowJitterPx: JITTER_RANGE_PX,     // v8.0: row-level vertical jitter (-3..+3 px)
    photoJitterPx: PHOTO_JITTER_PX,   // v8.0: per-photo jitter in a row (-1..+1 px)
    pxPerCm: 37.8,           // 1 cm = 37.8 px
    startX: 0,               // left origin (px)
    startY: 0                // top origin (px)
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

  // Hard floor for the HORIZONTAL gaps (unchanged v6.x behaviour): gaps must
  // stay strictly positive so randomization can never produce touching or
  // overlapping photos (no negative spacing).
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
   *   - Vertical Y advances below the REAL bottom edge of the preceding row
   *     (its lowest photo) + a strict 1 mm gap + row jitter (v8.0), so no two
   *     photos can ever touch or overlap.
   *   - v7.3: a row additionally wraps as soon as `min(maxLandscapePerRow,
   *     columns)` LANDSCAPE photos (width > height) have been placed in it, so
   *     horizontal photos can never exceed 3 per row unless the user asked for
   *     fewer columns. Portrait/square photos are never counted against it.
   *
   * v10.0 ORDER CONTRACT: the input array order IS the layout order. Index 0
   * lands at the top-left (startX/startY — the oldest photo on screen) and
   * index N ends at the bottom-right (the newest), because the loop below is a
   * single unconditional pass over the array. Nothing here may sort, group or
   * reorder: no filename/date sorting, no grouping by orientation or size.
   *
   * @param {Array}  processedImages - [{ id, originalName, width, height }]
   * @param {Object} options - { columns, targetHeightCm, maxLandscapePerRow, horizontalBaseGapPx, gapRandomPx, gapJitterPx, rowGapPx, rowJitterPx, photoJitterPx, pxPerCm, startX, startY }
   * @returns {Array} - [{ id, originalName, x, y, width, height }]
   */
  function calculateLayout(processedImages, options) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, options || {});

    const columns = intInRange(opts.columns, 1, 15, DEFAULT_OPTIONS.columns);

    // v7.3 — the effective landscape capacity is the smaller of the hard cap
    // (default 3) and the user's own row capacity, so a configured 1 or 2 is
    // respected instead of being widened to 3.
    const maxLandscapePerRow = intInRange(
      opts.maxLandscapePerRow,
      1,
      10,
      DEFAULT_OPTIONS.maxLandscapePerRow
    );
    const landscapeCapPerRow = Math.min(maxLandscapePerRow, columns);

    const pxPerCm = positiveNumber(opts.pxPerCm, DEFAULT_OPTIONS.pxPerCm);
    const targetHeightCm = positiveNumber(
      opts.targetHeightCm,
      DEFAULT_OPTIONS.targetHeightCm
    );
    // v6.4 — the horizontal gap stack (base + random offset + jitter) keeps its
    // own parameters; v8.0 replaced the VERTICAL stack with the three row
    // numbers below, so the old baseGapPx / verticalGapPx options are gone.
    const horizontalBaseGapPx = intInRange(
      opts.horizontalBaseGapPx,
      0,
      1000,
      DEFAULT_OPTIONS.horizontalBaseGapPx
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
    // v8.0 — the row stack is driven by three plain pixel numbers, all
    // sanitized through the shared clamping helper (junk => published default).
    const rowGapPx = intInRange(
      opts.rowGapPx,
      0,
      1000,
      DEFAULT_OPTIONS.rowGapPx
    );
    const rowJitterPx = intInRange(
      opts.rowJitterPx,
      0,
      100,
      DEFAULT_OPTIONS.rowJitterPx
    );
    const photoJitterPx = intInRange(
      opts.photoJitterPx,
      0,
      10,
      DEFAULT_OPTIONS.photoJitterPx
    );
    const startX = nonNegativeNumber(opts.startX, 0);
    const startY = nonNegativeNumber(opts.startY, 0);

    const targetHeightPx = Math.max(1, Math.round(targetHeightCm * pxPerCm));

    const images = Array.isArray(processedImages) ? processedImages : [];
    const layout = [];

    let col = 0;
    let landscapeInRow = 0; // v7.3: horizontal photos placed in the current row
    let x = startX;
    let y = startY;
    let rowMaxBottom = 0; // v8.0: REAL bottom edge of the current row

    images.forEach((img) => {
      const aspect =
        img && img.width > 0 && img.height > 0 ? img.width / img.height : 1;
      const width = Math.max(1, Math.round(targetHeightPx * aspect));

      // v7.3 — only genuine horizontal photos count against the landscape cap:
      // portrait, square and degenerate (0 / missing) dimensions do not.
      const isLandscape =
        !!img && img.width > 0 && img.height > 0 && img.width > img.height;

      // v8.0 — per-photo vertical jitter inside the row: a uniform integer in
      // [-1, +1] px. The clamp keeps the top row from crossing the origin, since
      // a negative y would become an out-of-grid Excel anchor in Stage 2.
      const photoY = Math.max(startY, y + microJitter(photoJitterPx));

      layout.push({
        id: img && img.id !== undefined ? img.id : layout.length,
        originalName:
          img && img.originalName !== undefined ? img.originalName : '',
        x: x,
        y: photoY,
        width: width,
        height: targetHeightPx
      });

      // v8.0 — the row's bottom edge is tracked from the PLACED y (jitter
      // included), never from the nominal target height alone.
      rowMaxBottom = Math.max(rowMaxBottom, photoY + targetHeightPx);
      col += 1;
      if (isLandscape) landscapeInRow += 1;

      // v7.3 — the row is done when the user's column limit is reached OR when
      // it already holds `landscapeCapPerRow` horizontal photos. The landscape
      // branch is a HARD wrap: it fires right after that photo is placed, so
      // the next photo opens a new row even when it is a portrait.
      if (col < columns && landscapeInRow < landscapeCapPerRow) {
        // Advance right within the same row: previous width + a fresh gap.
        // v6.4: horizontal spacing uses its own base (4 -> 3 px, -1px). The
        // randomization parameters (gapRandomPx + gapJitterPx) are UNCHANGED,
        // so horizontal gaps remain variable between images. The vertical
        // row-wrap below is owned by v8.0 (strict 1 mm gap + jitter) and never
        // touches this horizontal run.
        x += width + randomGap(horizontalBaseGapPx, gapRandomPx, gapJitterPx);
      } else {
        // Wrap (v8.0): the next row starts strictly below the REAL bottom edge
        // of this row — rowMaxBottom, i.e. the lowest photo of the row with its
        // own jitter already applied — plus the strict 1 mm inter-row gap and
        // the row-level jitter. This increment runs UNCONDITIONALLY on every row
        // transition (row 1, 2, 3, … N) and accumulates on the current `y`, so
        // the clearance is uniform across ALL subsequent rows.
        //   gapPx  = max(2, rowGapPx + jitter(-3..+3))  => [2, 7] px
        //   y_next = rowMaxBottom + gapPx
        x = startX;
        y = rowMaxBottom + Math.max(MIN_ROW_GAP_PX, rowGapPx + microJitter(rowJitterPx));
        col = 0;
        landscapeInRow = 0; // v7.3: the landscape budget is per row
        rowMaxBottom = 0;
      }
    });

    return layout;
  }

  global.Layout = {
    VERSION: 'v8.0',
    calculateLayout: calculateLayout,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    // v8.0 — published gap constants: the strict 1 mm inter-row gap and the
    // jitter bounds, so callers and tests assert against the same numbers the
    // layout math uses instead of re-declaring magic values.
    ROW_GAP_MM: ROW_GAP_MM,
    PX_PER_MM: PX_PER_MM,
    ROW_GAP_PX: ROW_GAP_PX,
    JITTER_RANGE_PX: JITTER_RANGE_PX,
    PHOTO_JITTER_PX: PHOTO_JITTER_PX,
    MIN_ROW_GAP_PX: MIN_ROW_GAP_PX
  };
})(window);
