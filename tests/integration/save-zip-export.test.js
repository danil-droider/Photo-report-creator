/**
 * save-zip-export.test.js — the v9.0 three-button export flow:
 *   - the modal renders exactly three actions in a fixed order:
 *     Download Excel / Download Photos & Excel in ZIP / Cancel
 *   - the ZIP button builds the workbook ONCE, hands it to ZipExporter with
 *     the processed photo blobs, and downloads ONE <base>.zip blob
 *   - v12.0 — <base> is the composed "<date>_<name>" the dialog's two fields
 *     produce, and it names the archive, its root folder and the workbook alike
 *   - the Excel button stays the plain .xlsx path and never touches the
 *     ZIP stage
 *   - a ZIP-builder failure falls back to the plain .xlsx download (the user
 *     never loses the report) and the selection is kept
 *   - a successful ZIP download keeps the selection (v26.0 removed auto-clear)
 *
 * Runs the REAL index.html + app.js + zip-exporter.js in jsdom; the ZIP stage
 * is spied (its own behaviour is covered by the unit tier).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
  stubDownloads,
  confirmSave,
} from '../helpers/app-dom.js';

const KB = 1024;

describe('save dialog — ZIP export (v9.0 three-button flow)', () => {
  let dom;

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    if (dom) dom.dom.window.close();
    dom = null;
  });

  /** Fresh window: download path captured, Stage 2 + ZIP stage stubbed. */
  function setup() {
    dom = createAppDom();
    const { window, document } = dom;
    const downloads = stubDownloads(window);
    const excel = vi
      .spyOn(window.ExcelWriter, 'buildExcelWorkbook')
      .mockResolvedValue(new window.Uint8Array([0x50, 0x4b]));
    const zipBuilder = vi
      .spyOn(window.ZipExporter, 'buildZipBlob')
      .mockResolvedValue(
        new window.Blob(['zip-bytes'], { type: 'application/zip' })
      );
    return { window, document, downloads, excel, zipBuilder };
  }

  /** setup() + a completed run of `count` photos (fakePhoto reports 120 KB). */
  async function withPhotos(count = 2) {
    const ctx = setup();
    stubCompressor(ctx.window);
    const files = Array.from({ length: count }, (_, i) => ({
      name: `p${i}.jpg`,
      type: 'image/jpeg',
      size: KB,
    }));
    selectFiles(ctx.window, files);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);
    return ctx;
  }

  it('renders the three actions in order: Excel, ZIP, Cancel', async () => {
    const { document } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    const labels = Array.from(
      document.querySelectorAll('#save-modal .modal-actions .btn')
    ).map((b) => b.textContent.trim());
    expect(labels).toEqual([
      'Download Excel',
      'Download Photos & Excel in ZIP',
      'Cancel',
    ]);
  });

  it('does nothing while the modal is closed', () => {
    const { document, downloads, zipBuilder } = setup();
    document.getElementById('save-zip-btn').click();
    expect(downloads).toHaveLength(0);
    expect(zipBuilder).not.toHaveBeenCalled();
    expect(document.getElementById('save-modal').hidden).toBe(true);
  });

  it('ZIP button: one <base>.zip download carrying the workbook and the photo blobs', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    document.getElementById('generate-btn').click();

    // v12.0 — the base name is composed from the dialog's two fields.
    confirmSave(window, { date: '19.09.2026', filename: 'My Report', zip: true });

    // The modal closes synchronously; the export resolves async.
    expect(document.getElementById('save-modal').hidden).toBe(true);
    await waitFor(() => downloads.length === 1);

    expect(downloads[0]).toBe('19.09.2026 My Report.zip');
    expect(downloads.types[0]).toBe('application/zip');
    expect(excel).toHaveBeenCalledTimes(1); // workbook built exactly once

    expect(zipBuilder).toHaveBeenCalledTimes(1);
    const spec = zipBuilder.mock.calls[0][0];
    expect(spec.xlsxName).toBe('19.09.2026 My Report.xlsx');
    expect(spec.rootFolder).toBe('19.09.2026 My Report');
    expect(spec.photos).toHaveLength(2);
    spec.photos.forEach((photo, i) => {
      expect(photo.originalName).toBe(`p${i}.jpg`);
      expect(photo.blob).toBeTruthy();
    });

    expect(document.getElementById('status').textContent).toBe(
      'Download started.'
    );
  });

  it('Excel button: the plain .xlsx path, ZIP stage untouched', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });
    await waitFor(() => downloads.length === 1);

    expect(downloads[0]).toBe('19.09.2026 My Report.xlsx');
    expect(downloads.types[0]).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(excel).toHaveBeenCalledTimes(1);
    expect(zipBuilder).not.toHaveBeenCalled();
    expect(document.getElementById('status').textContent).toBe(
      'Download started.'
    );
  });

  it('ZIP failure falls back to the .xlsx download and keeps the selection', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    zipBuilder.mockRejectedValueOnce(new Error('JSZip is not loaded'));
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '19.09.2026', filename: 'My Report', zip: true });
    await waitFor(() => downloads.length === 1);

    expect(downloads[0]).toBe('19.09.2026 My Report.xlsx');
    expect(downloads.types[0]).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(excel).toHaveBeenCalledTimes(1);
    expect(document.getElementById('status').textContent).toBe(
      'ZIP failed — Excel downloaded instead.'
    );
    // The selection survives a degraded-but-successful export.
    expect(document.getElementById('file-list').children.length).toBe(2);
  });

  it('keeps the selection after a successful ZIP download (v26.0)', async () => {
    const { window, document, downloads } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      zip: true,
    });
    await waitFor(() => downloads.length === 1);

    // v26.0 — the export succeeds and the list stays intact; clearing is manual.
    expect(document.getElementById('file-list').children.length).toBe(2);
    expect(document.getElementById('status').textContent).toBe(
      'Download started.'
    );
  });
});