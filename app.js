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
 *
 * v7.4 - also wires the Quality preset segmented control to the two KB inputs
 * (one-way each: preset -> inputs, manual edit -> Custom). The preset numbers
 * come from compressor.js; no layout/Excel logic is involved.
 *
 * v7.5 - persists the user's preferences (photo height, column count, KB range
 * and the Quality preset stop) in localStorage, so an installed standalone PWA
 * reopens with the same settings. The DOM controls stay the single source of
 * truth: loadSettings() hydrates them at startup, saveSettings() snapshots them
 * on every committed change. Pure UI-state plumbing - no layout/Excel logic.
 *
 * v7.6 - boot paints the preset control instead of applying it. loadSettings()
 * has already hydrated the KB inputs, so applyPreset()'s value write would be a
 * no-op while its re-emitted `change` could only re-run the compression pipeline
 * (no photos can be selected at boot). setPresetSelection() gives the same one
 * active stop and label without touching values or emitting events.
 *
 * v7.6 - restoring is stricter: a payload missing either section hydrates
 * nothing (all-or-nothing), and a stored preset stop is kept whenever its KB
 * pair is its own or belongs to no preset — it only snaps to Custom when the
 * pair is another stop's pair. Restores stay write-free.
 */
(function (global) {
  'use strict';

  const APP_VERSION = 'v7.6';

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

  // v7.5 — false until startup hydration has finished, so a restore never writes
  // the store back to itself. From then on anything the user changes persists.
  let settingsLoaded = false;

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
    el.presetControl = $('quality-preset');
    el.presetLabel = $('quality-preset-label');
    el.generateBtn = $('generate-btn');
    el.loader = $('loader');
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

  // v7.3 — #status is the transient *activity* channel (processing / generating /
  // download feedback). It has no idle fallback: an empty message clears the line
  // and hides it, so the "no photos" state is rendered once by renderSummary().
  function setStatus(message) {
    if (!el.status) return;
    const text = message || '';
    el.status.textContent = text;
    el.status.hidden = text === '';
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

  // --- v7.5 Persistent settings (localStorage) ------------------------------
  // The DOM controls ARE the setting state: readLayoutOptions() and
  // readCompressionOptions() read them live at use time, so hydrating the
  // controls at startup restores everything the pipeline consumes. This module
  // owns the storage only — no geometry, no Excel, no new state to drift.
  const SETTINGS_KEY = 'photo2excel.settings';
  const SETTINGS_VERSION = 1;

  // Best-effort storage: Safari Private Mode / blocked cookies can throw on read
  // or write, so every access is guarded and degrades to today's defaults.
  function safeStorageGet(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (err) {
      console.warn('[app] localStorage read unavailable:', err);
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      if (!global.localStorage) return false;
      global.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      console.warn('[app] Could not persist settings:', err);
      return false;
    }
  }

  // The active stop of the segmented control (Custom === getCustomIndex()).
  function getActivePresetIndex() {
    const active = el.presetControl
      ? el.presetControl.querySelector('.segmented-btn.is-active')
      : null;
    return active ? Number(active.dataset.presetIndex) : getCustomIndex();
  }

  // Snapshot the controls. The KB pair goes through readCompressionOptions() so
  // the clamp / min<=max swap / default fallback stay owned by one function.
  function readSettings() {
    const compression = readCompressionOptions();
    return {
      version: SETTINGS_VERSION,
      layout: {
        heightCm: parseFloat(el.heightSelect.value),
        columns: parseInt(el.columnsSelect.value, 10)
      },
      compression: {
        minKB: compression.minKB,
        maxKB: compression.maxKB,
        presetIndex: getActivePresetIndex()
      }
    };
  }

  function saveSettings() {
    return safeStorageSet(SETTINGS_KEY, JSON.stringify(readSettings()));
  }

  // Does this <select> still offer the stored value? Guards against a value that
  // a later version removed from the markup (which would blank the control).
  function selectHasOption(select, value) {
    if (!select) return false;
    const target = String(value);
    return Array.prototype.some.call(
      select.options,
      (option) => option.value === target
    );
  }

  /**
   * Restore saved preferences into the controls.
   *
   * Returns the preset index the segmented control should be normalized with, or
   * null when nothing usable was stored — in that case the markup defaults stay
   * exactly as they are (10 cm / 2 columns / 80 / 220 KB / Custom).
   *
   * Every failure mode (missing key, corrupt JSON, wrong shape, a partial
   * payload, stale values) is handled here and falls back to those defaults:
   * storage can never break init.
   */
  function loadSettings() {
    const raw = safeStorageGet(SETTINGS_KEY);
    if (!raw) return null;

    let stored = null;
    try {
      stored = JSON.parse(raw);
    } catch (err) {
      console.warn('[app] Stored settings are not valid JSON — using defaults:', err);
      return null;
    }

    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
      console.warn('[app] Stored settings have an unexpected shape — using defaults.');
      return null;
    }

    // v7.6 — all-or-nothing: a payload missing BOTH sections is stale/partial, so
    // nothing is hydrated and the markup defaults stay exactly as they are.
    // `version` is exempt: it is written for forward-compat and never consumed.
    const layout =
      stored.layout && typeof stored.layout === 'object' ? stored.layout : null;
    const compression =
      stored.compression && typeof stored.compression === 'object'
        ? stored.compression
        : null;

    if (!layout || !compression) {
      console.warn(
        '[app] Stored settings are incomplete (layout/compression) — using defaults.'
      );
      return null;
    }

    if (selectHasOption(el.heightSelect, layout.heightCm)) {
      el.heightSelect.value = String(layout.heightCm);
    }
    if (selectHasOption(el.columnsSelect, layout.columns)) {
      el.columnsSelect.value = String(layout.columns);
    }

    // Candidates go in first and come straight back out through the single
    // sanitizer, so the 1..4096 clamp, the min<=max swap and the Compressor
    // defaults all apply to restored values too.
    if (el.minKbInput) el.minKbInput.value = String(compression.minKB);
    if (el.maxKbInput) el.maxKbInput.value = String(compression.maxKB);

    const sanitized = readCompressionOptions();
    if (el.minKbInput) el.minKbInput.value = String(sanitized.minKB);
    if (el.maxKbInput) el.maxKbInput.value = String(sanitized.maxKB);

    // v7.6 — a stored stop is honoured when it is in range AND its KB pair is not
    // some OTHER stop's pair. Either the pair is its own (the normal case) or it
    // matches no preset at all (an explicitly saved stop that owns custom
    // values — a restore must return exactly what was saved). Only a pair
    // belonging to a DIFFERENT stop can no longer describe the stored stop, so
    // that alone snaps to Custom rather than relabelling someone else's values.
    const custom = getCustomIndex();
    const presets = getPresets();
    let presetIndex = parseInt(compression.presetIndex, 10);
    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex > custom) {
      presetIndex = custom;
    } else if (presetIndex < custom) {
      const preset = presets[presetIndex];
      const matchesOwn =
        !!preset &&
        preset.minKB === sanitized.minKB &&
        preset.maxKB === sanitized.maxKB;
      const matchesOther = presets.some(
        (p) => p.minKB === sanitized.minKB && p.maxKB === sanitized.maxKB
      );
      if (!preset || (!matchesOwn && matchesOther)) presetIndex = custom;
    }

    console.log('[app] Settings restored from localStorage.');
    return presetIndex;
  }
  // --- end v7.5 persistent settings -----------------------------------------

  // --- v7.4 Quality preset control -----------------------------------------
  // The preset table lives in compressor.js (Compressor.QUALITY_PRESETS) so the
  // KB domain keeps a single source of truth. This copy is only a safety net
  // for the case where that module failed to load - the UI must still work.
  const FALLBACK_PRESETS = [
    { id: 'low', label: 'Low', minKB: 20, maxKB: 60 },
    { id: 'medium', label: 'Medium', minKB: 70, maxKB: 140 },
    { id: 'high', label: 'High', minKB: 140, maxKB: 400 }
  ];

  // True only while applyPreset() writes the KB inputs. Assigning .value fires
  // no `input` event, so this is defence-in-depth against a future refactor
  // (e.g. a library that does emit one) turning a preset tap into "Custom".
  let applyingPreset = false;

  function getPresets() {
    const presets = global.Compressor && global.Compressor.QUALITY_PRESETS;
    return Array.isArray(presets) && presets.length > 0 ? presets : FALLBACK_PRESETS;
  }

  // "Custom" is the last stop of the control: it owns no values of its own.
  function getCustomIndex() {
    const custom = global.Compressor && global.Compressor.PRESET_CUSTOM_INDEX;
    return Number.isInteger(custom) ? custom : getPresets().length;
  }

  // Paint the control: exactly one stop is active and announced.
  function setPresetSelection(index) {
    const buttons = el.presetControl
      ? el.presetControl.querySelectorAll('[data-preset-index]')
      : [];

    Array.prototype.forEach.call(buttons, (button) => {
      const active = Number(button.dataset.presetIndex) === index;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });

    const preset = getPresets()[index];
    if (el.presetLabel) {
      el.presetLabel.textContent = preset ? preset.label : 'Custom';
    }
  }

  /**
   * Preset -> inputs. A real preset fills both KB fields; Custom deliberately
   * leaves them exactly as the user typed them. When the range really changed we
   * re-emit `change` on the min field so the single existing re-encode path
   * (onCompressionRangeChanged) runs - that logic is never duplicated here.
   */
  function applyPreset(index) {
    const preset = getPresets()[index];
    const previousMin = el.minKbInput ? el.minKbInput.value : '';
    const previousMax = el.maxKbInput ? el.maxKbInput.value : '';
    let changed = false;

    applyingPreset = true;
    try {
      if (preset && el.minKbInput && el.maxKbInput) {
        el.minKbInput.value = String(preset.minKB);
        el.maxKbInput.value = String(preset.maxKB);
        // Only a genuine value change may restart compression: re-tapping the
        // current preset, or tapping Custom, must stay a no-op.
        changed =
          el.minKbInput.value !== previousMin ||
          el.maxKbInput.value !== previousMax;
      }
      setPresetSelection(index);

      // Re-emitted INSIDE the guard so the manual-edit handler (bound to both
      // `input` and `change`) cannot mistake this programmatic change for a user
      // edit and snap the control back to Custom.
      if (changed) {
        el.minKbInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      applyingPreset = false;
      // v7.5 — a tap that changed the KB pair already persists through the
      // `change` handler above; this covers Custom and no-op re-taps, which emit
      // no `change` event at all but still move the chosen stop.
      if (settingsLoaded && !changed) saveSettings();
    }
  }

  /**
   * Inputs -> preset. Any manual edit overrides the preset, so the control snaps
   * to Custom. The KB inputs stay enabled/editable at all times. Re-encoding is
   * left to the existing `change` listeners so typing stays cheap.
   */
  function onKbInputEdited() {
    if (applyingPreset) return;
    setPresetSelection(getCustomIndex());
    if (settingsLoaded) saveSettings();
  }

  function onPresetClick(event) {
    const button = event.target.closest('[data-preset-index]');
    if (!button) return;
    applyPreset(Number(button.dataset.presetIndex));
  }

  // Radiogroup convention: arrows move between stops and wrap around.
  function onPresetKeydown(event) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;

    if (step === 0) return;
    event.preventDefault();

    const total = getCustomIndex() + 1;
    const active = el.presetControl.querySelector('.segmented-btn.is-active');
    const current = active ? Number(active.dataset.presetIndex) : 0;
    const next = (current + step + total) % total;

    applyPreset(next);

    const button = el.presetControl.querySelector(
      '[data-preset-index="' + next + '"]'
    );
    if (button) button.focus();
  }
  // --- end v7.4 Quality preset control -------------------------------------

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
      // v7.3 — nothing to report yet: the idle text is owned by renderSummary().
      setStatus('');
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
    setStatus(''); // v7.3 — renderSummary() already shows "No photos selected."
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
  // v7.4: `input` snaps the preset control to Custom, and this handler snaps it
  // too, so value paths that only emit `change` (autofill, spinner commit) are
  // covered as well. applyPreset() re-emits `change` inside its own guard, so a
  // preset tap is never mistaken for a manual override.
  function onCompressionRangeChanged() {
    onKbInputEdited();
    // v7.5 — a committed KB change (manual edit, spinner commit, autofill, or a
    // preset tap's re-emitted `change`) is persisted here; `input` stays cheap.
    if (settingsLoaded) saveSettings();

    if (state.files.length > 0) {
      processFiles(state.files);
    }
  }

  // v7.5 — layout selects: recompute the placement, then persist the new choice.
  function onLayoutSettingChanged() {
    runLayout();
    if (settingsLoaded) saveSettings();
  }

  function bindEvents() {
    el.photoInput.addEventListener('change', onFilesSelected);
    el.clearBtn.addEventListener('click', clearFiles);
    el.heightSelect.addEventListener('change', onLayoutSettingChanged);
    el.columnsSelect.addEventListener('change', onLayoutSettingChanged);
    el.minKbInput.addEventListener('change', onCompressionRangeChanged);
    el.maxKbInput.addEventListener('change', onCompressionRangeChanged);
    // v7.4 — a manual edit means the preset was overridden (snap to Custom).
    el.minKbInput.addEventListener('input', onKbInputEdited);
    el.maxKbInput.addEventListener('input', onKbInputEdited);
    if (el.presetControl) {
      el.presetControl.addEventListener('click', onPresetClick);
      el.presetControl.addEventListener('keydown', onPresetKeydown);
    }
    el.generateBtn.addEventListener('click', generateExcel);
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
    // v7.5 — restore saved preferences BEFORE the listeners are armed, so
    // hydration can never fire a handler. null = nothing usable was stored, in
    // which case the markup defaults are kept untouched.
    const restoredPreset = loadSettings();
    bindEvents();
    // v7.4 — normalize the preset control on load. The restored stop is used when
    // one was stored, otherwise Custom is the default and the KB inputs keep
    // their markup defaults (80 / 220 KB) untouched.
    // v7.6 — paint-only: loadSettings() already hydrated the KB inputs, so
    // applyPreset()'s value write would be a no-op while its re-emitted `change`
    // could only re-run the compression pipeline (nothing is selected at boot).
    // setPresetSelection() produces the same single active stop + label.
    setPresetSelection(restoredPreset === null ? getCustomIndex() : restoredPreset);
    // v7.5 — on first boot (nothing was stored), persist the markup defaults so
    // that a second boot finds a valid payload. When a payload WAS restored, the
    // controls already match storage, so we must not write back.
    if (restoredPreset === null) saveSettings();
    settingsLoaded = true; // v7.5 — from here on every user change is persisted.
    renderSummary();
    setStatus(''); // v7.3 — idle state is rendered once by renderSummary() only.
    renderGenerateButton();
    registerServiceWorker();
    console.log(`[app] Photo Report Creator ${APP_VERSION} initialized.`);
  }

  // Scripts are deferred and loaded in order, so this fires after parsing.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
