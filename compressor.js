/**
 * compressor.js — Target-size JPEG compression engine
 *
  * Version: v8.3
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
 *
 * v7.4 - also exports the QUALITY_PRESETS table (the KB ranges offered by the
 * Quality preset control in the UI). The KB domain already lives here next to
 * DEFAULT_MIN_KB / DEFAULT_MAX_KB, so the preset numbers keep a single source
 * of truth: app.js only reads them to fill the two KB inputs. Pure data - still
 * no DOM and no rendering.
 *
 * v8.2 - the module also reads a photo capture date. readExifStamp() walks the
 * JPEG APP1 / TIFF blocks, parseExifStamp() validates the stamp into a LOCAL
 * Date, and resolveCaptureDate() applies the fallback chain (EXIF ->
 * file.lastModified -> null) that app.js finishes off with today. Still pure
 * byte parsing: no DOM, no canvas, no layout, no Excel.
 *
 * v8.3 - adds the pure, byte-free ingest-sorting surface: compareNamesNatural()
 * performs a numeric-aware natural filename comparison, and sortPhotoKeys()
 * orders photo sort-keys (index / timestamp / name) by ascending capture
 * timestamp first, falling back to natural filename order for ties or
 * EXIF-less photos, with the original selection index as a final stability
 * tie-breaker. No DOM, no canvas, no layout math, no Excel work.
 */
(function (global) {
  'use strict';

  const VERSION = 'v8.3';

  const MAX_WIDTH = 800;          // px — uniform downscale target width.
  const DEFAULT_MIN_KB = 80;      // default lower bound of the target range.
  const DEFAULT_MAX_KB = 220;     // default upper bound of the target range.

  // v7.4 — Quality preset table, ordered as rendered by the segmented control.
  // PRESET_CUSTOM_INDEX is the "Custom" stop: it has no values of its own (the
  // two KB inputs keep whatever the user typed).
  const QUALITY_PRESETS = [
    { id: 'low', label: 'Low', minKB: 20, maxKB: 60 },
    { id: 'medium', label: 'Medium', minKB: 70, maxKB: 140 },
    { id: 'high', label: 'High', minKB: 140, maxKB: 400 }
  ];
  const PRESET_CUSTOM_INDEX = QUALITY_PRESETS.length; // === 3

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

  // --- v8.2 EXIF capture-date reading ---------------------------------------
  // Pure byte parsing: no DOM, no canvas, no layout, no Excel. Only the JPEG
  // APP1 / TIFF (Exif) container is understood; PNG, WebP and HEIC carry no
  // such segment and simply yield null, so the caller falls back to the file
  // timestamp and finally to today.
  const EXIF_SIGNATURE = 'Exif';         // ...followed by two NUL bytes
  const TAG_DATETIME = 0x0132;           // IFD0: file change date
  const TAG_EXIF_IFD = 0x8769;           // IFD0: pointer to the Exif sub-IFD
  const TAG_DATETIME_ORIGINAL = 0x9003;  // Exif IFD: capture time (best)
  const TAG_DATETIME_DIGITIZED = 0x9004; // Exif IFD: digitised time
  const MIN_EXIF_YEAR = 1970;            // earlier than this is not a photo
  const TIFF_MAGIC = 42;
  // YYYY:MM:DD HH:MM:SS - written with [0-9] ranges so the pattern needs no
  // backslash escapes of its own.
  const STAMP_PATTERN = /^([0-9]{4}):([0-9]{2}):([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})/;

  function toDataView(bytes) {
    if (!bytes) return null;
    if (bytes instanceof DataView) return bytes;
    if (bytes instanceof ArrayBuffer) return new DataView(bytes);
    if (ArrayBuffer.isView(bytes)) {
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    return null;
  }

  // TIFF integers follow the byte order declared in the block header.
  function readUint16(view, offset, littleEndian) {
    return littleEndian ? view.getUint16(offset, true) : view.getUint16(offset, false);
  }

  function readUint32(view, offset, littleEndian) {
    return littleEndian ? view.getUint32(offset, true) : view.getUint32(offset, false);
  }

  // Does the APP1 payload start with the 6-byte Exif signature?
  function isExifApp1(view, payload, end) {
    if (end - payload < EXIF_SIGNATURE.length + 2) return false;
    for (let i = 0; i < EXIF_SIGNATURE.length; i++) {
      if (view.getUint8(payload + i) !== EXIF_SIGNATURE.charCodeAt(i)) return false;
    }
    return view.getUint8(payload + 4) === 0 && view.getUint8(payload + 5) === 0;
  }

  // One NUL-terminated ASCII field. Counts above 4 bytes live at an offset
  // relative to the TIFF header rather than inline, which is the normal case
  // for the 20-byte date stamps.
  function readAscii(view, tiffStart, valueField, length, end, littleEndian) {
    let start = valueField;
    if (length > 4) start = tiffStart + readUint32(view, valueField, littleEndian);
    if (start < 0) return null;

    const available = Math.min(length, end - start);
    if (available <= 0) return null;

    let text = '';
    for (let i = 0; i < available; i++) {
      const code = view.getUint8(start + i);
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text || null;
  }

  // Walk one IFD and keep only the tags this module needs.
  function readIfd(view, tiffStart, ifdStart, end, littleEndian) {
    if (ifdStart < 0 || ifdStart + 2 > end) return null;

    const count = readUint16(view, ifdStart, littleEndian);
    const fields = {};

    for (let i = 0; i < count; i++) {
      const entry = ifdStart + 2 + i * 12;
      if (entry + 12 > end) return fields; // truncated head: keep what we have

      const tag = readUint16(view, entry, littleEndian);
      if (
        tag !== TAG_DATETIME &&
        tag !== TAG_DATETIME_ORIGINAL &&
        tag !== TAG_DATETIME_DIGITIZED &&
        tag !== TAG_EXIF_IFD
      ) {
        continue;
      }

      const type = readUint16(view, entry + 2, littleEndian);
      const length = readUint32(view, entry + 4, littleEndian);

      if (type === 2) {
        const text = readAscii(view, tiffStart, entry + 8, length, end, littleEndian);
        if (text) fields[tag] = text;
      } else if ((type === 4 || type === 3) && length === 1) {
        fields[tag] = readUint32(view, entry + 8, littleEndian);
      }
    }
    return fields;
  }

  // TIFF block -> the best available date stamp.
  function readTiffStamp(view, tiffStart, end) {
    if (tiffStart + 8 > end) return null;

    const order = readUint16(view, tiffStart, false);
    let littleEndian;
    if (order === 0x4949) littleEndian = true;        // II
    else if (order === 0x4d4d) littleEndian = false;  // MM
    else return null;

    if (readUint16(view, tiffStart + 2, littleEndian) !== TIFF_MAGIC) return null;

    const ifd0Offset = readUint32(view, tiffStart + 4, littleEndian);
    const ifd0 = readIfd(view, tiffStart, tiffStart + ifd0Offset, end, littleEndian);
    if (!ifd0) return null;

    const exifPointer = ifd0[TAG_EXIF_IFD];
    let digitized = null;
    if (typeof exifPointer === 'number') {
      const exifIfd = readIfd(view, tiffStart, tiffStart + exifPointer, end, littleEndian);
      if (exifIfd) {
        if (typeof exifIfd[TAG_DATETIME_ORIGINAL] === 'string') {
          return exifIfd[TAG_DATETIME_ORIGINAL]; // best possible answer
        }
        digitized = exifIfd[TAG_DATETIME_DIGITIZED] || null;
      }
    }

    const changed = ifd0[TAG_DATETIME];
    return digitized || (typeof changed === 'string' ? changed : null);
  }

  /**
   * Capture-time stamp out of a JPEG EXIF APP1 segment.
   * Priority: DateTimeOriginal -> DateTimeDigitized -> IFD0 DateTime.
   * @param {ArrayBuffer|Uint8Array|DataView|null} bytes - the FILE HEAD is enough.
   * @returns {string|null} the raw YYYY:MM:DD HH:MM:SS stamp, or null.
   */
  function readExifStamp(bytes) {
    const view = toDataView(bytes);
    if (!view || view.byteLength < 4) return null;

    // Must be a JPEG, starting with SOI.
    if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) return null; // not a marker: give up
      const marker = view.getUint8(offset + 1);

      // Standalone markers carry no length field.
      if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return null; // entropy-coded data

      const length = view.getUint16(offset + 2, false); // JPEG lengths are big-endian
      if (length < 2) return null;

      const payload = offset + 4;
      const next = offset + 2 + length;
      if (next > view.byteLength) return null; // the head slice was too small

      if (marker === 0xe1 && isExifApp1(view, payload, next)) {
        return readTiffStamp(view, payload + EXIF_SIGNATURE.length + 2, next);
      }
      offset = next;
    }
    return null;
  }

  /**
   * YYYY:MM:DD HH:MM:SS -> Date, or null when the stamp is not a plausible
   * capture date. Built from LOCAL parts on purpose: EXIF carries no timezone,
   * and app.js formats a Date the same way.
   */
  function parseExifStamp(text) {
    if (typeof text !== 'string') return null;

    const match = STAMP_PATTERN.exec(text);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);

    // The 0000:00:00 00:00:00 stamp is a common unknown placeholder.
    if (year < MIN_EXIF_YEAR || year > new Date().getFullYear() + 1) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 60) return null;

    const date = new Date(year, month - 1, day, hour, minute, second);

    // Date silently rolls overflow over (Feb 30 becomes Mar 2), so echo the
    // fields back: only a stamp that survives intact is a real calendar date.
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day ||
      date.getHours() !== hour ||
      date.getMinutes() !== minute
    ) {
      return null;
    }
    return date;
  }

  /**
   * Best available capture date for a photo.
   * Chain: EXIF (DateTimeOriginal -> DateTimeDigitized -> DateTime) ->
   * file.lastModified -> null. null means nothing usable was found, so the
   * caller owns the final fallback (app.js renders today in that case).
   * @param {ArrayBuffer|Uint8Array|DataView|null} bytes
   * @param {number} [lastModified] - the File timestamp in epoch ms.
   * @returns {Date|null}
   */
  function resolveCaptureDate(bytes, lastModified) {
    let stamp = null;
    try {
      stamp = readExifStamp(bytes);
    } catch (err) {
      console.warn('[compressor] EXIF read failed:', err);
    }

    const fromExif = parseExifStamp(stamp);
    if (fromExif) return fromExif;

    const timestamp = Number(lastModified);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      const fromFile = new Date(timestamp);
      if (!isNaN(fromFile.getTime())) return fromFile;
    }
    return null;
  }
  // --- v8.3 ingest sorting (pure, no EXIF bytes parsed here) -----------------
  // app.js reads each photo's capture timestamp with resolveCaptureDate() (the
  // EXIF -> file.lastModified chain above) and hands this module a list of
  // { index, timestamp, name } records to order. These helpers never touch DOM,
  // canvas, layout math or Excel: they are plain value comparison + stable sort.

  /**
   * Natural, numeric-aware filename comparison.
   *
   *   "IMG_4490.jpg" < "IMG_4501.jpg"
   *   "photo_2.jpg"  < "photo_10.jpg"   (numeric segments, not lexicographic)
   *
   * sensitivity: 'base' makes the comparison case-insensitive so "IMG_1" and
   * "img_1" collapse to the same rank only when the numeric part also matches —
   * exactly the localeCompare contract the spec asks for.
   *
   * @param {string|null|undefined} a
   * @param {string|null|undefined} b
   * @returns {number} <0 / 0 / >0
   */
  function compareNamesNatural(a, b) {
    const nameA = String(a == null ? '' : a);
    const nameB = String(b == null ? '' : b);
    // Guard against a runtime with no Intl (Node without full-icu still
    // supports numeric collation, but a stripped embed might not).
    try {
      return nameA.localeCompare(nameB, undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    } catch (err) {
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    }
  }

  /**
   * Order photo sort-keys oldest-capture-first, with natural filename order as
   * the cascading tie-breaker.
   *
   * Cascade (per the v9.2 contract):
   *   1. Both timestamps valid and different  -> ascending epoch ms.
   *   2. Identical timestamps, OR either/both
   *      timestamps missing                   -> compareNamesNatural().
   *   3. Still 0 (identical name + timestamp)  -> original index (stability).
   *
   * A timestamp of NaN / Infinity is treated as "missing" (not a real date).
   * The input array is NOT mutated: a shallow-copied, sorted copy is returned.
   *
   * @param {Array<{index:number,timestamp:number|null,name:string}>} keys
   * @returns {Array<{index:number,timestamp:number|null,name:string}>}
   */
  function sortPhotoKeys(keys) {
    const list = Array.isArray(keys) ? keys.slice() : [];
    return list.sort(function (a, b) {
      const haveA = a && Number.isFinite(a.timestamp);
      const haveB = b && Number.isFinite(b.timestamp);
      const timeA = haveA ? a.timestamp : null;
      const timeB = haveB ? b.timestamp : null;

      // Rule 1: both real timestamps that differ -> ascending order.
      if (timeA !== null && timeB !== null) {
        if (timeA !== timeB) return timeA - timeB;
        // Identical -> fall through to the filename tie-breaker.
      }

      // Rule 2: tie (or either/both missing) -> natural filename order.
      const byName = compareNamesNatural(a && a.name, b && b.name);
      if (byName !== 0) return byName;

      // Rule 3: full tie -> keep the original selection order.
      const indexA = a && Number.isFinite(a.index) ? a.index : 0;
      const indexB = b && Number.isFinite(b.index) ? b.index : 0;
      return indexA - indexB;
    });
  }
  // --- end v8.3 ingest sorting ----------------------------------------------

  global.Compressor = {
    VERSION: VERSION,
    MAX_WIDTH: MAX_WIDTH,
    DEFAULT_MIN_KB: DEFAULT_MIN_KB,
    DEFAULT_MAX_KB: DEFAULT_MAX_KB,
    QUALITY_PRESETS: QUALITY_PRESETS,
    PRESET_CUSTOM_INDEX: PRESET_CUSTOM_INDEX,
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
    compressToTarget: compressToTarget,
    readExifStamp: readExifStamp,
    parseExifStamp: parseExifStamp,
    resolveCaptureDate: resolveCaptureDate,
    compareNamesNatural: compareNamesNatural,
    sortPhotoKeys: sortPhotoKeys
  };
})(window);
