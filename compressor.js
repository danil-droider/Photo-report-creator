/**
 * compressor.js — Target-size JPEG compression engine
 *
 * Version: v7.0
 *
 * Owns the Canvas preprocessing stage AND the JPEG quality tuning:
 *   1. Downscale so the width never exceeds MAX_WIDTH (aspect preserved).
 *   2. Normalize EXIF orientation by drawing the <img> onto the canvas
 *      (Safari bakes the orientation in natively on draw).
 *   3. Pick a random target byte size per photo inside the user's KB range and
 *      binary-search the toBlob(..., 'image/jpeg', quality) parameter until the
 *      encoded Blob lands on that target.
 *
 * STRICT CONSTRAINT: this file performs NO layout math and NO Excel work.
 * It returns a plain { blob, width, height, bytes, quality, targetBytes,
 * encoding } record that app.js forwards to Stage 1 / Stage 2 unchanged.
 */
(function (global) {
  'use strict';

  const VERSION = 'v7.0';

  const MAX_WIDTH = 800;          // px — uniform downscale target width.
  const DEFAULT_MIN_KB = 80;      // default lower bound of the target range.
  const DEFAULT_MAX_KB = 220;     // default upper bound of the target range.

  const QUALITY_MIN = 0.15;       // hard floor — prevents severe pixelation.
  const QUALITY_MAX = 0.95;       // hard ceiling — best quality we will try.
  const MAX_ITERATIONS = 7;       // binary-search encode budget.
  const TOLERANCE = 0.10;         // "hit" = within ±10% of the randomized target.
  const MIN_QUALITY_STEP = 0.01;  // stop searching once the bracket collapses.

  const BYTES_PER_KB = 1024;

  // Positive finite number, otherwise fallback.
  function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function formatKB(bytes) {
    return (bytes / BYTES_PER_KB).toFixed(1);
  }

  /**
   * Load a File into an HTMLImageElement via an object URL.
   * The object URL is revoked once the image has decoded (or failed).
   */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to decode image: ${file.name}`));
      };

      img.src = url;
    });
  }

  // Encode the current canvas content as a JPEG at the given quality.
  function encode(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error('Canvas encoding failed.')),
        'image/jpeg',
        quality
      );
    });
  }

  // Resolve + sanitize the requested KB range (swapped when inverted).
  function resolveRange(options) {
    const opts = options || {};
    let minKB = positiveNumber(opts.minKB, DEFAULT_MIN_KB);
    let maxKB = positiveNumber(opts.maxKB, DEFAULT_MAX_KB);

    if (minKB > maxKB) {
      const swap = minKB;
      minKB = maxKB;
      maxKB = swap;
    }

    return { minKB: minKB, maxKB: maxKB };
  }

  // Uniform random target inside [minKB, maxKB] (inclusive), returned in bytes.
  function randomTargetBytes(minKB, maxKB) {
    const minBytes = Math.round(minKB * BYTES_PER_KB);
    const maxBytes = Math.round(maxKB * BYTES_PER_KB);
    return minBytes + Math.floor(Math.random() * (maxBytes - minBytes + 1));
  }

  /**
   * Draw the source photo onto a fresh canvas exactly once: downscale to
   * `maxWidth` and bake EXIF orientation via drawImage. The canvas is reused
   * for every encode of the quality search — only the JPEG quality parameter
   * changes, never the pixel content.
   */
  async function prepareCanvas(file, maxWidth) {
    const img = await loadImage(file);

    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error(`No intrinsic dimensions: ${file.name}`);
    }

    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable.');

    // Drawing the <img> bakes EXIF orientation in natively (Safari normalizes
    // orientation on draw), so no manual rotation math is required here.
    ctx.drawImage(img, 0, 0, width, height);

    return { canvas: canvas, width: width, height: height };
  }

  function logResult(name, photo) {
    console.log(
      `[${name}] Target: ${formatKB(photo.targetBytes)} KB -> ` +
        `Final: ${formatKB(photo.bytes)} KB @ Quality: ${photo.quality.toFixed(2)}`
    );
  }

  /**
   * compressToTarget
   *
   * @param {File}   file    - the raw uploaded photo.
   * @param {Object} options - { minKB, maxKB, maxWidth }
   * @returns {Promise<Object>} { blob, width, height, bytes, quality,
   *                             targetBytes, encoding }
   *
   * encoding values:
   *   'target'      - landed within +-10% of the randomized target (otherwise
   *                   the closest size achievable inside the KB range).
   *   'too-simple'  - Fallback A: even at QUALITY_MAX the image stays below
   *                   minKB (e.g. a solid colour); accepted, never failed.
   *   'too-complex' - Fallback B: even at QUALITY_MIN the image exceeds maxKB;
   *                   clamped to QUALITY_MIN to avoid severe pixelation.
   */
  async function compressToTarget(file, options) {
    const opts = options || {};
    const range = resolveRange(opts);
    const maxWidth = positiveNumber(opts.maxWidth, MAX_WIDTH);

    const targetBytes = randomTargetBytes(range.minKB, range.maxKB);
    const minBytes = Math.round(range.minKB * BYTES_PER_KB);
    const maxBytes = Math.round(range.maxKB * BYTES_PER_KB);

    const prepared = await prepareCanvas(file, maxWidth);

    // The first encode runs at the hard ceiling and doubles as the initial
    // best candidate, so the search never encodes above QUALITY_MAX.
    const ceilingBlob = await encode(prepared.canvas, QUALITY_MAX);
    let best = {
      blob: ceilingBlob,
      bytes: ceilingBlob.size,
      quality: QUALITY_MAX,
      encoding: 'target'
    };
    let result;

    if (ceilingBlob.size < minBytes) {
      // Fallback A - too simple to reach the minimum size: accept the image at
      // max quality instead of failing it.
      best.encoding = 'too-simple';
      result = best;
    } else {
      // Binary search on quality. JPEG size grows monotonically with quality,
      // so the target size stays inside the bracket [lo, hi] while it shrinks.
      let lo = QUALITY_MIN;
      let hi = QUALITY_MAX;
      let hit = null;

      for (let i = 0; i < MAX_ITERATIONS && hi - lo >= MIN_QUALITY_STEP; i++) {
        const quality = (lo + hi) / 2;
        const blob = await encode(prepared.canvas, quality);
        const candidate = {
          blob: blob,
          bytes: blob.size,
          quality: quality,
          encoding: 'target'
        };

        // Always keep the closest candidate seen so far: browser encoders are
        // only approximately monotonic, so a single probe may overshoot.
        if (
          Math.abs(candidate.bytes - targetBytes) <
          Math.abs(best.bytes - targetBytes)
        ) {
          best = candidate;
        }

        if (Math.abs(candidate.bytes - targetBytes) <= TOLERANCE * targetBytes) {
          hit = candidate;
          break;
        }

        if (candidate.bytes > targetBytes) {
          hi = quality;
        } else {
          lo = quality;
        }
      }

      if (hit) {
        result = hit;
      } else if (best.bytes > maxBytes) {
        // Fallback B - too complex to reach the maximum size: stop at the
        // quality floor to prevent severe pixelation/artifacts.
        const floorBlob = await encode(prepared.canvas, QUALITY_MIN);
        result = {
          blob: floorBlob,
          bytes: floorBlob.size,
          quality: QUALITY_MIN,
          encoding: 'too-complex'
        };
      } else {
        result = best;
      }
    }

    const photo = {
      blob: result.blob,
      width: prepared.width,
      height: prepared.height,
      bytes: result.bytes,
      quality: result.quality,
      targetBytes: targetBytes,
      encoding: result.encoding
    };

    logResult(file.name, photo);

    if (photo.encoding === 'too-simple') {
      console.warn(
        `[compressor] ${file.name} stays under ${range.minKB} KB even at ` +
          `quality ${QUALITY_MAX} - accepted as-is.`
      );
    } else if (photo.encoding === 'too-complex') {
      console.warn(
        `[compressor] ${file.name} exceeds ${range.maxKB} KB even at quality ` +
          `${QUALITY_MIN} - clamped to the quality floor.`
      );
    }

    return photo;
  }

  global.Compressor = {
    VERSION: VERSION,
    MAX_WIDTH: MAX_WIDTH,
    DEFAULT_MIN_KB: DEFAULT_MIN_KB,
    DEFAULT_MAX_KB: DEFAULT_MAX_KB,
    QUALITY_MIN: QUALITY_MIN,
    QUALITY_MAX: QUALITY_MAX,
    TOLERANCE: TOLERANCE,
    MAX_ITERATIONS: MAX_ITERATIONS,
    resolveRange: resolveRange,
    compressToTarget: compressToTarget
  };
})(window);
