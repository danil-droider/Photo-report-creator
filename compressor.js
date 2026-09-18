/**
 * compressor.js — Target-size JPEG compression engine
 *
 * Version: v7.2
 *
 * Owns the Canvas preprocessing stage AND the JPEG quality tuning:
 *   1. Bake EXIF orientation into a canvas (Safari normalizes orientation on
 *      draw). 'auto' strategy: full source resolution up to 4 MP, otherwise
 *      capped at max(2 * MAX_WIDTH, 1600) px, so a 12-48 MP iPhone photo can
 *      never exceed the iOS canvas area/memory limit.
 *   2. Downscale that canvas to MAX_WIDTH with pica.js (Lanczos3 via wasm) for
 *      high-fidelity resampling - no colour bleeding or pixel aliasing. Falls
 *      back to a native drawImage downscale if pica is missing or fails.
 *   3. Pick a random target byte size per photo inside the user's KB range and
 *      binary-search the toBlob(..., 'image/jpeg', quality) parameter until the
 *      encoded Blob lands on that target (unchanged since v7.0).
 *
 * STRICT CONSTRAINT: this file performs NO layout math and NO Excel work.
 * It returns a plain { blob, width, height, bytes, quality, targetBytes,
 * encoding, engine } record that app.js forwards to Stage 1 / Stage 2
 * unchanged - layout.js and excel.js simply ignore the extra fields.
 */
(function (global) {
  'use strict';

  const VERSION = 'v7.2';

  const MAX_WIDTH = 800;          // px — uniform downscale target width.
  const DEFAULT_MIN_KB = 80;      // default lower bound of the target range.
  const DEFAULT_MAX_KB = 220;     // default upper bound of the target range.

  // --- pica.js (Lanczos3) downscaling --------------------------------------
  const PICA_FILTER = 'lanczos3';   // pica's own Lanczos filter, window 3.0.
  // 'cib' is deliberately NOT enabled: with it pica routes box/hamming/
  // lanczos2/lanczos3 through createImageBitmap (the browser's scaler) and only
  // mks2013 would use pica's own math. Keeping wasm/js guarantees the Lanczos3
  // resampling really runs through pica.
  const PICA_FEATURES = ['js', 'wasm', 'ww'];
  const PICA_TILE = 1024;           // tile size — bounds peak memory use.
  const PICA_IDLE = 2000;           // keep the worker warm between photos.

  // --- EXIF orientation bake ('auto' strategy) -----------------------------
  const ORIENT_CAP_FACTOR = 2;          // capped bake = 2x the output width
  const ORIENT_CAP_MIN = 1600;          // ...but never narrower than this
  const BAKE_FULL_MAX_PIXELS = 4000000; // <= 4 MP sources bake at full size

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

  // --- pica instance (lazy, shared, resilient) -----------------------------
  let picaInstance = null;

  /**
   * Lazily create the shared pica resizer. Returns the instance, or `false`
   * when pica is unavailable/broken so callers fall back to native scaling.
   * pica v9's export is a constructor that is also call-safe without `new`
   * (`window.pica(opts)` === `new window.pica(opts)`), so both shapes work.
   */
  function getPica() {
    if (picaInstance !== null) return picaInstance;

    const Pica = global.pica;

    if (typeof Pica !== 'function') {
      console.warn('[compressor] pica.js not available - native downscale used.');
      picaInstance = false;
      return picaInstance;
    }

    try {
      const instance = Pica({
        features: PICA_FEATURES,
        tile: PICA_TILE,
        idle: PICA_IDLE
      });

      picaInstance =
        instance && typeof instance.resize === 'function'
          ? instance
          : typeof Pica.resize === 'function'
          ? Pica
          : false;
    } catch (err) {
      console.warn('[compressor] pica init failed:', err);
      picaInstance = false;
    }

    return picaInstance;
  }

  // Native fallback: single drawImage straight into the target canvas.
  function nativeDownscale(img, target) {
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable.');
    ctx.drawImage(img, 0, 0, target.width, target.height);
    return target;
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
   * Stage A1 - bake EXIF orientation into a canvas.
   *
   * 'auto' strategy: at full source resolution while the photo is small enough
   * (<= BAKE_FULL_MAX_PIXELS), otherwise capped at
   * max(MAX_WIDTH * ORIENT_CAP_FACTOR, ORIENT_CAP_MIN) px. The cap matters on
   * iOS: a full-resolution 12-48 MP canvas can exceed the per-canvas area /
   * total canvas memory limit and silently yield a blank bitmap.
   */
  function bakeOrientation(img, maxWidth) {
    const pixels = img.naturalWidth * img.naturalHeight;
    const scale =
      pixels <= BAKE_FULL_MAX_PIXELS
        ? 1
        : Math.min(
            1,
            Math.max(maxWidth * ORIENT_CAP_FACTOR, ORIENT_CAP_MIN) /
              img.naturalWidth
          );

    const bakeWidth = Math.max(1, Math.round(img.naturalWidth * scale));
    const bakeHeight = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = bakeWidth;
    canvas.height = bakeHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable.');

    // Drawing the <img> bakes EXIF orientation in natively (Safari normalizes
    // orientation on draw), so no manual rotation math is required here.
    ctx.drawImage(img, 0, 0, bakeWidth, bakeHeight);

    return canvas;
  }

  /**
   * Prepare the canvas that feeds the binary-search encoder.
   *   Stage A1 - bounded EXIF-orientation bake (bakeOrientation).
   *   Stage A2 - pica.js Lanczos3 downscale to width x height.
   * The canvas is reused for every encode of the quality search, so the resize
   * runs exactly once per photo. A native drawImage downscale is used whenever
   * pica is unavailable or throws - a photo is never lost to the resizer.
   */
  async function prepareCanvas(file, maxWidth) {
    const img = await loadImage(file);

    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error(`No intrinsic dimensions: ${file.name}`);
    }

    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const baked = bakeOrientation(img, maxWidth);

    // Source is already at (or below) the target width: the bake canvas IS the
    // result, so skip pica entirely - a 1:1 resize would only cost time.
    if (baked.width === width && baked.height === height) {
      return { canvas: baked, width: width, height: height, engine: 'native' };
    }

    const target = document.createElement('canvas');
    target.width = width;
    target.height = height;

    const pica = getPica();

    if (pica) {
      try {
        await pica.resize(baked, target, { filter: PICA_FILTER });

        // Release the (possibly large) baked canvas immediately: iOS caps total
        // canvas memory and the photos are processed sequentially.
        baked.width = baked.height = 0;

        return { canvas: target, width: width, height: height, engine: 'pica' };
      } catch (err) {
        console.warn(
          `[compressor] pica resize failed for ${file.name} - ` +
            'native downscale used:',
          (err && err.message) || err
        );
      }
    }

    nativeDownscale(baked, target);
    baked.width = baked.height = 0;

    return { canvas: target, width: width, height: height, engine: 'native' };
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
   *                             targetBytes, encoding, engine }
   *   engine: 'pica' when the downscale ran through pica.js Lanczos3,
   *           'native' when the drawImage fallback was used.
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
      encoding: result.encoding,
      engine: prepared.engine
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
    PICA_FILTER: PICA_FILTER,
    PICA_TILE: PICA_TILE,
    ORIENT_CAP_FACTOR: ORIENT_CAP_FACTOR,
    ORIENT_CAP_MIN: ORIENT_CAP_MIN,
    BAKE_FULL_MAX_PIXELS: BAKE_FULL_MAX_PIXELS,
    getPica: getPica,
    resolveRange: resolveRange,
    compressToTarget: compressToTarget
  };
})(window);
