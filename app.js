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
 * v26.0 - UI cleanup: the dialog drops the "Photos quantity" metric and the
 * auto-clear checkbox (and its photo2excel.autoclear preference), the disk
 * size line is relabelled "Total size Excel:", and the three export actions
 * gain a larger separation from the name fields.
 *
 * v29.0 - WEB SHARE TARGET: the app can now be picked from the OS share sheet
 * (Android Chrome / desktop Chromium) and receive photos directly. The manifest
 * registers ./share-target as a multipart POST target; sw.js intercepts that
 * POST (the page never sees a request body), queues the images through the
 * shared ShareTarget IndexedDB store and 303-redirects to the app shell. app.js
 * pulls the queue on launch / pageshow / focus and funnels the photos into the
 * SAME ingest -> sort -> compress -> Stage 1 -> Stage 2 path the file picker
 * uses; the temporary queue rows are deleted the moment they are consumed.
 * iOS Safari / WebKit does not implement Web Share Target at all, so there the
 * feature is inert and the unchanged "Choose photos" picker remains the way in.
 * No layout math, no Excel work.
 *
 * v30.1 - TEST HARNESS REFRESH (no shipped behaviour change): the Phase 2/3
 * browser harness (_selftest/app-e2e.js) still asserted UI that later versions
 * had intentionally removed, so it crashed on a null #file-total footer and the
 * whole Phase 3 workbook inspection never ran. The three stale checks are
 * re-pointed at the CURRENT contract: the batch summary is the single
 * state-driven #file-summary line in the top status bar (v9.1) that reads
 * "Total size: a -> b" and is not a row of the file list, per-row values still
 * use .file-size, and standalone mode paints NO status-bar band because the
 * v7.2 strip was removed in v20.0. All landed sizes, the module versions and
 * the service worker cache key now read v30.1 so the badge, package.json and
 * CACHE_NAME stay in lockstep.
 *
 * v30.0 - FULLSCREEN PHOTO VIEWER: tapping any file-list row (the thumbnail or
 * the text, never its remove cross) opens a card-style overlay showing the
 * ORIGINAL high-res preview, with two round floating actions: Delete (drops the
 * photo through the existing removeFile() path and slides the next one in, or
 * closes when the batch is now empty) and Keep (simply closes). Esc closes and
 * Delete / Backspace removes; the backdrop dismisses. The viewer owns NO Object
 * URLs - it reuses the selection's existing thumbnailUrls[index] - so closing
 * revokes nothing and deleting relies on the one revoke removeFile() already
 * performs. Pure UI plumbing: no layout math, no Excel work.
 *
 * v28.0 - PHOTO THUMBNAIL SIZE: the file-list preview box (.photo-thumb in
 * style.css) grows by exactly 0.6 mm - width/height move from 44px to
 * calc(44px + 0.6mm), i.e. roughly 46.27px at the 96 CSS-DPI reference. Only
 * the CSS geometry changes: object-fit: cover, the 8px radius and
 * flex: 0 0 auto are untouched, the placeholder shares the same box, and the
 * filename slot (flex: 1 1 auto with min-width: 0) still absorbs the extra
 * ~2.3px, so no row overflows on iOS Safari. No layout math, no Excel work.
 *
 * v27.0 - DESKTOP LAYOUT PREVIEW: a new "Preview Layout" button opens a
 * fullscreen-capable modal that renders the EXACT Stage 1 rectangles over a
 * simulated default Excel grid (A/B/C columns, 1/2/3 rows, 64x20 px cells).
 * preview.js owns rendering, zoom controls, pinch zoom, panning and the
 * preview-owned Object URLs; app.js only enables the button once the current
 * layout is complete and forwards state.layout unchanged. No layout math and
 * no Excel work are added here.
 *
 * v17.0 - the Layout fieldset's two dropdown selects ("Photo height" and
 * "Columns") become minimalist stepper controls: a minus button, the live
 * value and a plus button inside one rounded, outline-only container. Each
 * stepper keeps its stops in data-options (heights 6-24 cm in 2 cm steps,
 * columns 1-15) and the current setting in data-value, so the DOM stays the
 * single
 * source of truth exactly as with the selects. readLayoutOptions() and
 * readSettings() read the same numbers, loadSettings() validates restored
 * values against data-options (the selectHasOption() guard in a new form)
 * and the persisted payload keeps its { heightCm, columns } shape - no
 * storage migration. setupStepper() drives both controls through one
 * delegated click handler that only ever funnels into the existing
 * onLayoutSettingChanged() path. Pure UI plumbing - no layout math, no
 * Excel work.
 *
 * v18.0 - the stepper ranges expand. Photo height gains stops 6/14/16/18/20/
 * 22/24 cm (range 6-24, step 2) and Columns gains stops 5-15 (range 1-15,
 * step 1), both defined in index.html's data-options. The stepper machinery
 * (getStepperOptions/setStepperValue/setupStepper) is untouched - the
 * boundary disables, the bounds guard and the stepperHasOption() restore
 * validation all derive from data-options, so they widen for free. The
 * columns DEFAULT falls back to 4 (the new markup default). layout.js v7.4
 * widens its own columns clamp to [1, 15] so Stage 1 honours every new stop;
 * the H_px = H_cm x 37.8 conversion already covers 6-24 cm with no change.
 *
 * v20.0 - ZOOM LOCK & SAFE-AREA ALIGNMENT: document-level gesturestart/
 * gesturechange/gestureend preventDefault() guards block iOS pinch-zoom in
 * both Safari and the standalone PWA (complementing the viewport meta and
 * CSS touch-action: manipulation in style.css), so rapid double-taps on
 * buttons can no longer trigger a layout zoom. The theme/status-bar colors
 * move to the body background (#f5f5f7) in index.html/manifest.json and the
 * v7.2 blue status-bar strip is removed, so the notch area blends into the
 * app background. Pure UI plumbing: no layout math, no Excel work.
 *
 * v19.0 - iOS SHARE SHEET EXPORT: without the picker the finished file goes
 * through saveOrShareFile(), which offers it to navigator.share({ files })
 * whenever navigator.canShare accepts it -
 * iOS Safari / iOS Chrome open the native share sheet whose "Save to Files",
 * iCloud, AirDrop and app rows replace the forced Downloads drop. The sheet
 * needs the FINISHED file, so it is called after the workbook / archive build;
 * if by then the click's transient user activation has expired (NotAllowedError)
 * - or the API is simply absent (desktop Firefox, jsdom) - the export silently
 * degrades to the unchanged <a download> path, so it can never be lost.
 * Dismissing the sheet (AbortError) is a quiet no-op: nothing downloaded, the
 * selection survives for a retry, no error toast. The picker keeps priority on
 * desktop Chrome/Edge (the only transport where the user edits the folder AND
 * the name), so v14.0 behaviour is untouched there. Pure delivery plumbing:
 * no layout math, no Excel work, still one download path - now three transports.
 *
 * v9.2 - all uploaded photos are sorted before anything else happens: the
 * primary key is the EXIF capture date (DateTimeOriginal / CreateDate) from
 * compressor.js, ascending (oldest first -> newest last); when two photos
 * share an identical capture date — or when EXIF is missing entirely — the
 * tie-breaker is the original filename in natural numeric order
 * (localeCompare with { numeric: true, sensitivity: 'base' }), so
 * IMG_4490.jpg strictly precedes IMG_4501.jpg and photo_2.jpg precedes
 * photo_10.jpg. Sorting runs in the ingest stage (readSortKeys ->
 * sortPhotoKeys) right after the EXIF head read and before the preview grid,
 * the total-size math, the layout stage and the ZIP assembly, so the order is
 * consistent everywhere. The default report date becomes the EARLIEST capture
 * date in the batch instead of the first selected photo, so the name labels
 * the whole batch by its oldest photo.
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
 *
 * v9.1 - the photo-grid "Total Size:" footer is removed; its summary now
 * lives in the top status bar (#file-summary). The line is state-driven:
 * "No photos selected." at idle, "N photos selected." while keys are read,
 * and "Total size: {original} -> {compressed}" once computeTotals()
 * reports a complete batch (every photo has a compressed size). The math
 * itself is unchanged - still computeTotals()/formatSize() - only the
 * presentation target moves. Render path is still the single
 * renderSummary(), now also called at the end of processFiles().
 *
 * v10.0 - the visual-to-Excel sequence guarantee is locked by tests end to end.
 * The pipeline already carried the array order through unchanged (v9.2 sorting
 * -> preview grid -> Stage 1 -> Stage 2), so this release adds NO logic: the
 * only source changes are the written ORDER CONTRACT in layout.js and excel.js
 * (array index 0 = top-left / oldest, index N = bottom-right / newest, with no
 * sorting and no secondary grouping by orientation or dimensions). The new
 * tests/unit/layout-order.test.js pins row-major Stage 1 placement and
 * tests/lib/excel-order.test.js pins array-order Stage 2 insertion, so a later
 * refactor cannot silently break the visual-to-Excel synchronisation.
 *
 * v11.0 - ZIP ROOT FOLDER: the archive, its single top-level folder and the
 * workbook all share ONE base name. confirmZipExport() derives reportBaseName
 * from the SAME toXlsxFilename() result it always used, hands it to ZipExporter
 * as spec.rootFolder and downloads <reportName>.zip, so opening the archive
 * shows only <reportName>/ containing <reportName>.xlsx and the compressed
 * photos (original names preserved - no photo_N renumbering). No layout math,
 * no Excel logic and no change to what the save dialog shows: pure archive
 * plumbing. The .xlsx fallback path is untouched.
 *
 * v12.0 - SPLIT NAME FIELDS: the save dialog's single name input becomes two
 * side-by-side controls - a DATE field (left, auto-filled with the detected
 * report date via formatReportDate(state.reportDate) and freely editable) and
 * a BASE NAME field (right, default "Photo report") - followed by the
 * app-owned .xlsx label. The parts are joined by ONE pure helper,
 * toXlsxFilename(dateText, baseText, fallbackDate), which sanitizes each part
 * separately and joins them with ONE space (v21.0), so the date is ALWAYS the
 * strict prefix: <date> <Name>.xlsx. An emptied date falls back to the detected
 * date (today
 * when none) and an emptied base name to "Photo report", so the name can never
 * collapse to an extension. The date field gets a lighter live sanitizer
 * (sanitizeDatePart) that keeps dots, because the full sanitizeFilename()
 * strips trailing dots and would make "19.MM.YYYY" impossible to type
 * character by character. The ZIP path needs no change: its archive name,
 * root folder and inner workbook all still derive from the same
 * toXlsxFilename() result. No layout math, no Excel work.
 *
 * v13.0 - LANDSCAPE ROW CAP (layout.js v7.3): a hard capacity limit of THREE
 * horizontal photos (width > height) per row now applies at every print height
 * preset. The effective cap is Math.min(3, columns), so a lower user setting
 * (1 or 2) is respected instead of being widened to 3, while portrait and
 * square photos keep the plain `columns` behaviour. The wrap is HARD: it fires
 * right after the 3rd landscape photo is placed, so the next photo opens a new
 * row even when it is a portrait. The change lives entirely in Stage 1
 * (layout.js), so app.js needs no logic change - readLayoutOptions() already
 * hands the user's columns to calculateLayout() - and Stage 2 (excel.js) keeps
 * consuming the coordinates as-is.
 *
 * v14.0 - the export delivery step gains the native "Save As" dialog. Both
 * export buttons ("Download Excel", "Download Photos & Excel in ZIP") now ask
 * for a FileSystemFileHandle via window.showSaveFilePicker() FIRST - while the
 * click's transient user activation is still alive, because a long ExcelJS /
 * JSZip build can outlive it - and then stream the finished Blob into the
 * chosen file (createWritable -> write -> close). The user picks the folder and
 * edits the name in the OS dialog, and a cancelled dialog (AbortError) is a
 * quiet no-op: nothing is generated, nothing is cleared, no alert. Browsers
 * without the API (iOS Safari, Firefox) keep the pre-v14.0 <a download> path
 * unchanged, so iOS still gets its Files/share sheet. Delivery plumbing only:
 * no layout math, no Excel work, one download path - now with two transports.
 *
 * v15.0 - every row of the preview grid now starts with an iOS-style square
 * thumbnail: a square <img class="photo-thumb"> (border-radius 8px,
 * object-fit: cover) rendered BEFORE the filename. The preview URL comes from
 * URL.createObjectURL(file) on the ORIGINAL File, so it is instant, needs no
 * extra decode of the compressed blob, and appears while compression is still
 * in flight. Because renderFileList() runs several times per selection (select,
 * after compression, after a KB-range re-compression), the URLs are created
 * ONCE per selection in onFilesSelected() - after the v9.2 EXIF sort, so the
 * list is index-aligned with the sorted files - and handed out by index during
 * render. revokeThumbnails() releases every URL when the selection is replaced
 * or emptied: clearFiles() covers the explicit Clear button (v26.0 removed the
 * save-dialog auto-clear), so there is exactly one path that empties the
 * selection and exactly one that frees the previews. Browsers without createObjectURL (and
 * any failed decode) fall back to a .photo-thumb-placeholder box instead of a
 * broken image. Pure UI plumbing: no layout math, no Excel work.
 *
 * v16.0 - each row now ends with a 44x44 remove button (a compact black ×)
 * that deletes just that photo. removeFile(index) cancels in-flight processing
 * (same token bump as clearFiles), revokes that row's Object URL, splices
 * files / sortKeys / thumbnailUrls, RE-KEYS the remaining processedPhotos ids
 * (id === removed drops, id > removed decrements) so runLayout() - the single
 * source of truth - rebuilds state.layout and re-enables/disables Generate.
 * The report date recomputes from state.sortKeys, now stored at selection so
 * removals need no re-EXIF parse. Clicks are one delegated listener on
 * #file-list, so re-renders never re-arm handlers. Pure UI/state plumbing: no
 * layout math, no Excel work.
 *
 * v21.0 - FILENAME SPACING + CAPITALIZATION: the save dialog's two fields are
 * now joined by ONE plain space instead of "_", so a report reads
 * "20.11.2026 Steering gear.xlsx" and no underscore can ever trail the date.
 * Two helper-level changes make that name typeable and printable: (1) the BASE
 * NAME field gets its own lighter live sanitizer, sanitizeNameLive(), which
 * strips only the OS-forbidden / control characters and KEEPS spaces, dots and
 * anything else the user types - the heavier sanitizeFilename() (trim, trailing
 * dot/space strip, typed-extension strip) now runs once, on export, exactly as
 * it does for the DATE field; (2) toXlsxFilename() capitalizes the first letter
 * of the name part with capitalizeFirstLetter() ("steering gear" ->
 * "Steering gear"), leaving the date part and the rest of the user's casing
 * untouched. Still the ONLY join point and the ONLY place the extension is
 * attached, so the ZIP archive name, its root folder and the inner workbook all
 * pick the new format up for free. Pure name formatting: no layout math, no
 * v22.0 - 1 MM ROW GAP + VERTICAL JITTER (the Stage 1 hand-off): the layout
 * options now describe layout.js v8.0's vertical surface - rowGapPx (4 px =
 * 1 mm), rowJitterPx (+/-3 px) and photoJitterPx (+/-1 px) - replacing the old
 * vertical stack (baseGapPx + verticalGapPx, both removed in layout.js v8.0).
 * The horizontal contract is byte-identical: horizontalBaseGapPx (3 px) and
 * gapJitterPx (1 px) are still handed over exactly as before, so only the
 * between-row geometry changes. readLayoutOptions() stays the ONE place where
 * the app configures Stage 1. Pure option plumbing: no layout math, no Excel
 * work.
 *
 * v23.0 - CLEAN ZIP PAYLOAD: the ZIP delivery stage (zip-exporter.js) now
 * bundles an explicit allowlist - the .xlsx workbook plus .jpg photos - so no
 * .txt / .json / manifest / metadata entry can appear inside the archive. The
 * app's own export flow is unchanged: ZipExporter.buildZipBlob() is still the
 * single call site and still receives the workbook buffer and the processed
 * photo blobs from state.layout. Pure delivery plumbing: no layout math, no
 * Excel work.
 *
 * v24.0 - iOS SIDECAR FIX (share payload): navigator.share() is now called with
 * a FILES-ONLY payload - { files: [file] } and nothing else. iOS WebKit turns a
 * string `title` (or `text` / `url`) sent alongside `files` into a SEPARATE share
 * item, so "Save to Files" wrote a stray text.txt / text 2.txt next to the saved
 * .zip. File.name already names the saved file, so the string is dropped without
 * losing anything. The picker and <a download> transports are unchanged (they
 * were already clean: typed Blob, one click, no string payload).
 *
 * v25.0 - FIRST-PAINT SPLASH SCREEN: index.html now paints a full-viewport
 * #splash-screen (inline SVG emblem + spinner, critical CSS in <head>) before
 * the deferred modules run, so launching the PWA never shows a blank white
 * frame. An inline PhotoReportSplash controller owns the fade-out, the DOM
 * removal after the transition and a 2.5s fail-safe that starts even when a
 * stalled CDN bundle delays app.js. init() calls that same idempotent
 * dismiss() once the DOM is hydrated and the listeners are bound. Pure
 * startup UI plumbing: no layout math, no Excel work.
 */
(function (global) {
  'use strict';

  const APP_VERSION = 'v30.1';

  // MAX_WIDTH, the JPEG quality bounds (0.15 / 0.95) and the KB-range defaults
  // all live in compressor.js (Compressor.MAX_WIDTH / .DEFAULT_MIN_KB / etc.).

  // Central app state; extended by later steps.
  const state = {
    files: [],           // Selected File objects.
    processedPhotos: [], // Canvas-processed photos (blob + dimensions).
    layout: [],          // Stage 1 output: [{ id, originalName, blob, x, y, width, height }].
    // v16.0 - the per-file sort keys captured at selection time (same order as
    // files). Removing a photo re-filters this list so the report date can be
    // recomputed without re-reading EXIF headers.
    sortKeys: [],
    // v8.2 - capture date of the FIRST selected photo (Date|null). Read from the
    // raw File while it still carries EXIF; null means today.
    reportDate: null
  };

  // v15.0 — Object URLs of the preview thumbnails, index-aligned with
  // state.files. Created ONCE per selection (see onFilesSelected) and released
  // by revokeThumbnails() when the selection is replaced or emptied, so the
  // browser can reclaim the previews instead of holding one blob URL per photo
  // for the rest of the session.
  let thumbnailUrls = [];

  /**
   * Release every preview Object URL of the current selection.
   * Best-effort and idempotent: the array is emptied FIRST, so a second call
   * (or a call after the URLs were already handed back) is a harmless no-op
   * instead of a double revoke. Guarded because a browser without
   * revokeObjectURL must not break Clear.
   */
  function revokeThumbnails() {
    const urls = thumbnailUrls;
    thumbnailUrls = [];
    if (typeof URL.revokeObjectURL !== 'function') return;
    urls.forEach((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }

  /**
   * Build the preview URLs for a selection, in display order.
   * One createObjectURL(file) per File against the ORIGINAL upload: no extra
   * decode of the compressed blob and the preview is ready immediately, while
   * compression is still running. A browser without createObjectURL (jsdom,
   * very old engines) or a file the browser refuses to hand out yields null,
   * which renderFileList() turns into the placeholder box.
   */
  function createThumbnails(files) {
    const canCreate = typeof URL.createObjectURL === 'function';
    return files.map((file) => {
      if (!canCreate) return null;
      try {
        return URL.createObjectURL(file);
      } catch (err) {
        console.warn('[app] Thumbnail preview unavailable:', err);
        return null;
      }
    });
  }

  /**
   * v15.0 — the square preview box that opens every row (v28.0: its size is
   * calc(44px + 0.6mm) in style.css).
   * Prefers the <img> built from this selection's Object URL; without a URL it
   * degrades to the same-size placeholder, so the row keeps its geometry either
   * way. Marked aria-hidden: the filename is the row's accessible label and the
   * thumbnail is decorative, so assistive tech is not read a second, empty name.
   */
  function createThumbnail(url) {
    if (!url) return createThumbnailPlaceholder();

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = url;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    img.decoding = 'async';
    // A URL can still fail to decode (unreadable file, revoked too early): swap
    // the placeholder in rather than leaving the broken-image glyph in the row.
    img.addEventListener('error', () => {
      if (img.parentNode) {
        img.parentNode.replaceChild(createThumbnailPlaceholder(), img);
      }
    });
    return img;
  }

  function createThumbnailPlaceholder() {
    const box = document.createElement('span');
    box.className = 'photo-thumb photo-thumb-placeholder';
    box.textContent = '\u{1F4F7}'; // camera glyph
    box.setAttribute('aria-hidden', 'true');
    return box;
  }

  // Monotonic token used to cancel stale preprocessing when selection changes.
  let processingToken = 0;
  let generating = false; // true while the Excel file is being built.
  // v27.0 — true while a batch is being (re)compressed. The preview button
  // must stay disabled then, because state.layout still describes the previous
  // run and a stale preview would not match the next export.
  let processing = false;
  let saveModalOpen = false; // v8.0 — true while the save dialog is visible.
  // v29.0 — true while a shared batch is being pulled from the Web Share Target
  // queue. Serializes the launch / pageshow / focus triggers so the same batch
  // is never imported twice (the queue read+delete itself is already atomic).
  let ingestingShares = false;
  // v30.0 — fullscreen photo viewer (card style). `photoViewerOpen` mirrors the
  // overlay's visibility; `viewerIndex` is the position in state.files that is
  // currently on screen (-1 while closed). The viewer owns NO Object URLs: it
  // displays thumbnailUrls[viewerIndex] and lets the list/removeFile/clearFiles
  // paths keep owning their lifetime.
  let photoViewerOpen = false;
  let viewerIndex = -1;

  // v7.5 — false until startup hydration has finished, so a restore never writes
  // the store back to itself. From then on anything the user changes persists.
  let settingsLoaded = false;

  const el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheDom() {
    el.versionBadge = $('version-badge');
    // v25.0 - cached once; dismissal re-reads by id so a missing node can
    // never break init().
    el.splashScreen = $('splash-screen');
    el.photoInput = $('photo-input');
    el.clearBtn = $('clear-btn');
    el.fileSummary = $('file-summary');
    el.fileList = $('file-list');
    el.status = $('status');
    // v17.0 — steppers replace the layout dropdown selects. The container is
    // cached; its value span and buttons are reached through it.
    el.heightStepper = $('height-stepper');
    el.columnsStepper = $('columns-stepper');
    el.minKbInput = $('min-kb-input');
    el.maxKbInput = $('max-kb-input');
    el.presetControl = $('quality-preset');
    el.presetLabel = $('quality-preset-label');
    el.generateBtn = $('generate-btn');
    el.loader = $('loader');
    // v8.0 — save dialog.
    el.saveModal = $('save-modal');
    // v26.0 — the "Photos quantity" metric is gone; only the compressed total
    // remains in the dialog summary.
    el.saveSummarySize = $('save-summary-size');
    el.saveFilename = $('save-filename');
    el.saveDate = $('save-date'); // v12.0 — date part of the file name.
    el.saveCancelBtn = $('save-cancel-btn');
    el.saveConfirmBtn = $('save-confirm-btn');
    el.saveZipBtn = $('save-zip-btn'); // v9.0 — ZIP export path.
    // v27.0 — desktop Excel layout preview.
    el.previewBtn = $('preview-btn');
    el.previewModal = $('preview-modal');
    el.previewViewport = $('preview-viewport');
    el.previewScrollContent = $('preview-scroll-content');
    el.previewStage = $('preview-stage');
    el.previewColumnHeaders = $('preview-column-headers');
    el.previewRowHeaders = $('preview-row-headers');
    el.previewGrid = $('preview-grid');
    el.previewPhotos = $('preview-photos');
    el.previewZoomLabel = $('preview-zoom-label');
    el.previewZoomInBtn = $('preview-zoom-in');
    el.previewZoomOutBtn = $('preview-zoom-out');
    el.previewZoomFitBtn = $('preview-zoom-fit');
    el.previewCloseBtn = $('preview-close');
    // v30.0 — fullscreen photo viewer (card style).
    el.photoViewerModal = $('photo-viewer-modal');
    el.photoViewerImg = $('photo-viewer-img');
    el.photoViewerPlaceholder = $('photo-viewer-placeholder');
    el.photoViewerName = $('photo-viewer-name');
    el.photoViewerCounter = $('photo-viewer-counter');
    el.photoViewerCloseBtn = $('photo-viewer-close');
    el.photoViewerDeleteBtn = $('photo-viewer-delete');
    el.photoViewerKeepBtn = $('photo-viewer-keep');
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
  // The app OWNS the extension: v12.0 - the dialog now has a DATE field and a
  // BASE NAME field, and the two are joined (with ONE space since v21.0) and
  // given their .xlsx in exactly one place - toXlsxFilename().
  const XLSX_EXT = '.xlsx';
  const FORBIDDEN_FILENAME_CHARS = /[\/\\:*?"<>|]/g; // the 9 OS-forbidden ones
  const CONTROL_CHARS = /[\u0000-\u001f]/g;

  // Drop a trailing .xlsx/.xls the user may have typed.
  function stripXlsxExtension(name) {
    return String(name == null ? '' : name).replace(/\.(xlsx|xls)$/i, '');
  }

  // Export-time sanitizer: the OS-forbidden characters, control characters, a
  // stale extension, surrounding whitespace, and the trailing dot/space that
  // Windows silently rejects. Only those characters are removed, so non-Latin
  // names (e.g. Cyrillic) and the INTERNAL spaces of a multi-word name pass
  // through untouched. Since v21.0 this runs once, on export - the live typing
  // pass goes through sanitizeNameLive() below.
  function sanitizeFilename(name) {
    return stripXlsxExtension(
      String(name == null ? '' : name)
        .replace(FORBIDDEN_FILENAME_CHARS, '')
        .replace(CONTROL_CHARS, '')
    )
      .trim()
      .replace(/[.\s]+$/, '');
  }

  // v12.0 — the DATE field's live sanitizer. Deliberately lighter than
  // sanitizeFilename(): it removes only what the OS forbids (plus control
  // characters) and KEEPS dots, because that sanitizer's trailing-dot strip
  // would erase the "." the instant the user types "19." on the way to
  // "19.09.2026". The full sanitize runs once, on export.
  function sanitizeDatePart(text) {
    return String(text == null ? '' : text)
      .replace(FORBIDDEN_FILENAME_CHARS, '')
      .replace(CONTROL_CHARS, '');
  }

  // v21.0 — the BASE NAME field's live sanitizer, the sibling of
  // sanitizeDatePart(). Deliberately lighter than sanitizeFilename(): it removes
  // only what the OS forbids (plus control characters) and KEEPS spaces, dots
  // and any typed extension, because the heavier sanitizer's trim() +
  // trailing-"."/space strip would eat the spacebar the instant the user pressed
  // it and make a name like "steering gear" impossible to type. The full
  // sanitize runs once, on export.
  function sanitizeNameLive(text) {
    return String(text == null ? '' : text)
      .replace(FORBIDDEN_FILENAME_CHARS, '')
      .replace(CONTROL_CHARS, '');
  }

  // v21.0 — capitalize the first letter of the user's report name, so a typed
  // "steering gear" is saved as "Steering gear". Only the FIRST character is
  // touched (the rest keeps the user's own casing) and toUpperCase() is
  // Unicode-aware, so Cyrillic names ("отчёт" -> "Отчёт") capitalize too.
  function capitalizeFirstLetter(text) {
    const s = String(text == null ? '' : text);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // DD.MM.YYYY from LOCAL date parts - never toISOString(), which would shift
  // the day across the UTC boundary for anyone east or west of UTC.
  function formatReportDate(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  }

  // v12.0 — the two halves of the ONE default name the dialog pre-fills: the
  // detected date lands in the left field, DEFAULT_BASE_NAME in the right one.
  // v8.1 - space-separated and hyphen-free. Only the DEFAULT is, though: a
  // hyphen is a legal filename character, so sanitizeFilename() still lets a
  // user type one into a custom name.
  const DEFAULT_BASE_NAME = 'Photo report';
  // v21.0 — ONE plain space, not "_": the file reads "20.11.2026 Steering
  // gear.xlsx" instead of "20.11.2026_steering gear.xlsx", and no underscore
  // can ever trail the date. The date part is already trimmed of trailing
  // dots/spaces by sanitizeFilename(), so the join produces a single clean gap.
  const NAME_SEPARATOR = ' ';

  function defaultBaseName() {
    return DEFAULT_BASE_NAME;
  }

  // The ONLY place the extension is attached and the ONLY place the two fields
  // are joined. Each part is sanitized on its own (trimmed, forbidden characters
  // and a typed extension removed, trailing dots/spaces stripped), so the date
  // always lands as the strict prefix without any trailing separator:
  // <DD.MM.YYYY> <Capitalized name>.xlsx. v21.0 — the name part is additionally
  // capitalized on its FIRST letter only. An emptied date falls back to the
  // dialog's detected date (today when none was detected) and an emptied base
  // name to DEFAULT_BASE_NAME, so a cleared field can never produce a nameless
  // file or an extension-only name. Idempotent: a typed ".xlsx" in either part
  // is stripped first, so the result always carries exactly one extension.
  function toXlsxFilename(dateText, baseText, fallbackDate) {
    const datePart =
      sanitizeFilename(dateText) || formatReportDate(fallbackDate);
    const namePart =
      capitalizeFirstLetter(sanitizeFilename(baseText)) || DEFAULT_BASE_NAME;
    return datePart + NAME_SEPARATOR + namePart + XLSX_EXT;
  }
  // --- end v8.0 save-dialog file naming -------------------------------------

  function updateVersionBadge() {
    el.versionBadge.textContent = APP_VERSION;
  }

  /**
   * Repaint the preview grid from state.files (one <li> per photo).
   * v15.0 — each row is [thumbnail, filename, size]: the square preview comes
   * from thumbnailUrls[index], which onFilesSelected() built in the SAME order,
   * so a row can never show another photo's picture. Renders (and re-renders,
   * after compression) reuse those URLs instead of creating new ones.
   */
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

      // v16.0 - the remove cross opens every row BEFORE the filename.
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-remove-btn';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', `Remove ${file.name}`);

      li.append(createThumbnail(thumbnailUrls[index]), name, size, remove);
      el.fileList.appendChild(li);
    });
  }

  function renderSummary() {
    const totals = computeTotals(state.files, state.processedPhotos);
    if (totals.count === 0) {
      el.fileSummary.textContent = 'No photos selected.';
    } else if (totals.complete) {
      el.fileSummary.textContent =
        `Total size: ${formatSize(totals.originalBytes)} → ${formatSize(
          totals.compressedBytes
        )}`;
    } else {
      el.fileSummary.textContent =
        `${totals.count} photo${totals.count === 1 ? '' : 's'} selected.`;
    }
    el.clearBtn.disabled = totals.count === 0;
  }

  // v7.3 — #status is the transient *activity* channel (processing / generating /
  // download feedback). It has no idle fallback: an empty message clears the line
  // and hides it, so the "no photos" state is rendered once by renderSummary().
  // v9.1 — renderSummary() now also shows the "Total size: -> " summary when
  // computeTotals() reports a complete batch; the line keeps its count/idle text
  // while compression is in flight.
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
        heightCm: parseFloat(el.heightStepper.dataset.value),
        columns: parseInt(el.columnsStepper.dataset.value, 10)
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

  // v17.0 — does this stepper still offer the stored value? Same guard as the
  // old selectHasOption(): a value that a later version removed from the
  // markup must never hydrate the control (which would blank it).
  function stepperHasOption(stepper, value) {
    if (!stepper) return false;
    const target = Number(value);
    return getStepperOptions(stepper).indexOf(target) !== -1;
  }

  /**
   * Restore saved preferences into the controls.
   *
   * Returns the preset index the segmented control should be normalized with, or
   * null when nothing usable was stored — in that case the markup defaults stay
   * exactly as they are (10 cm / 4 columns / 80 / 220 KB / Custom).
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

    if (stepperHasOption(el.heightStepper, layout.heightCm)) {
      setStepperValue(el.heightStepper, Number(layout.heightCm));
    }
    if (stepperHasOption(el.columnsStepper, layout.columns)) {
      setStepperValue(el.columnsStepper, Number(layout.columns));
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

  // --- v17.0 stepper controls (photo height & columns) ----------------------
  // A stepper is [−] value [+] in one container. data-options lists the
  // allowed stops in ascending order, data-value holds the live setting and
  // data-suffix decorates the value display (" cm" for heights). The DOM
  // stays the single source of truth exactly as with the old selects:
  // readLayoutOptions()/readSettings() read data-value, loadSettings()
  // hydrates it at boot, and every click funnels into the ONE existing
  // onLayoutSettingChanged() path (runLayout + saveSettings). No layout
  // math, no Excel work.

  // Parse "6,8,10,12" into [6, 8, 10, 12]. A malformed list is not fatal:
  // the caller guards bounds, so an empty list simply makes a stepper inert.
  function getStepperOptions(stepper) {
    const raw = stepper && stepper.dataset ? stepper.dataset.options : '';
    if (typeof raw !== 'string') return [];
    return raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
  }

  function getStepperValue(stepper) {
    return Number(stepper.dataset.value);
  }

  // Write the value, repaint the display and arm the boundary disables.
  // Pure DOM paint - no events are emitted, so a restore can never fire
  // onLayoutSettingChanged() (the same guarantee the selects had).
  function setStepperValue(stepper, value) {
    if (!stepper) return;
    const options = getStepperOptions(stepper);
    const index = options.indexOf(Number(value));
    if (index === -1) return; // only known stops may be written

    stepper.dataset.value = String(options[index]);
    const display = stepper.querySelector('.stepper-value');
    if (display) {
      display.textContent = String(options[index]) + (stepper.dataset.suffix || '');
    }

    const minus = stepper.querySelector('.stepper-minus');
    const plus = stepper.querySelector('.stepper-plus');
    if (minus) minus.disabled = index === 0;
    if (plus) plus.disabled = index === options.length - 1;
  }

  // One delegated click handler per container (the same idiom as the
  // file-list remove buttons): re-renders can never re-arm listeners, and
  // disabled buttons simply never reach the handler.
  function setupStepper(stepper) {
    if (!stepper) return;
    stepper.addEventListener('click', (event) => {
      const button = event.target.closest('.stepper-btn');
      if (!button || button.disabled) return;

      const options = getStepperOptions(stepper);
      const index = options.indexOf(getStepperValue(stepper));
      if (index === -1) return;

      const next = button.classList.contains('stepper-plus')
        ? index + 1
        : index - 1;
      if (next < 0 || next > options.length - 1) return; // bounds guard

      setStepperValue(stepper, options[next]);
      onLayoutSettingChanged();
    });
  }

  // Paint both steppers from their (possibly hydrated) data-value so the
  // displays and the boundary disables are correct at boot.
  function repaintSteppers() {
    if (el.heightStepper) setStepperValue(el.heightStepper, getStepperValue(el.heightStepper));
    if (el.columnsStepper) setStepperValue(el.columnsStepper, getStepperValue(el.columnsStepper));
  }
  // --- end v17.0 stepper controls -------------------------------------------

  // v26.0 — the save dialog's auto-clear checkbox and its localStorage
  // preference were removed: a successful export no longer empties the
  // selection, so clearFiles() is reached only through the manual Clear button.

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
      // v18.0 — the settings live in data-value on the stepper containers.
      columns: parseInt(el.columnsStepper.dataset.value, 10) || 4,
      targetHeightCm: parseFloat(el.heightStepper.dataset.value) || 10,
      horizontalBaseGapPx: 3,  // v6.4: horizontal-only base gap (4 - 1 px)
      gapJitterPx: 1,          // horizontal micro-randomization (-1 / 0 / +1 px)
      rowGapPx: 4,             // v8.0: strict 1 mm inter-row gap (4 px)
      rowJitterPx: 3,          // v8.0: row-level vertical jitter (-3..+3 px)
      photoJitterPx: 1         // v8.0: per-photo jitter inside a row (-1..+1 px)
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

  /**
   * v16.0 - remove a single photo from the selection by its display index.
   * Re-keys the remaining processed photos (id === removed drops, id > removed
   * decrements) so runLayout() rebuilds the layout from a single source of
   * truth, frees that row's Object URL, and refreshes every downstream surface:
   * list, totals, report date, Generate button state.
   */
  function removeFile(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.files.length) {
      return;
    }

    // Cancel any in-flight processing so a stale loop cannot re-add what we
    // just removed (same guard clearFiles() uses).
    processingToken++;
    processing = false; // v27.0 — the removed state is no longer being rebuilt
    closePreviewModal(); // v27.0 — a preview of the old count must not linger

    // Free this photo's preview and drop it from the URL list.
    if (thumbnailUrls[index] && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(thumbnailUrls[index]);
    }
    thumbnailUrls.splice(index, 1);

    state.files.splice(index, 1);
    state.sortKeys.splice(index, 1);

    // Re-key: removal shifts every later index by -1. Kept blobs are untouched
    // (ZIP export still reads them from state.layout after runLayout()).
    state.processedPhotos = state.processedPhotos
      .filter((p) => p.id !== index)
      .map((p) => (p.id > index ? { ...p, id: p.id - 1 } : p));

    runLayout(); // rebuilds state.layout + toggles Generate (single source of truth)
    state.reportDate = reportDateFromKeys(state.sortKeys);

    renderFileList();
    renderSummary();

    if (state.files.length === 0) {
      setStatus('');
      el.photoInput.value = '';
    }
    console.log(`[app] Removed photo #${index}.`);
  }

  // v8.2 - only the HEAD of the first photo is read: the EXIF APP1 segment sits
  // immediately after SOI, so 256 KB covers even a thumbnail-bearing one without
  // touching the (potentially 48 MP) rest of the file.
  // v9.2 - read the sort keys for EVERY selected photo (EXIF capture date
  // from the raw File, with file.lastModified as the fallback) in parallel
  // 256 KB head reads. The keys feed sortPhotoKeys() in compressor.js.
  const PHOTO_DATE_HEAD_BYTES = 256 * 1024;

  /**
   * Sort keys for the current selection: one entry per File with the
   * original index, the capture timestamp (Date.getTime() or null when
   * neither EXIF nor file.lastModified yields a usable date), and the
   * original filename. EXIF is read from the RAW File (the canvas
   * preprocessing strips it, so the compressed blob cannot supply it).
   *
   * Runs the 256 KB head reads in parallel so the per-photo slice is not
   * on the critical path of the encode loop.
   */
  async function readSortKeys(files) {
    if (!files || files.length === 0) return [];
    const resolver = global.Compressor && global.Compressor.resolveCaptureDate;
    const hasResolver = typeof resolver === 'function';

    const keys = await Promise.all(
      files.map(async (file, index) => {
        let timestamp = null;
        try {
          const head = await file.slice(0, PHOTO_DATE_HEAD_BYTES).arrayBuffer();
          if (hasResolver) {
            const date = resolver(head, file.lastModified);
            if (date instanceof Date && !isNaN(date.getTime())) {
              timestamp = date.getTime();
            }
          }
        } catch (err) {
          console.warn(
            `[app] Could not read sort key for ${file.name}:`,
            err && err.message ? err.message : err
          );
        }
        return { index, timestamp, name: file.name };
      })
    );
    return keys;
  }

  /**
   * Ingest-stage sorter: takes the raw sort-key array (one per selected
   * File, in selection order) and returns a NEW array listing the original
   * indices in sorted order. Sorting is STABLE:
   *
   *   1. Both photos have a capture timestamp -> ascending (oldest first).
   *   2. Otherwise (one or both missing, or an exact tie on milliseconds)
   *      -> tie-break by original filename using natural numeric order
   *      (String.prototype.localeCompare with { numeric: true,
   *      sensitivity: 'base' }), so IMG_4490.jpg strictly precedes
   *      IMG_4501.jpg and photo_2.jpg precedes photo_10.jpg.
   *   3. Still equal (identical name AND identical timestamp) -> preserve
   *      the original selection order (index) as the final safety net.
   *
   * The input array is never mutated, so callers can reuse the keys they
   * passed in.
   */
  function sortPhotoKeys(keys) {
    if (!keys || keys.length <= 1) {
      return keys ? keys.map(k => k.index) : [];
    }
    // Compressor.sortPhotoKeys (v8.3) owns the cascade itself so there is
    // exactly one implementation to test. It returns the sorted KEY records;
    // the ingest pipeline needs the original indices, so adapt here.
    const surface = global.Compressor && global.Compressor.sortPhotoKeys;
    if (typeof surface !== 'function') {
      // Older cached bundle without the sorting surface: keep the selection
      // order rather than guessing an order the tests cannot pin down.
      return keys.map(k => k.index);
    }
    return surface(keys).map(k => k.index);
  }

  /**
   * Derive the report date for the current batch from the already-computed
   * sort keys: the EARLIEST capture timestamp present in the batch, or null
   * when none of the photos carries a usable date. This replaces the old
   * "first selected photo" semantics so the default report name labels the
   * whole batch by its oldest photo.
   */
  function reportDateFromKeys(keys) {
    if (!keys || keys.length === 0) return null;
    let best = Infinity;
    for (let i = 0; i < keys.length; i++) {
      const ts = keys[i] && keys[i].timestamp;
      // Match Compressor.sortPhotoKeys(): only a finite epoch ms counts as a
      // real capture date (NaN / Infinity are "missing").
      if (Number.isFinite(ts) && ts < best) best = ts;
    }
    return best === Infinity ? null : new Date(best);
  }

  async function processFiles(files) {
    const token = ++processingToken;
    processing = true; // v27.0 — preview stays disabled while this run is live
    renderGenerateButton(); // v27.0 — disable Preview immediately on re-encode
    state.processedPhotos = [];
    state.reportDate = null; // v8.2 - recomputed for every run
    const total = files.length;

    if (total === 0) {
      // v7.3 — nothing to report yet: the idle text is owned by renderSummary().
      processing = false;
      setStatus('');
      return;
    }

    // v9.2 - derive the report date from the already-computed sort keys:
    // the EARLIEST capture timestamp in the batch, or null when none of the
    // photos carries a usable date. This replaces the old "first selected
    // photo" semantics so the default report name labels the batch by its
    // oldest photo.
    state.reportDate = reportDateFromKeys(await readSortKeys(files));
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

    processing = false; // v27.0 — this batch is current: the preview may open
    setStatus(`Processed ${state.processedPhotos.length}/${total} photos.`);
    renderFileList(); // refresh with the compressed sizes
    renderSummary(); // flip to size summary when batch is complete
    console.log('[app] Processed photos:', state.processedPhotos);
    runLayout();
  }

  async function onFilesSelected(event) {
    await ingestFiles(Array.from(event.target.files || []));
  }

  /**
   * v29.0 — the ONE ingestion path. Every photo source funnels through here:
   * the hidden <input type="file"> picker (via onFilesSelected) and the Web
   * Share Target queue (via ingestSharedPhotos). Sorting, thumbnail preview,
   * compression and the Stage 1 / Stage 2 hand-off stay exactly as they were —
   * neither stage knows or cares where the bytes came from.
   */
  async function ingestFiles(selected) {
    closePreviewModal(); // v27.0 — the old layout no longer describes the batch
    const images = selected.filter((file) => file.type.startsWith('image/'));

    if (images.length !== selected.length) {
      console.warn(
        `[app] Ignored ${selected.length - images.length} non-image file(s).`
      );
    }

    // v9.2 - read sort keys for every selected photo and reorder before
    // anything is rendered or encoded, so the preview grid, totals, layout
    // and ZIP all see the same chronological / natural order.
    let sorted = images;
    let sortKeys = [];
    if (images.length > 0) {
      const keys = await readSortKeys(images);
      const order = sortPhotoKeys(keys);
      sorted = order.map(i => images[i]);
      // v16.0 - keep the keys in the FINAL (sorted) order so removeFile() can
      // drop one and recompute the report date without re-reading EXIF.
      sortKeys = order.map(i => keys[i]);
    }

    // v15.0 — free the previous selection's previews BEFORE creating the new
    // ones, then build the new URLs in the final (sorted) order so
    // thumbnailUrls stays index-aligned with state.files.
    revokeThumbnails();
    thumbnailUrls = createThumbnails(sorted);

    state.files = sorted;
    state.sortKeys = sortKeys; // v16.0 - aligned with state.files after sorting
    renderFileList();
    renderSummary();
    console.log(`[app] ${state.files.length} photo(s) selected.`);
    processFiles(state.files);
  }

  /**
   * v29.0 — pull any photos the service worker queued from a Web Share Target
   * POST into the normal pipeline. Runs on launch (init), on pageshow and on
   * focus / visibilitychange, so a share lands whether the app was closed or
   * already open. The queue read+delete is atomic (ShareTarget), and the
   * ingestingShares guard collapses rapid repeat events into ONE import.
   */
  async function ingestSharedPhotos() {
    if (!global.ShareTarget || ingestingShares) return;
    ingestingShares = true;
    try {
      const shared = await global.ShareTarget.consumePendingFiles();
      if (shared && shared.length > 0) {
        console.log(`[app] Importing ${shared.length} shared photo(s).`);
        await ingestFiles(shared);
      }
    } catch (err) {
      console.warn('[app] Could not import shared photos:', err);
    } finally {
      ingestingShares = false;
    }
  }

  function clearFiles() {
    closePreviewModal(); // v27.0 — no selection can leave a preview behind
    processingToken++; // cancel any in-flight processing
    processing = false;
    revokeThumbnails(); // v15.0 - release the preview Object URLs
    state.files = [];
    state.processedPhotos = [];
    state.layout = [];
    state.sortKeys = []; // v16.0 - drop the per-file sort keys with the files
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

    // v27.0 — the preview opens only against a COMPLETE, current run: nothing
    // is being compressed and every processed photo has a rectangle. The array
    // itself is never recomputed here; Preview.open() receives it as-is.
    if (el.previewBtn) {
      const previewReady =
        !generating &&
        !processing &&
        !saveModalOpen &&
        state.processedPhotos.length > 0 &&
        state.layout.length === state.processedPhotos.length;
      el.previewBtn.disabled = !previewReady;
    }
  }

  function closePreviewModal() {
    if (global.Preview && global.Preview.isOpen()) global.Preview.close();
  }

  /**
   * v27.0 — open the desktop preview with the EXACT array Stage 2 will consume.
   * No Stage 1 call and no recalculation: the preview and the workbook always
   * describe the same placement.
   */
  function openPreviewModal() {
    if (!el.previewBtn || el.previewBtn.disabled) return;
    if (!global.Preview || !global.Preview.open) return;
    if (saveModalOpen || generating || processing) return;
    global.Preview.open(state.layout);
  }

  /** Bind the preview module once, after the DOM references are cached. */
  function initPreview() {
    if (!global.Preview || typeof global.Preview.init !== 'function') {
      console.warn('[app] Preview module is not loaded.');
      return;
    }
    global.Preview.init({
      modal: el.previewModal,
      viewport: el.previewViewport,
      scrollContent: el.previewScrollContent,
      stage: el.previewStage,
      columnHeaders: el.previewColumnHeaders,
      rowHeaders: el.previewRowHeaders,
      grid: el.previewGrid,
      photos: el.previewPhotos,
      zoomLabel: el.previewZoomLabel,
      zoomInBtn: el.previewZoomInBtn,
      zoomOutBtn: el.previewZoomOutBtn,
      zoomFitBtn: el.previewZoomFitBtn,
      closeBtn: el.previewCloseBtn
    });
  }

  // --- v30.0 fullscreen photo viewer -----------------------------------------
  // A card-style overlay over the file list. It renders the ORIGINAL high-res
  // preview (thumbnailUrls[index]) and offers exactly two outcomes: Keep closes
  // the viewer, Delete funnels into the ONE existing removeFile() path and then
  // slides the next photo in. No new state, no Object URLs, no layout/Excel work.

  /** Paint the currently selected photo (image, name, counter) into the card. */
  function renderViewerPhoto() {
    const file = state.files[viewerIndex];
    if (!file) return;

    const url = thumbnailUrls[viewerIndex] || '';
    // A missing URL (no createObjectURL / unreadable file) degrades to the
    // placeholder so the card keeps its geometry, mirroring renderFileList().
    el.photoViewerImg.hidden = !url;
    el.photoViewerPlaceholder.hidden = !!url;
    if (url) {
      el.photoViewerImg.src = url;
      el.photoViewerImg.alt = file.name;
    } else {
      el.photoViewerImg.removeAttribute('src');
      el.photoViewerImg.alt = '';
    }

    el.photoViewerName.textContent = file.name;
    el.photoViewerName.title = file.name;
    el.photoViewerCounter.textContent =
      `${viewerIndex + 1} / ${state.files.length}`;
  }

  /**
   * Open the viewer on the photo at `index` (its position in the list).
   * Guards the index, closes the other modals (they never stack) and locks the
   * background from scrolling, then hands focus to the Keep action so the card
   * is immediately keyboard-operable.
   */
  function openPhotoViewer(index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.files.length) {
      return;
    }

    closePreviewModal(); // v30.0 — the modals never stack
    closeSaveModal();

    viewerIndex = index;
    photoViewerOpen = true;
    renderViewerPhoto();
    el.photoViewerModal.hidden = false;
    document.body.classList.add('photo-viewer-open');

    if (el.photoViewerKeepBtn) el.photoViewerKeepBtn.focus();
  }

  /** Close the viewer. No URL is revoked here — the viewer never owned one. */
  function closePhotoViewer() {
    if (!photoViewerOpen) return;
    photoViewerOpen = false;
    viewerIndex = -1;
    el.photoViewerModal.hidden = true;
    // Drop the reference so a closed viewer never keeps a blob URL alive.
    el.photoViewerImg.removeAttribute('src');
    document.body.classList.remove('photo-viewer-open');
  }

  /**
   * Delete the photo on screen. removeFile() is the ONE removal path: it revokes
   * that row's Object URL, re-keys state.processedPhotos and rebuilds the layout.
   * Afterwards the following photo has slid into the same index, so the card
   * repaints there — or closes when the batch is now empty.
   */
  function deleteCurrentPhoto() {
    if (!photoViewerOpen) return;

    const removed = viewerIndex;
    removeFile(removed);

    if (state.files.length === 0) {
      closePhotoViewer();
      return;
    }

    // The next photo now occupies `removed`; deleting the last one clamps to the
    // new final index so the viewer always shows a real photo.
    viewerIndex = Math.min(removed, state.files.length - 1);
    renderViewerPhoto();
  }

  /** Esc closes the viewer; Delete/Backspace removes the photo on screen. */
  function onPhotoViewerKeydown(event) {
    if (!photoViewerOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePhotoViewer();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteCurrentPhoto();
    }
  }

  // --- v14.0 native "Save As" delivery; v19.0 adds the share sheet -----------
  // The ONE place the app touches the file system. ExcelWriter / ZipExporter
  // still return plain binary data (ArrayBuffer / Blob); this block only
  // decides HOW that data reaches the user, in a strict priority order:
  //
  //   1. window.showSaveFilePicker() where the browser offers it (Chrome/Edge,
  //      desktop Safari 15.2+, Android Chrome) -> native OS "Save As" dialog:
  //      the user picks the folder AND edits the file name.
  //   2. navigator.share({ files }) where the sheet accepts the file
  //      (iOS Safari, Android Chrome) -> the native share sheet, whose
  //      "Save to Files" / iCloud / AirDrop / app rows replace the forced
  //      Downloads drop. Needs the FINISHED file, so it runs after the build;
  //      a refused sheet (activation expired, NotAllowedError) degrades to
  //      (3) instead of failing the export.
  //   3. the existing <a download> path everywhere else (desktop Firefox,
  //      older browsers) -> the unchanged last-resort transport.
  //
  // No layout math, no Excel work: delivery plumbing only.
  const XLSX_MIME =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const ZIP_MIME = 'application/zip';

  // The native picker's type filters (one entry each — the app writes exactly
  // one format per button).
  const XLSX_SAVE_TYPE = {
    description: 'Excel Spreadsheet',
    accept: { [XLSX_MIME]: ['.xlsx'] }
  };
  const ZIP_SAVE_TYPE = {
    description: 'ZIP Archive',
    accept: { [ZIP_MIME]: ['.zip'] }
  };

  // Read at CALL time, never cached at boot: the jsdom test tier installs the
  // API after the modules have loaded, and a browser never grows it mid-session.
  function isSavePickerSupported() {
    return typeof global.showSaveFilePicker === 'function';
  }

  function toBlob(buffer, mimeType) {
    return new Blob([buffer], { type: mimeType || XLSX_MIME });
  }

  /**
   * v14.0 — Open the native "Save As" dialog and hand back the chosen handle.
   *
   * Both export handlers call this BEFORE generating anything: the API needs
   * the click's transient user activation, which a slow workbook / archive
   * build could otherwise outlive (SecurityError).
   *
   * @param {string} suggestedName The name the dialog opens with.
   * @param {{description: string, accept: object}} fileType One picker filter.
   * @returns {Promise<FileSystemFileHandle|null>} null when the user cancelled
   *   the OS dialog (AbortError) — a normal outcome, never an error.
   */
  async function requestSaveHandle(suggestedName, fileType) {
    try {
      return await global.showSaveFilePicker({
        suggestedName: suggestedName,
        types: [fileType]
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
  }

  // Stream the finished Blob into the user's chosen file, then close the stream.
  async function writeBlobToHandle(handle, blob) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  // v19.0 — Web Share API support, read at CALL time exactly like the picker
  // above: the jsdom tier installs its stubs after the modules have loaded,
  // and no engine grows the API mid-session. canShare() may itself throw on
  // inputs an engine refuses to handle, so the probe is wrapped — a throw
  // simply means "not supported here" (the anchor fallback answers it).
  function isShareSupported(file) {
    try {
      return (
        typeof global.navigator.share === 'function' &&
        typeof global.navigator.canShare === 'function' &&
        global.navigator.canShare({ files: [file] })
      );
    } catch (err) {
      return false;
    }
  }

  /**
   * v19.0 — Offer the finished file to the native share sheet (iOS Safari's
   * "Save to Files" / iCloud / AirDrop / other apps), degrading to the classic
   * <a download> anchor everywhere the API is missing or refuses the file.
   *
   * Unlike the picker, navigator.share() needs the FINISHED file, so this is
   * called after the workbook / archive build — by then the click's transient
   * user activation may have expired (NotAllowedError). That must never cost
   * the user the export, so every refusal degrades to 'fallback' and the
   * caller runs the unchanged downloadBuffer() path.
   *
   * No object URLs are created on the share path — a File is handed straight
   * to the sheet — so there is nothing to leak and nothing to revoke here.
   *
   * v24.0 — the payload is FILES-ONLY: `{ files: [file] }` with no `title`,
   * `text` or `url`. iOS WebKit serializes such a string as a second share item,
   * which is what produced the stray `text.txt` / `text 2.txt` sidecar next to
   * the saved .zip in Files / Downloads. `File.name` already tells the sheet how
   * to name the saved file, so dropping the string loses nothing. The `filename`
   * argument is still required: it is what names the File itself.
   *
   * @param {Blob|ArrayBuffer|Uint8Array} data The finished file content.
   * @param {string} filename Full file name, extension included.
   * @param {string} mimeType Blob/File MIME type (XLSX_MIME / ZIP_MIME).
   * @returns {Promise<'shared'|'cancelled'|'fallback'>}
   *   shared    - the sheet resolved; the export can report success.
   *   cancelled - AbortError: the user dismissed the sheet. A normal outcome,
   *               never an error; nothing downloaded, nothing cleared.
   *   fallback  - the API is absent or refused the file (including a dead
   *               user activation); the caller must download instead.
   */
  async function saveOrShareFile(data, filename, mimeType) {
    const blob = toBlob(data, mimeType);
    let file;
    try {
      file = new File([blob], filename, { type: mimeType || XLSX_MIME });
    } catch (err) {
      return 'fallback'; // no File constructor (very old engines)
    }
    if (!isShareSupported(file)) return 'fallback';
    try {
      // v24.0 — FILES-ONLY PAYLOAD (iOS sidecar fix). WebKit turns a string
      // `title` / `text` / `url` sent ALONGSIDE `files` into a SEPARATE share
      // item, so "Save to Files" drops an extra text.txt (then text 2.txt, ...)
      // next to the export. The name is already carried by File.name, so the
      // payload stays strictly { files } — nothing else, ever.
      await global.navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // NotAllowedError (the activation expired), SecurityError, etc.:
      console.warn('[app] Share sheet unavailable — falling back to download:', err);
      return 'fallback';
    }
  }

  // Fallback delivery — the pre-v14.0 behaviour, byte-for-byte unchanged.
  function downloadBuffer(buffer, filename, mimeType) {
    const blob = toBlob(buffer, mimeType);
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
  // --- end v14.0 native "Save As" delivery ----------------------------------

  /**
   * v8.0 — Open the save dialog.
   *
   * v26.0 — the metric comes from the SAME computeTotals()/formatSize() pair
   * the top summary uses, so the popup can never disagree with the list behind
   * it. Only the COMPRESSED total is shown, and only once every selected photo
   * carries one: while a re-encode is in flight (or a photo failed) the number
   * would describe a partial batch, so the whole line is hidden instead.
   */
  function openSaveModal() {
    closePreviewModal(); // v27.0 — the two modals never stack
    if (state.layout.length === 0 || generating || saveModalOpen) return;

    const totals = computeTotals(state.files, state.processedPhotos);

    if (totals.complete && totals.compressedBytes > 0) {
      el.saveSummarySize.textContent =
        `Total size Excel: ${formatSize(totals.compressedBytes)}`;
      el.saveSummarySize.hidden = false;
    } else {
      el.saveSummarySize.textContent = '';
      el.saveSummarySize.hidden = true;
    }

    // v12.0 - the date part goes into the LEFT field (v8.2 semantics: the
    // detected capture date, today only when none was usable) and the fixed
    // base name into the RIGHT one.
    el.saveDate.value = formatReportDate(state.reportDate);
    el.saveFilename.value = defaultBaseName();
    el.saveModal.hidden = false;
    saveModalOpen = true;
    renderGenerateButton(); // v27.0 — disable Preview while the save modal owns focus

    el.saveFilename.focus();
    el.saveFilename.setSelectionRange(0, el.saveFilename.value.length);
  }

  function closeSaveModal() {
    if (!saveModalOpen) return;
    el.saveModal.hidden = true;
    saveModalOpen = false;
    renderGenerateButton(); // v27.0 — re-evaluate the preview's modal guard
  }

  // Real-time sanitization: the field may only ever hold a base name, so a
  // forbidden character disappears as it is entered. v21.0 — this runs the
  // LIGHTER sanitizeNameLive(): spaces (and dots) survive keystroke by
  // keystroke, so "steering gear" is typeable, while the full sanitizeFilename()
  // (trim, trailing strip, typed extension) still runs once, on export.
  function onFilenameInput() {
    const clean = sanitizeNameLive(el.saveFilename.value);
    if (clean !== el.saveFilename.value) el.saveFilename.value = clean;
  }

  // v12.0 — the date field is sanitized live as well, but through the lighter
  // sanitizeDatePart() so the dots the user is typing survive keystroke by
  // keystroke. The full sanitize runs once, on export.
  function onDateInput() {
    const clean = sanitizeDatePart(el.saveDate.value);
    if (clean !== el.saveDate.value) el.saveDate.value = clean;
  }

  // v26.0 — the auto-clear checkbox and its change handler were removed.

  // ESC closes (a native <dialog> would do this for free; this overlay is a
  // <div>) and Enter in EITHER name field confirms, which is the iOS keyboard's
  // "Done" key. v12.0 - the date field confirms too: it is part of the same
  // file name now.
  function onModalKeydown(event) {
    if (!saveModalOpen) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeSaveModal();
    } else if (
      event.key === 'Enter' &&
      (event.target === el.saveFilename || event.target === el.saveDate)
    ) {
      event.preventDefault();
      confirmExport();
    }
  }

  /**
   * v8.0 — Export on confirmation ("Download Excel").
   *
   * v12.0 — the name is composed from the dialog's TWO fields (date + base
   * name) by toXlsxFilename(), which is still the only place the extension is
   * attached and the only place the parts are joined.
   *
   * v14.0 — delivery is now picker-first: when window.showSaveFilePicker()
   * exists the handle is requested BEFORE the workbook is built (see
   * requestSaveHandle — the click's user activation must still be alive), the
   * workbook is streamed into the user's chosen file, and the dialog's name
   * seeds the OS dialog's suggestedName. Cancelling the OS dialog (AbortError)
   * is a quiet no-op: nothing is generated, nothing is cleared. Without the API
   * the export stays the plain <a download> path (iOS Safari / Files sheet).
   *
   * v19.0 — the no-picker delivery gains the native share sheet: the finished
   * workbook goes through saveOrShareFile(), so iOS Safari offers it to
   * navigator.share({ files }) ("Save to Files" / AirDrop / other apps) and
   * only degrades to the classic <a download> anchor when the API is missing
   * or refuses. A dismissed sheet (AbortError) is a quiet no-op like a
   * cancelled dialog: nothing downloaded, the selection survives for a retry.
   */
  async function confirmExport() {
    if (!saveModalOpen || generating) return;

    const filename = toXlsxFilename(
      el.saveDate.value,
      el.saveFilename.value,
      state.reportDate
    );

    closeSaveModal();

    // v14.0 — ask for the target file FIRST, while the click's transient user
    // activation is still live.
    const pickerAvailable = isSavePickerSupported();
    let handle = null;
    if (pickerAvailable) {
      try {
        handle = await requestSaveHandle(filename, XLSX_SAVE_TYPE);
      } catch (err) {
        console.error('[app] Could not open the save dialog:', err);
        setStatus('Failed to open the save dialog — see console.');
        return; // nothing was generated, so nothing is cleared
      }
      if (!handle) {
        // AbortError: the user closed the OS dialog. Not an error, not a
        // failure — the selection stays exactly as it was so they can retry.
        setStatus('Save cancelled.');
        return;
      }
    }

    generating = true;
    renderGenerateButton();
    setStatus('Generating Excel…');

    try {
      const buffer = await global.ExcelWriter.buildExcelWorkbook(state.layout);

      // v19.0 — picker first (desktop), then the share sheet (iOS), then the
      // classic anchor download as the last resort.
      let outcome = 'saved';
      if (handle) {
        await writeBlobToHandle(handle, toBlob(buffer, XLSX_MIME));
      } else {
        outcome = await saveOrShareFile(buffer, filename, XLSX_MIME);
        if (outcome === 'fallback') {
          downloadBuffer(buffer, filename, XLSX_MIME);
        }
      }

      if (outcome === 'cancelled') {
        // The sheet was dismissed: a normal outcome, never an error. The
        // selection stays exactly as it was so the user can retry.
        setStatus('Share cancelled.');
        return;
      }

      if (handle) {
        setStatus('File saved.');
      } else if (outcome === 'shared') {
        setStatus('File shared.');
      } else {
        setStatus('Download started.');
      }
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
   * v11.0 — the archive's single root folder is spec.rootFolder (the report
   * base name), so <base>.zip opens straight into <base>/ holding <base>.xlsx
   * and the compressed photos. Nothing is loose at the archive root.
   *
   * Failure policy: if the archive cannot be built (JSZip missing from the
   * CDN, or any ZIP-side error), the already-built workbook is downloaded as
   * the plain .xlsx instead — a CDN hiccup must never cost the user the
   * report. v26.0 — every successful export leaves the selection intact, so
   * the list survives even when the archive falls back to the plain workbook.
   *
   * v14.0 — picker-first like confirmExport(): the .zip handle is requested
   * while the click's user activation is still alive and the finished archive
   * is streamed into it. Cancelling (AbortError) is a quiet no-op. A .zip
   * handle can never carry the .xlsx fallback, so when the archive fails the
   * handle is simply dropped — createWritable() was never reached, so no file
   * was created — and the existing anchor download of the workbook runs.
   *
   * v19.0 — the no-picker deliveries gain the share sheet, exactly like the
   * plain Excel path: the finished .zip (or, on archive failure, the .xlsx
   * fallback — the same chain, so it stays shareable on iOS too) goes through
   * saveOrShareFile() before the anchor download. A dismissed sheet
   * (AbortError) is a quiet no-op and never clears the selection.
   */
  async function confirmZipExport() {
    if (!saveModalOpen || generating) return;

    const xlsxName = toXlsxFilename(
      el.saveDate.value,
      el.saveFilename.value,
      state.reportDate
    );
    // v11.0 — the archive name, its single root folder and the workbook all
    // come from ONE base name, so the ZIP opens as <reportName>/ with
    // <reportName>.xlsx inside it.
    const reportBaseName = xlsxName.replace(/\.xlsx$/i, '');
    const zipName = reportBaseName + '.zip';

    closeSaveModal();

    // v14.0 — same picker-first rule as confirmExport().
    const pickerAvailable = isSavePickerSupported();
    let handle = null;
    if (pickerAvailable) {
      try {
        handle = await requestSaveHandle(zipName, ZIP_SAVE_TYPE);
      } catch (err) {
        console.error('[app] Could not open the save dialog:', err);
        setStatus('Failed to open the save dialog — see console.');
        return;
      }
      if (!handle) {
        setStatus('Save cancelled.');
        return;
      }
    }

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
          rootFolder: reportBaseName,
          photos: state.layout
        });
      } catch (zipErr) {
        console.warn('[app] ZIP packaging failed — falling back to Excel:', zipErr);
      }

      // v19.0 — picker first (desktop), then the share sheet (iOS), then the
      // anchor download. The .xlsx fallback for a failed archive follows the
      // SAME chain, so it stays shareable on iOS too.
      let outcome;
      if (zipBlob && handle) {
        await writeBlobToHandle(handle, zipBlob);
        outcome = 'saved';
      } else if (zipBlob) {
        outcome = await saveOrShareFile(zipBlob, zipName, ZIP_MIME);
      } else {
        outcome = await saveOrShareFile(buffer, xlsxName, XLSX_MIME);
      }

      if (outcome === 'cancelled') {
        // The sheet was dismissed: a normal outcome, never an error. The
        // selection stays exactly as it was so the user can retry.
        setStatus('Share cancelled.');
        return;
      }
      if (outcome === 'fallback') {
        if (zipBlob) {
          downloadBuffer(zipBlob, zipName, ZIP_MIME);
        } else {
          downloadBuffer(buffer, xlsxName);
        }
      }

      if (!zipBlob) {
        setStatus(
          outcome === 'shared'
            ? 'ZIP failed — Excel shared instead.'
            : 'ZIP failed — Excel downloaded instead.'
        );
      } else if (outcome === 'saved') {
        setStatus('File saved.');
      } else if (outcome === 'shared') {
        setStatus('File shared.');
      } else {
        setStatus('Download started.');
      }
    } catch (err) {
      console.error('[app] ZIP export failed:', err);
      setStatus('Failed to generate ZIP — see console.');
      // Nothing was exported, so the selection is deliberately kept intact.
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
      closePreviewModal(); // v27.0 — the layout is about to be rebuilt
      processFiles(state.files);
    }
  }

  // v7.5 — layout selects: recompute the placement, then persist the new choice.
  // v27.0 — close any open preview first: it shows the previous placement.
  function onLayoutSettingChanged() {
    closePreviewModal();
    runLayout();
    if (settingsLoaded) saveSettings();
  }

  function bindEvents() {
    el.photoInput.addEventListener('change', onFilesSelected);
    el.clearBtn.addEventListener('click', clearFiles);
    // v16.0 - one delegated click handler for the per-row remove buttons, so
    // re-renders never re-arm listeners. The row index is its display position.
    // v30.0 - the SAME handler opens the fullscreen viewer for any other click in
    // the row (thumbnail or text), so the list keeps exactly one listener and the
    // remove cross always keeps priority over the row.
    el.fileList.addEventListener('click', (event) => {
      const li = event.target.closest('li');
      if (!li) return;
      const index = Array.prototype.indexOf.call(el.fileList.children, li);
      if (event.target.closest('.file-remove-btn')) {
        removeFile(index);
        return;
      }
      openPhotoViewer(index);
    });
    // v17.0 — steppers replace the layout selects: one delegated click
    // handler per container, each funnelling into onLayoutSettingChanged().
    setupStepper(el.heightStepper);
    setupStepper(el.columnsStepper);
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
    // v27.0 — the desktop preview is a read-only view of state.layout.
    if (el.previewBtn) {
      el.previewBtn.addEventListener('click', openPreviewModal);
    }
    el.saveConfirmBtn.addEventListener('click', () => confirmExport());
    el.saveZipBtn.addEventListener('click', () => confirmZipExport());
    el.saveCancelBtn.addEventListener('click', closeSaveModal);
    el.saveFilename.addEventListener('input', onFilenameInput);
    // v12.0 — the date field is sanitized live too (lighter rules: dots survive).
    el.saveDate.addEventListener('input', onDateInput);
    // Backdrop click (the overlay itself) closes; clicks inside the card do not.
    el.saveModal.addEventListener('click', (event) => {
      if (event.target === el.saveModal) closeSaveModal();
    });
    document.addEventListener('keydown', onModalKeydown);
    // v30.0 — the fullscreen photo viewer is a separate modal: its own buttons,
    // backdrop dismissal and Esc / Delete shortcuts (Keep = close).
    el.photoViewerCloseBtn.addEventListener('click', closePhotoViewer);
    el.photoViewerKeepBtn.addEventListener('click', closePhotoViewer);
    el.photoViewerDeleteBtn.addEventListener('click', deleteCurrentPhoto);
    el.photoViewerModal.addEventListener('click', (event) => {
      if (event.target === el.photoViewerModal) closePhotoViewer();
    });
    document.addEventListener('keydown', onPhotoViewerKeydown);
    // v29.0 — pick up a Web Share Target batch whether the app was launched by
    // the share (pageshow) or was already open when it arrived (focus /
    // visibilitychange). ingestSharedPhotos() no-ops when the queue is empty.
    global.addEventListener('pageshow', ingestSharedPhotos);
    global.addEventListener('focus', ingestSharedPhotos);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) ingestSharedPhotos();
    });
  }

  /**
   * v20.0 - block iOS pinch-zoom gestures at the document level. Safari fires
   * the non-standard gesture* events in tabs AND in the standalone PWA, and
   * preventDefault() stops the page scale from ever changing. Pure UI
   * plumbing: no layout math, no Excel work.
   */
  function blockZoomGestures() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => {
      document.addEventListener(type, (event) => event.preventDefault());
    });
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

  /**
   * v25.0 - dismiss the first-paint splash screen.
   * The inline controller in index.html owns the fade, the removal and the
   * 2.5s fail-safe, so both the normal boot path and the fail-safe share ONE
   * idempotent implementation. A page without the controller (or a stripped
   * harness) falls back to direct removal, which keeps the overlay from ever
   * trapping the app. Pure startup UI plumbing: no layout math, no Excel work.
   */
  function dismissSplashScreen() {
    const controller = global.PhotoReportSplash;
    if (controller && typeof controller.dismiss === 'function') {
      controller.dismiss();
      return;
    }

    const splash = el.splashScreen || $('splash-screen');
    if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
  }

  function init() {
    cacheDom();
    updateVersionBadge();
    // v7.5 — restore saved preferences BEFORE the listeners are armed, so
    // hydration can never fire a handler. null = nothing usable was stored, in
    // which case the markup defaults are kept untouched.
    const restoredPreset = loadSettings();
    bindEvents();
    initPreview(); // v27.0 — arm the desktop layout preview modal
    // v20.0 - arm the iOS pinch-zoom gesture guards.
    blockZoomGestures();
    // v7.4 — normalize the preset control on load. The restored stop is used when
    // one was stored, otherwise Custom is the default and the KB inputs keep
    // their markup defaults (80 / 220 KB) untouched.
    // v7.6 — paint-only: loadSettings() already hydrated the KB inputs, so
    // applyPreset()'s value write would be a no-op while its re-emitted `change`
    // could only re-run the compression pipeline (nothing is selected at boot).
    // setPresetSelection() produces the same single active stop + label.
    setPresetSelection(restoredPreset === null ? getCustomIndex() : restoredPreset);
    // v17.0 — paint the steppers from their (possibly hydrated) data-value so
    // the displays show "N cm"/"N" and the boundary buttons are disabled
    // correctly before the first user tap. Pure paint: no events are emitted.
    repaintSteppers();
    // v7.5 — on first boot (nothing was stored), persist the markup defaults so
    // that a second boot finds a valid payload. When a payload WAS restored, the
    // controls already match storage, so we must not write back.
    if (restoredPreset === null) saveSettings();
    settingsLoaded = true; // v7.5 — from here on every user change is persisted.
    renderSummary();
    setStatus(''); // v7.3 — idle state is rendered once by renderSummary() only.
    renderGenerateButton();
    registerServiceWorker();
    // v29.0 — a launch triggered by a Web Share Target POST has its photos
    // queued in IndexedDB; pull them into the pipeline now that the UI is ready.
    ingestSharedPhotos();
    // v25.0 - hydration and event binding are done: hand the first paint over
    // to the app. Registration stays fire-and-forget; the splash must not wait
    // for Service Worker activation.
    dismissSplashScreen();
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
    sanitizeDatePart: sanitizeDatePart, // v12.0 — date-field live sanitizer
    sanitizeNameLive: sanitizeNameLive, // v21.0 — name-field live sanitizer
    capitalizeFirstLetter: capitalizeFirstLetter, // v21.0 — "steering" -> "Steering"
    formatReportDate: formatReportDate,
    defaultBaseName: defaultBaseName, // v12.0 — right field's default
    toXlsxFilename: toXlsxFilename
  };

  // Scripts are deferred and loaded in order, so this fires after parsing.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
