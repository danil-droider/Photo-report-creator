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
 */
(function (global) {
  'use strict';

  const MAX_ENTRY_LENGTH = 120;
  const PHOTOS_FOLDER = 'photos';

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
   * @param {Array<{originalName: string, blob: Blob}>} spec.photos
   *        The same state.layout entries the Excel stage consumed.
   * @returns {Promise<Blob>} the finished application/zip blob.
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
    const zip = new JSZipCtor();

    // The workbook keeps its user-facing name at the archive root.
    zip.file(spec.xlsxName || 'Report.xlsx', spec.xlsxBuffer);

    const folder = zip.folder(PHOTOS_FOLDER);
    photos.forEach((photo) => {
      if (!photo || !photo.blob) return;
      folder.file(sanitizeEntryName(photo.originalName), photo.blob);
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
    PHOTOS_FOLDER: PHOTOS_FOLDER,
    sanitizeEntryName: sanitizeEntryName,
    buildZipBlob: buildZipBlob
  };
})(window);