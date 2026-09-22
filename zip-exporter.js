/**
 * zip-exporter.js — Delivery-stage helper: package the generated .xlsx report
 * and the reduced/compressed photo Blobs into a single client-side .zip file.
 *
 * Called only by app.js at export time (the "Download Photos & Excel in ZIP"
 * modal button). Like ExcelWriter, this module returns binary data and never
 * touches the DOM or the download path — app.js owns that, exactly once.
 *
 * STRICTLY ENCAPSULATED — zero DOM code, zero layout math, zero Excel logic.
 *
 * Design decisions (v9.0):
 *   - A FRESH JSZip instance is populated (the workbook buffer is written in
 *     as-is). Nothing is re-compressed: JPEGs and the xlsx are already
 *     compressed formats, so the archive is generated with STORE.
 *   - v11.0 — EVERYTHING lives inside ONE top-level folder named after the
 *     report: <reportName>/<reportName>.xlsx plus <reportName>/<photo>.jpg.
 *     Opening the archive shows only that folder — zero loose root entries.
 *   - Photo entry names are preserved from state.layout[].originalName, with
 *     only the mechanical clean-up a ZIP entry requires (no path segments, no
 *     "\/" separators) plus .jpg enforcement, because the compressor always
 *     emits JPEG. NO duplicate renaming logic: equal names collapse to one
 *     entry (last write wins), which is the accepted v9.0 behaviour.
 *
 * Module convention (matches compressor.js / layout.js / excel.js):
 *   IIFE `(function (global) { ... })(window)`, deferred <script>, and a clear
 *   thrown error at use time when JSZip failed to load from its CDN.
 *
 * v9.0 — Excel -> ZIP -> Cancel modal: "Download Photos & Excel in ZIP".
 * v11.0 — ROOT FOLDER layout. The caller passes the SAME base name it used
 * for the .zip / .xlsx names (spec.rootFolder); this module then creates one
 * zip.folder(rootFolder) and writes the workbook and every compressed photo
 * directly inside it, so the archive opens as:
 *
 *   <reportName>.zip
 *   └── <reportName>/
 *       ├── <reportName>.xlsx
 *       ├── IMG_0001.jpg
 *       └── ...            (original photo names, no photo_N renumbering)
 *
 * v23.0 — CLEAN ARCHIVE GUARANTEE. The archive is built from an explicit
 * ALLOWLIST: the workbook (.xlsx) plus .jpg photo entries, nothing else. The
 * photo loop re-checks the sanitized name and drops anything that is not a
 * .jpg, so no .txt / .json / manifest / metadata payload can ever be bundled
 * (the module never wrote one — this makes the guarantee explicit in code and
 * covered by the unit tier instead of leaving it implicit).
 */
(function (global) {
  'use strict';

  const MAX_ENTRY_LENGTH = 120;
  // v11.0 — fallbacks only; app.js always passes the real report base name.
  const DEFAULT_ROOT_FOLDER = 'Report';
  const XLSX_EXT_RE = /\.xlsx$/i;
  // v23.0 — the ONLY photo extension allowed into the archive. sanitizeEntryName
  // already enforces it; the loop below re-checks so the archive can never carry
  // an extraneous text/metadata entry even if the sanitizer changes.
  const JPG_EXT_RE = /\.jpg$/i;

  // ---- Pure / Node-testable helpers (no JSZip needed) --------------------

  /**
   * Mechanical entry-name clean-up only — NO uniqueness pass, NO dedup.
   * The compressor always produces JPEG blobs, so the entry carries .jpg even
   * when the original file was .png / .HEIC (bytes win over extensions):
   *
   *   'vacation.png'      -> 'vacation.jpg'
   *   'C:\DCIM\IMG_1.png' -> 'IMG_1.jpg'   (backslash paths flattened)
   *   './IMG.png'         -> 'IMG.jpg'
   *   ''  /  null         -> 'photo.jpg'
   */
  function sanitizeEntryName(originalName) {
    if (typeof originalName !== 'string') return 'photo.jpg';

    let name = originalName.replace(/\\/g, '/');
    const slash = name.lastIndexOf('/');
    if (slash !== -1) name = name.slice(slash + 1);
    name = name.replace(/\s+/g, ' ').trim();
    if (name.length === 0) name = 'photo';

    const dot = name.lastIndexOf('.');
    let base = dot !== -1 ? name.slice(0, dot) : name;
    base = base.trim() || 'photo';
    // Cap the BASE, never the assembled name: the .jpg extension must survive
    // even a 300-character original.
    base = base.slice(0, MAX_ENTRY_LENGTH - 4);
    return base + '.jpg';
  }

  // ---- Archive assembly ---------------------------------------------------

  /**
   * Build the ZIP archive.
   *
   * @param {object} spec
   * @param {ArrayBuffer|Uint8Array} spec.xlsxBuffer  ExcelWriter output.
   * @param {string} spec.xlsxName  Workbook entry name (e.g. "Report.xlsx").
   * @param {string} [spec.rootFolder]  v11.0 — name of the single top-level
   *        folder holding ALL entries. Omitted -> derived from spec.xlsxName
   *        (extension stripped), so standalone callers still get the nested
   *        layout.
   * @param {Array<{originalName: string, blob: Blob}>} spec.photos
   *        The same state.layout entries the Excel stage consumed.
   * @returns {Promise<Blob>} the finished application/zip blob.
   *
   * v11.0 — the returned archive has exactly ONE top-level entry: the root
   * folder. No workbook and no photo ever sits at the archive root.
   *
   * v23.0 — the returned archive contains ONLY the workbook and .jpg photos
   * (allowlisted): no .txt, .json or metadata entries, ever.
   *
   * Throws a descriptive error when the JSZip CDN bundle did not load — the
   * caller (app.js) then falls back to the plain .xlsx download instead of
   * losing the user's export.
   */
  async function buildZipBlob(spec) {
    spec = spec || {};
    const JSZipCtor = global.JSZip;
    if (!JSZipCtor) {
      throw new Error(
        '[zip-exporter] JSZip is not loaded — the CDN bundle is unavailable.'
      );
    }

    const photos = Array.isArray(spec.photos) ? spec.photos : [];
    const xlsxName = spec.xlsxName || 'Report.xlsx';

    // v11.0 — ONE root folder holds the workbook and every photo. app.js
    // passes the same base name it used for the .zip / .xlsx names; the
    // derivation below only covers standalone use (unit tier).
    const rootName =
      typeof spec.rootFolder === 'string' && spec.rootFolder.trim()
        ? spec.rootFolder.trim()
        : xlsxName.replace(XLSX_EXT_RE, '') || DEFAULT_ROOT_FOLDER;

    const zip = new JSZipCtor();

    // Exactly one top-level directory: nothing is loose at the archive root.
    const root = zip.folder(rootName);
    root.file(xlsxName, spec.xlsxBuffer);

    photos.forEach((photo) => {
      if (!photo || !photo.blob) return;
      const entryName = sanitizeEntryName(photo.originalName);
      // v23.0 — defensive allowlist: only .jpg images are bundled. Nothing from
      // this module ever produced a .txt / .json / metadata entry; this keeps it
      // impossible regardless of the incoming name.
      if (!JPG_EXT_RE.test(entryName)) return;
      root.file(entryName, photo.blob);
    });

    // STORE: every payload is already compressed; DEFLATE would burn iOS CPU
    // for nothing. mimeType: 'blob' types stay inside JSZip — callers pass
    // the type to the download helper.
    return zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
      mimeType: 'application/zip'
    });
  }

  // Read-only test surface: the pure helpers are exercised in the Node tier
  // (same pattern as window.AppTotals / window.Layout).
  global.ZipExporter = {
    DEFAULT_ROOT_FOLDER: DEFAULT_ROOT_FOLDER,
    sanitizeEntryName: sanitizeEntryName,
    buildZipBlob: buildZipBlob
  };
})(window);