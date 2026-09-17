/**
 * app.js — Main controller
 *
 * Owns UI events and orchestrates the pipeline:
 *
 *   Preprocess (Canvas): downscale + EXIF orientation normalization.
 *   Stage 1 (Layout):    Layout.calculateLayout(photos, options) -> layout data
 *                        (pure X/Y pixel coordinates, no Excel involved)
 *
 *   Stage 2 (Excel):     ExcelWriter.buildExcelWorkbook(layoutData)
 *                        -> .xlsx buffer (consumes coordinates as-is)
 */
(function (global) {
  'use strict';

  const APP_VERSION = 'v6.3';
  const MAX_WIDTH = 800;      // px — uniform downscale target width.
  const JPEG_QUALITY = 0.85;  // JPEG encoding quality for preprocessed images.

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
    el.fileList.innerHTML = '';
    state.files.forEach((file) => {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'file-name';
      name.textContent = file.name;
      name.title = file.name;

      const size = document.createElement('span');
      size.className = 'file-size';
      size.textContent = formatSize(file.size);

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

  /**
   * Load a File into an HTMLImageElement via an object URL.
   * The object URL is revoked once the image has decoded.
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

  /**
   * Downscale a photo so its width never exceeds MAX_WIDTH (aspect ratio
   * preserved) and normalize EXIF orientation by drawing onto a canvas.
   * Returns a lightweight JPEG blob plus the normalized dimensions.
   */
  async function preprocessImage(file, id) {
    const img = await loadImage(file);

    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error(`No intrinsic dimensions: ${file.name}`);
    }

    const scale = Math.min(1, MAX_WIDTH / img.naturalWidth);
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

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error('Canvas encoding failed.')),
        'image/jpeg',
        JPEG_QUALITY
      );
    });

    return { id, originalName: file.name, width, height, blob };
  }

  function readLayoutOptions() {
    return {
      columns: parseInt(el.columnsSelect.value, 10) || 2,
      targetHeightCm: parseFloat(el.heightSelect.value) || 10,
      baseGapPx: 4,
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

    // Reattach the blob here so layout.js stays free of heavy binary data.
    const blobById = new Map(state.processedPhotos.map((p) => [p.id, p.blob]));
    state.layout = coords.map((entry) => ({
      id: entry.id,
      originalName: entry.originalName,
      blob: blobById.get(entry.id),
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height
    }));

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

    for (let i = 0; i < total; i++) {
      if (token !== processingToken) return; // superseded by a newer selection

      setStatus(`Processing ${i + 1}/${total} photos…`);
      try {
        const photo = await preprocessImage(files[i], i);
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

    setStatus(`Processed ${state.processedPhotos.length}/${total} photos.`);
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

  function bindEvents() {
    el.photoInput.addEventListener('change', onFilesSelected);
    el.clearBtn.addEventListener('click', clearFiles);
    el.heightSelect.addEventListener('change', runLayout);
    el.columnsSelect.addEventListener('change', runLayout);
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
