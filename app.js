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
 *
 * v7.7 - the file list gains a "Total Size:" footer that sums the originals
 * (File.size) and the compressed sizes (photo.bytes) with the existing
 * formatSize(). It is rendered from renderFileList(), so add / remove / KB-range
 * change / re-compression all stay in sync through the ONE existing path and
 * nothing new has to be wired. The footer is a SIBLING of #file-list, never an
 * <li>, so the list stays exactly one <li> per photo. Still pure UI-state
 * aggregation - no layout math, no Excel work.
 *
 * v8.0 - "Generate & Download Excel" now opens a save dialog instead of
 * exporting straight away: it shows the file count, the COMPRESSED total size
 * (the line is hidden while the batch is incomplete, so a partial number is
 * never shown) and an editable base file name whose .xlsx extension the app
 * owns. Export stays the plain <a download> path - the one iOS Safari turns
 * into its Files/share sheet - and the optional auto-clear reuses clearFiles(),
 * so there is still exactly ONE path that empties the selection. Pure UI
 * plumbing: no layout math, no Excel work.
 *
 * v8.1 - dialog polish and a sticky choice: the visible heading and the hint
 * paragraph are gone (the overlay carries aria-label as its accessible name)
 * and the confirm button reads "Save". The auto-clear checkbox is now
 * remembered in its own localStorage key (photo2excel.autoclear), so it
 * survives reloads instead of resetting on every open, and the default file
 * name drops its hyphen: "Photo report DD.MM.YYYY".
 *
 * v8.2 - the default report date is no longer "today": it is the first photo
 * capture date, read once per selection in processFiles() from the RAW File
 * (the canvas preprocessing strips EXIF, so the processed blob cannot supply
 * it). The chain lives in compressor.js; a null result simply means today.
 *
 * v9.0 - the save dialog grows an explicit three-button export flow:
 * "Download Excel" (the existing path), "Download Photos & Excel in ZIP" and
 * "Cancel". The ZIP path builds the SAME workbook buffer once and hands it to
 * ZipExporter (zip-exporter.js) which packages it with the processed photo
 * blobs into a single .zip (STORE compression, photos/ folder, names taken
 * from state.layout). If the archive cannot be built (e.g. the JSZip CDN is
 * unavailable) the export falls back to the plain .xlsx download so the user
 * never loses the report. Pure delivery plumbing: no layout math, no Excel
 * logic changes.
 */
(function (global) {
  'use strict';

  const APP_VERSION = 'v9.0';

  // MAX_WIDTH, the JPEG quality bounds (0.15 / 0.95) and the KB-range defaults
  // all live in compressor.js (Compressor.MAX_WIDTH / .DEFAULT_MIN_KB / etc.).

  // Central app state; extended by later steps.
  const state = {
    files: [],           // Selected File objects.
    processedPhotos: [], // Canvas-processed photos (blob + dimensions).
    layout: [],          // Stage 1 output: [{ id, originalName, blob, x, y, width, height }].
    // v8.2 - capture date of the FIRST selected photo (Date|null). Read from the
    // raw File while it still carries EXIF; null means today.
    reportDate: null
  };

  // Monotonic token used to cancel stale preprocessing when selection changes.
  let processingToken = 0;
  let generating = false; // true while the Excel file is being built.
  let saveModalOpen = false; // v8.0 — true while the save dialog is visible.

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
    el.fileTotal = $('file-total');
    el.fileTotalSize = $('file-total-size');
    el.status = $('status');
    el.heightSelect = $('height-select');
    el.columnsSelect = $('columns-select');
    el.minKbInput = $('min-kb-input');
    el.maxKbInput = $('max-kb-input');
    el.presetControl = $('quality-preset');
    el.presetLabel = $('quality-preset-label');
    el.generateBtn = $('generate-btn');
    el.loader = $('loader');
    // v8.0 — save dialog.
    el.saveModal = $('save-modal');
    el.saveSummaryFiles = $('save-summary-files');
    el.saveSummarySize = $('save-summary-size');
    el.saveFilename = $('save-filename');
    el.saveAutoclear = $('save-autoclear');
    el.saveCancelBtn = $('save-cancel-btn');
    el.saveConfirmBtn = $('save-confirm-btn');
    el.saveZipBtn = $('save-zip-btn'); // v9.0 — ZIP export path.
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

  // v7.7 — coerce a byte count to a safe, summable number. A missing/negative/
  // non-finite size contributes 0 instead of poisoning the total with NaN.
  function safeBytes(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * v7.7 — Total the selection. Pure: reads nothing but its arguments, so it is
   * unit-testable outside the DOM.
   *
   *   originalBytes   sum of File.size over state.files
   *   compressedBytes sum of photo.bytes over state.processedPhotos
   *   complete        every selected file already has a compressed size, i.e. the
   *                   two sums describe the same set of photos. Only then is the
   *                   "original -> compressed" arrow meaningful; otherwise the
   *                   row would compare N originals against M compressed sizes.
   */
  function computeTotals(files, processedPhotos) {
    const list = Array.isArray(files) ? files : [];
    const processed = Array.isArray(processedPhotos) ? processedPhotos : [];
    const sum = (items, read) =>
      items.reduce((total, item) => total + safeBytes(read(item)), 0);

    return {
      count: list.length,
      originalBytes: sum(list, (file) => file && file.size),
      compressedBytes: sum(processed, (photo) => photo && photo.bytes),
      complete: list.length > 0 && processed.length === list.length
    };
  }

  // --- v8.0 save-dialog file naming -----------------------------------------
  // Pure, DOM-free helpers (published on window.AppTotals for the Node tier).
  // The app OWNS the extension: the field holds a base name only, and .xlsx is
  // attached in exactly one place - toXlsxFilename().
  const XLSX_EXT = '.xlsx';
  const FORBIDDEN_FILENAME_CHARS = /[\/\\:*?"<>|]/g; // the 9 OS-forbidden ones
  const CONTROL_CHARS = /[\u0000-\u001f]/g;

  // Drop a trailing .xlsx/.xls the user may have typed.
  function stripXlsxExtension(name) {
    return String(name == null ? '' : name).replace(/\.(xlsx|xls)$/i, '');
  }

  // Real-time sanitizer: the OS-forbidden characters, control characters, a
  // stale extension, surrounding whitespace, and the trailing dot/space that
  // Windows silently rejects. Only those characters are removed, so non-Latin
  // names (e.g. Cyrillic) pass through untouched.
  function sanitizeFilename(name) {
    return stripXlsxExtension(
      String(name == null ? '' : name)
        .replace(FORBIDDEN_FILENAME_CHARS, '')
        .replace(CONTROL_CHARS, '')
    )
      .trim()
      .replace(/[.\s]+$/, '');
  }

  // DD.MM.YYYY from LOCAL date parts - never toISOString(), which would shift
  // the day across the UTC boundary for anyone east or west of UTC.
  function formatReportDate(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // The default base name: "Photo report " + DD.MM.YYYY. v8.1 - space-separated
  // and hyphen-free. Only the DEFAULT is, though: a hyphen is a legal filename
  // character, so sanitizeFilename() still lets a user type one into a custom
  // name.
  function defaultReportName(date) {
    return `Photo report ${formatReportDate(date)}`;
  }

  // The ONLY place the extension is attached. Idempotent: a typed ".xlsx" is
  // stripped first, so the result always carries exactly one. An empty (or
  // fully sanitized-away) name falls back to the dated default.
  // v8.2 - `date` is threaded through so the empty-name fallback matches the
  // date the dialog pre-filled (the photo date, not necessarily today).
  function toXlsxFilename(base, date) {
    return (sanitizeFilename(base) || defaultReportName(date)) + XLSX_EXT;
  }
  // --- end v8.0 save-dialog file naming -------------------------------------

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

    renderFileTotals();
  }

  /**
   * v7.7 — Render the "Total Size:" footer.
   *
   * Called at the end of renderFileList() so every existing trigger (selection,
   * finished processing run, clear) refreshes it for free: no new event wiring
   * and no second source of truth for the sizes.
   *
   * Hidden whenever nothing is selected; the arrow appears only once the whole
   * selection has a compressed size (see computeTotals).
   */
  function renderFileTotals() {
    if (!el.fileTotal) return;

    const totals = computeTotals(state.files, state.processedPhotos);

    if (totals.count === 0) {
      el.fileTotal.hidden = true;
      if (el.fileTotalSize) el.fileTotalSize.textContent = '';
      return;
    }

    el.fileTotal.hidden = false;
    if (el.fileTotalSize) {
      el.fileTotalSize.textContent = totals.complete
        ? `${formatSize(totals.originalBytes)} \u2192 ${formatSize(
            totals.compressedBytes
          )}`
        : formatSize(totals.originalBytes);
    }
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

  // --- v8.1 auto-clear preference -------------------------------------------
  // The save dialog checkbox lives in its OWN key rather than in
  // photo2excel.settings: it is written on every toggle and must never be
  // gated by settingsLoaded (the v7.5 restore guard). The same best-effort
  // storage as the settings above is used, so a blocked or unavailable
  // localStorage simply reads as unchecked.
  const AUTOCLEAR_KEY = 'photo2excel.autoclear';

  // Exactly the string 'true' means checked: a missing, corrupt or unexpected
  // value can never break the dialog.
  function readAutoclearPreference() {
    return safeStorageGet(AUTOCLEAR_KEY) === 'true';
  }

  function saveAutoclearPreference(checked) {
    return safeStorageSet(AUTOCLEAR_KEY, checked ? 'true' : 'false');
  }
  // --- end v8.1 auto-clear preference ---------------------------------------

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

  // v8.2 - only the HEAD of the first photo is read: the EXIF APP1 segment sits
  // immediately after SOI, so 256 KB covers even a thumbnail-bearing one without
  // touching the (potentially 48 MP) rest of the file.
  const PHOTO_DATE_HEAD_BYTES = 256 * 1024;

  /**
   * Capture date of the first selected photo, or null when nothing usable was
   * found. EXIF comes first (Compressor.resolveCaptureDate), the file timestamp
   * second; null lets defaultReportName() render today.
   */
  async function readFirstPhotoDate(file) {
    if (!file) return null;

    const reader = global.Compressor && global.Compressor.resolveCaptureDate;
    const read = (bytes) =>
      typeof reader === 'function' ? reader(bytes, file.lastModified) : null;

    try {
      const head = await file.slice(0, PHOTO_DATE_HEAD_BYTES).arrayBuffer();
      return read(head);
    } catch (err) {
      console.warn(
        '[app] Could not read the photo date - using the file timestamp:',
        err
      );
      return read(null);
    }
  }

  // --- end v8.2 photo date --------------------------------------------------


  async function processFiles(files) {
    const token = ++processingToken;
    state.processedPhotos = [];
    state.reportDate = null; // v8.2 - recomputed for every run
    const total = files.length;

    if (total === 0) {
      // v7.3 — nothing to report yet: the idle text is owned by renderSummary().
      setStatus('');
      return;
    }

    // v8.2 - read the report date (first photo EXIF capture date) once per
    // run. Kick it off without blocking the encode loop; state.reportDate is
    // set when the head read resolves (or stays null and defaultReportName()
    // renders today). The deadline guard keeps stale resolutions out.
    readFirstPhotoDate(files[0]).then(date => {
      if (token === processingToken) state.reportDate = date;
    });
    if (token !== processingToken) return;

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
    state.reportDate = null; // v8.2 - no selection, no capture date
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

  function downloadBuffer(buffer, filename, mimeType) {
    const blob = new Blob([buffer], {
      type:
        mimeType ||
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

  /**
   * v8.0 — Open the save dialog.
   *
   * The metrics come from the SAME computeTotals()/formatSize() pair the file
   * list footer uses, so the popup can never disagree with the list behind it.
   * Only the COMPRESSED total is shown, and only once every selected photo
   * carries one: while a re-encode is in flight (or a photo failed) the number
   * would describe a partial batch, so the whole line is hidden instead.
   */
  function openSaveModal() {
    if (state.layout.length === 0 || generating || saveModalOpen) return;

    const totals = computeTotals(state.files, state.processedPhotos);
    el.saveSummaryFiles.textContent = `Photos quantity: ${totals.count}`;

    if (totals.complete && totals.compressedBytes > 0) {
      el.saveSummarySize.textContent =
        `Total size: ${formatSize(totals.compressedBytes)}`;
      el.saveSummarySize.hidden = false;
    } else {
      el.saveSummarySize.textContent = '';
      el.saveSummarySize.hidden = true;
    }

    // v8.2 - today only when the first photo had no usable capture date.
    el.saveFilename.value = defaultReportName(state.reportDate);
    el.saveAutoclear.checked = readAutoclearPreference(); // v8.1 - sticky
    el.saveModal.hidden = false;
    saveModalOpen = true;

    el.saveFilename.focus();
    el.saveFilename.setSelectionRange(0, el.saveFilename.value.length);
  }

  function closeSaveModal() {
    if (!saveModalOpen) return;
    el.saveModal.hidden = true;
    saveModalOpen = false;
  }

  // Real-time sanitization: the field may only ever hold a base name, so a
  // forbidden character (or a typed extension) disappears as it is entered.
  function onFilenameInput() {
    const clean = sanitizeFilename(el.saveFilename.value);
    if (clean !== el.saveFilename.value) el.saveFilename.value = clean;
  }

  // v8.1 - persist the checkbox the instant the user toggles it.
  function onAutoclearChanged() {
    saveAutoclearPreference(el.saveAutoclear.checked);
  }

  // ESC closes (a native <dialog> would do this for free; this overlay is a
  // <div>) and Enter in the name field confirms, which is the iOS keyboard's
  // "Done" key.
  function onModalKeydown(event) {
    if (!saveModalOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeSaveModal();
    } else if (event.key === 'Enter' && event.target === el.saveFilename) {
      event.preventDefault();
      confirmExport();
    }
  }

  /**
   * v8.0 — Export on confirmation ("Download Excel").
   *
   * The name is read from the dialog's base-name field; the extension is
   * attached here and nowhere else. Export uses the existing plain
   * <a download> path (downloadBuffer) — the one iOS Safari turns into its
   * Files/share sheet — so there is no File System Access API dependency.
   */
  async function confirmExport() {
    if (!saveModalOpen || generating) return;

    const filename = toXlsxFilename(el.saveFilename.value, state.reportDate);
    const autoClear = el.saveAutoclear.checked;

    closeSaveModal();

    generating = true;
    renderGenerateButton();
    setStatus('Generating Excel…');

    try {
      const buffer = await global.ExcelWriter.buildExcelWorkbook(state.layout);
      downloadBuffer(buffer, filename);

      // Clear BEFORE reporting: clearFiles() blanks the status line, so the
      // success message has to be written last to survive.
      if (autoClear) clearFiles();
      setStatus('Download started.');
    } catch (err) {
      console.error('[app] Excel generation failed:', err);
      setStatus('Failed to generate Excel — see console.');
      // Nothing was exported, so the selection is deliberately NOT cleared.
    } finally {
      generating = false;
      renderGenerateButton();
    }
  }

  /**
   * v9.0 — ZIP export ("Download Photos & Excel in ZIP").
   *
   * Builds the SAME workbook buffer the Excel path uses — exactly once — and
   * hands it to ZipExporter together with the processed photo blobs, which are
   * read from state.layout (the entries Stage 2 consumed; Stage 1/Stage 2 see
   * nothing new). The archive arrives as one Blob and goes through the same
   * single <a download> path, now as <base>.zip with application/zip.
   *
   * Failure policy: if the archive cannot be built (JSZip missing from the
   * CDN, or any ZIP-side error), the already-built workbook is downloaded as
   * the plain .xlsx instead — a CDN hiccup must never cost the user the
   * report. The selection is NOT cleared on that fallback (auto-clear only
   * ever runs after the export the user asked for).
   */
  async function confirmZipExport() {
    if (!saveModalOpen || generating) return;

    const xlsxName = toXlsxFilename(el.saveFilename.value, state.reportDate);
    const zipName = xlsxName.replace(/\.xlsx$/i, '.zip');
    const autoClear = el.saveAutoclear.checked;

    closeSaveModal();

    generating = true;
    renderGenerateButton();
    setStatus('Generating ZIP…');

    try {
      const buffer = await global.ExcelWriter.buildExcelWorkbook(state.layout);

      let zipBlob = null;
      try {
        zipBlob = await global.ZipExporter.buildZipBlob({
          xlsxBuffer: buffer,
          xlsxName: xlsxName,
          photos: state.layout
        });
      } catch (zipErr) {
        console.warn('[app] ZIP packaging failed — falling back to Excel:', zipErr);
      }

      if (zipBlob) {
        downloadBuffer(zipBlob, zipName, 'application/zip');
      } else {
        downloadBuffer(buffer, xlsxName);
      }

      // Clear BEFORE reporting: clearFiles() blanks the status line, so the
      // success message has to be written last to survive. The fallback still
      // delivered an Excel export, so auto-clear applies to it exactly as it
      // does on the plain Excel path.
      if (autoClear) clearFiles();
      setStatus(zipBlob ? 'Download started.' : 'ZIP failed — Excel downloaded instead.');
    } catch (err) {
      console.error('[app] ZIP export failed:', err);
      setStatus('Failed to generate ZIP — see console.');
      // Nothing was exported, so the selection is deliberately NOT cleared.
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
    // v8.0 — the button opens the save dialog; the export runs on confirm.
    // v9.0 — the dialog now has TWO export triggers: the arrows are explicit
    // because confirmExport()/confirmZipExport() take no event arguments.
    el.generateBtn.addEventListener('click', openSaveModal);
    el.saveConfirmBtn.addEventListener('click', () => confirmExport());
    el.saveZipBtn.addEventListener('click', () => confirmZipExport());
    el.saveCancelBtn.addEventListener('click', closeSaveModal);
    el.saveFilename.addEventListener('input', onFilenameInput);
    // v8.1 - remember the auto-clear choice the instant it is toggled.
    el.saveAutoclear.addEventListener('change', onAutoclearChanged);
    // Backdrop click (the overlay itself) closes; clicks inside the card do not.
    el.saveModal.addEventListener('click', (event) => {
      if (event.target === el.saveModal) closeSaveModal();
    });
    document.addEventListener('keydown', onModalKeydown);
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
    // v8.1 - restore the save dialog auto-clear choice from its own key, so the
    // checkbox is already correct the first time the dialog is opened. A restore
    // never writes back.
    if (el.saveAutoclear) el.saveAutoclear.checked = readAutoclearPreference();
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

  // v7.7 — read-only surface for the pure byte/formatting logic, so the Node
  // test tier can exercise it directly. app.js is otherwise a closed IIFE; this
  // mirrors the global.Layout / global.Compressor / global.ExcelWriter pattern
  // the other modules already follow. The app itself never reads it.
  global.AppTotals = {
    VERSION: APP_VERSION,
    formatSize: formatSize,
    computeTotals: computeTotals,
    sanitizeFilename: sanitizeFilename,
    formatReportDate: formatReportDate,
    defaultReportName: defaultReportName,
    toXlsxFilename: toXlsxFilename
  };

  // Scripts are deferred and loaded in order, so this fires after parsing.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
