/**
 * app.js — Main controller
 *
 * Owns UI events and orchestrates the pipeline:
 *
 *   Preprocess (Canvas): Compressor.compressToTarget() — downscale, EXIF
 *                        orientation normalization, and binary-search JPEG
 *                        quality tuning toward a randomized per-photo KB target.
 *   Stage 1 (Layout):    Layout.calculateLayout(photos, options) -> layout data
 *                        (pure X/Y pixel coordinates, no Excel involved)
 *
 *   Stage 2 (Excel):     ExcelWriter.buildExcelWorkbook(layoutData)
 *                        -> .xlsx buffer (consumes coordinates as-is)
 */
(function (global) {
  'use strict';

  const APP_VERSION = 'v7.2';

  // MAX_WIDTH, the JPEG quality bounds (0.15 / 0.95) and the KB-range defaults
  // all live in compressor.js (Compressor.MAX_WIDTH / .DEFAULT_MIN_KB / etc.).

  // Central app state; extended by later steps.
  const state = {
    files: [],           // Selected File objects.
    processedPhotos: [], // Canvas-processed photos (blob + dimensions).
    layout: []           // Stage 1 output: [{ id, originalName, blob, x, y, width, height }].
  };

  // Monotonic token used to cancel stale preprocessing when selection changes.
  let processingToken = 0;
  let generating = false; // true while the Excel file is being built.

  const el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    el.versionBadge = $('version-badge');
    el.photoInput = $('photo-input');
    el.clearBtn = $('clear-btn');
    el.fileSummary = $('file-summary');
    el.fileList = $('file-list');
    el.status = $('status');
    el.heightSelect = $('height-select');
    el.columnsSelect = $('columns-select');
    el.minKbInput = $('min-kb-input');
    el.maxKbInput = $('max-kb-input');
    el.generateBtn = $('generate-btn');
    el.loader = $('loader');
    el.offlineBanner = $('offline-banner');
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1
    );
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function updateVersionBadge() {
    el.versionBadge.textContent = APP_VERSION;
  }

  function renderFileList() {
    // Processed photos are keyed by selection index (see processFiles).
    const processedById = new Map(state.processedPhotos.map((p) => [p.id, p]));

    el.fileList.innerHTML = '';
    state.files.forEach((file, index) => {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.name;

      const processed = processedById.get(index);

      const size = document.createElement('span');
      size.className = 'file-size';
      // v7.0: show original → compressed once the photo has been processed.
      size.textContent =
        processed && processed.bytes
          ? `${formatSize(file.size)} → ${formatSize(processed.bytes)}`
          : formatSize(file.size);
      size.title =
        processed && processed.quality
          ? `JPEG quality ${processed.quality.toFixed(2)}`
          : '';

      li.append(name, size);
      el.fileList.appendChild(li);
    });
  }

  function renderSummary() {
    const n = state.files.length;
    el.fileSummary.textContent =
      n === 0 ? 'No photos selected.' : `${n} photo${n === 1 ? '' : 's'} selected.`;
    el.clearBtn.disabled = n === 0;
  }

  function setStatus(message) {
    if (el.status) el.status.textContent = message;
  }

  // Hard clamping bounds for the KB range inputs (compressor.js re-clamps too).
  const KB_INPUT_MIN = 1;
  const KB_INPUT_MAX = 4096;

  /**
   * Read + sanitize the target-size KB range from the number inputs:
   * non-numeric values fall back to the compressor defaults, values are
   * clamped, and an inverted range is swapped so min <= max.
   */
  function readCompressionOptions() {
    const defaults = global.Compressor || {};

    const readInput = (input, fallback) => {
      const raw = parseFloat(input && input.value);
      if (!Number.isFinite(raw) || raw <= 0) return fallback;
      return Math.min(Math.max(Math.round(raw), KB_INPUT_MIN), KB_INPUT_MAX);
    };

    let minKB = readInput(el.minKbInput, defaults.DEFAULT_MIN_KB || 80);
    let maxKB = readInput(el.maxKbInput, defaults.DEFAULT_MAX_KB || 220);

    if (minKB > maxKB) {
      const swap = minKB;
      minKB = maxKB;
      maxKB = swap;
    }

    return { minKB: minKB, maxKB: maxKB };
  }

  /**
   * Preprocess one photo through the compressor: downscale (max width), bake
   * EXIF orientation, then binary-search the JPEG quality toward a randomized
   * KB target inside the user's range. Returns the final blob, its normalized
   * dimensions and the actual byte size for the downstream stages.
   */
  async function preprocessImage(file, id, compression) {
    if (!global.Compressor) {
      throw new Error('Compressor module is not loaded.');
    }

    const photo = await global.Compressor.compressToTarget(file, compression);

    return {
      id: id,
      originalName: file.name,
      width: photo.width,
      height: photo.height,
      blob: photo.blob,
      bytes: photo.bytes,
      quality: photo.quality,
      targetBytes: photo.targetBytes,
      engine: photo.engine
    };
  }

  function readLayoutOptions() {
    return {
      columns: parseInt(el.columnsSelect.value, 10) || 2,
      targetHeightCm: parseFloat(el.heightSelect.value) || 10,
      baseGapPx: 4,            // vertical row-stack base gap
      horizontalBaseGapPx: 3,  // v6.4: horizontal-only base gap (4 - 1 px)
      verticalGapPx: 14,
      gapJitterPx: 1
    };
  }

  function runLayout() {
    if (state.processedPhotos.length === 0) {
      state.layout = [];
      renderGenerateButton();
      console.log('[app] No processed photos — layout skipped.');
      return;
    }

    const options = readLayoutOptions();
    const coords = global.Layout.calculateLayout(state.processedPhotos, options);

    // Reattach the blob + compression stats here so layout.js stays free of
    // heavy binary data and confined to pure coordinate math. The X/Y/W/H
    // values are consumed exactly as Stage 1 produced them — no repositioning.
    const photoById = new Map(state.processedPhotos.map((p) => [p.id, p]));
    state.layout = coords.map((entry) => {
      const photo = photoById.get(entry.id) || {};
      return {
        id: entry.id,
        originalName: entry.originalName,
        blob: photo.blob,
        bytes: photo.bytes,
        quality: photo.quality,
        targetBytes: photo.targetBytes,
        x: entry.x,
        y: entry.y,
        width: entry.width,
        height: entry.height
      };
    });

    console.log('[app] Layout:', state.layout);
    renderGenerateButton();
  }

  async function processFiles(files) {
    const token = ++processingToken;
    state.processedPhotos = [];
    const total = files.length;

    if (total === 0) {
      setStatus('No photos selected.');
      return;
    }

    // Read the KB range once per run: every photo of this run shares the
    // range, while each photo still gets its own randomized target inside it.
    const compression = readCompressionOptions();
    console.log(
      `[app] Target size range: ${compression.minKB}–${compression.maxKB} KB per photo.`
    );

    for (let i = 0; i < total; i++) {
      if (token !== processingToken) return; // superseded by a newer selection

      setStatus(`Processing ${i + 1}/${total} photos…`);
      try {
        const photo = await preprocessImage(files[i], i, compression);
        if (token !== processingToken) return;
        state.processedPhotos.push(photo);
      } catch (err) {
        console.warn(
          `[app] Skipping ${files[i].name}:`,
          (err && err.message) || err
        );
      }
      setStatus(`Processed ${i + 1}/${total} photos…`);
    }

    if (token !== processingToken) return;

    setStatus(`Processed ${state.processedPhotos.length}/${total} photos.`);
    renderFileList(); // refresh with the compressed sizes
    console.log('[app] Processed photos:', state.processedPhotos);
    runLayout();
  }

  function onFilesSelected(event) {
    const selected = Array.from(event.target.files || []);
    const images = selected.filter((file) => file.type.startsWith('image/'));

    if (images.length !== selected.length) {
      console.warn(
        `[app] Ignored ${selected.length - images.length} non-image file(s).`
      );
    }

    state.files = images;
    renderFileList();
    renderSummary();
    console.log(`[app] ${state.files.length} photo(s) selected.`);
    processFiles(state.files);
  }

  function clearFiles() {
    processingToken++; // cancel any in-flight processing
    state.files = [];
    state.processedPhotos = [];
    state.layout = [];
    el.photoInput.value = '';
    renderFileList();
    renderSummary();
    setStatus('No photos selected.');
    renderGenerateButton();
    console.log('[app] Selection cleared.');
  }

  function renderGenerateButton() {
    el.generateBtn.disabled = generating || state.layout.length === 0;
    el.loader.hidden = !generating;
  }

  function downloadBuffer(buffer, filename) {
    const blob = new Blob([buffer], {
      type:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Hand the blob URL back to the browser before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function generateExcel() {
    if (state.layout.length === 0) return;

    generating = true;
    renderGenerateButton();
    setStatus('Generating Excel…');

    try {
      const buffer = await global.ExcelWriter.buildExcelWorkbook(state.layout);
      downloadBuffer(buffer, 'Photo_Report.xlsx');
      setStatus('Download started.');
    } catch (err) {
      console.error('[app] Excel generation failed:', err);
      setStatus('Failed to generate Excel — see console.');
    } finally {
      generating = false;
      renderGenerateButton();
    }
  }

  // Re-encode the current selection when the KB range changes. Bound to
  // `change` (not `input`) so typing does not trigger a re-encode per keystroke.
  function onCompressionRangeChanged() {
    if (state.files.length > 0) {
      processFiles(state.files);
    }
  }

  function bindEvents() {
    el.photoInput.addEventListener('change', onFilesSelected);
    el.clearBtn.addEventListener('click', clearFiles);
    el.heightSelect.addEventListener('change', runLayout);
    el.columnsSelect.addEventListener('change', runLayout);
    el.minKbInput.addEventListener('change', onCompressionRangeChanged);
    el.maxKbInput.addEventListener('change', onCompressionRangeChanged);
    el.generateBtn.addEventListener('click', generateExcel);
  }

  function updateOnlineStatus() {
    if (el.offlineBanner) {
      el.offlineBanner.hidden = navigator.onLine;
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('[app] Service Worker registration failed:', err);
      });
    } else {
      console.warn('[app] Service Worker not supported in this browser.');
    }
  }

  function init() {
    cacheDom();
    updateVersionBadge();
    bindEvents();
    renderSummary();
    setStatus('No photos selected.');
    renderGenerateButton();
    registerServiceWorker();
    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    console.log(`[app] Photo Report Creator ${APP_VERSION} initialized.`);
  }

  // Scripts are deferred and loaded in order, so this fires after parsing.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
