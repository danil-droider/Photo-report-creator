/**
 * save-picker.test.js — the v14.0 native "Save As" export transport.
 *
 * The app asks for a FileSystemFileHandle via window.showSaveFilePicker()
 * BEFORE it generates anything (the click's transient user activation must
 * still be alive), then streams the finished Blob into that handle with
 * createWritable() -> write() -> close().
 *
 * Covered here:
 *   - Excel export: the OS dialog is seeded with the composed
 *     "<date>_<name>.xlsx" and the Excel type filter, the workbook Blob is
 *     written and the stream closed, and NO <a download> happens
 *   - ZIP export: the same for "<date>_<name>.zip" and the ZIP type filter
 *   - Cancel (AbortError) on either button: nothing generated, nothing
 *     written, no fallback download, no auto-clear, no stuck "generating"
 *     state — the selection simply survives for a retry
 *   - a real write error still surfaces as a failure and never clears
 *   - without the API (iOS Safari / Firefox / jsdom) the export falls back to
 *     the unchanged <a download> path
 *
 * Runs the REAL index.html + app.js in jsdom; the canvas, Excel and ZIP stages
 * are stubbed — only the delivery transport is under test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
  stubDownloads,
  stubSavePicker,
  confirmSave,
} from '../helpers/app-dom.js';

const KB = 1024;
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_MIME = 'application/zip';

describe('native "Save As" export transport (v14.0)', () => {
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
      .mockResolvedValue(new window.Blob(['zip-bytes'], { type: ZIP_MIME }));
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

  it('Excel: the dialog gets the composed .xlsx name + filter and receives the workbook', async () => {
    const { window, document, downloads, excel } = await withPhotos(2);
    const picker = stubSavePicker(window);

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    // The in-app dialog closes before the OS dialog is opened.
    expect(document.getElementById('save-modal').hidden).toBe(true);
    await waitFor(() => picker.written.length === 1);

    expect(picker).toHaveLength(1);
    expect(picker[0].suggestedName).toBe('19.09.2026_My Report.xlsx');
    expect(picker[0].types).toEqual([
      {
        description: 'Excel Spreadsheet',
        accept: { [XLSX_MIME]: ['.xlsx'] },
      },
    ]);

    // Exactly ONE workbook build, streamed once into the chosen file.
    expect(excel).toHaveBeenCalledTimes(1);
    expect(picker.written[0].type).toBe(XLSX_MIME);
    expect(picker.written[0].size).toBe(2); // the real buffer, not a copy
    expect(picker.closeCalls).toBe(1);

    // The anchor transport stays completely unused.
    expect(downloads).toHaveLength(0);

    await waitFor(
      () => document.getElementById('status').textContent === 'File saved.'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('ZIP: the dialog gets the composed .zip name + filter and receives the archive', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    const picker = stubSavePicker(window);

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report', zip: true });

    await waitFor(() => picker.written.length === 1);

    expect(picker[0].suggestedName).toBe('19.09.2026_My Report.zip');
    expect(picker[0].types).toEqual([
      { description: 'ZIP Archive', accept: { [ZIP_MIME]: ['.zip'] } },
    ]);

    expect(excel).toHaveBeenCalledTimes(1);
    expect(zipBuilder).toHaveBeenCalledTimes(1);
    expect(picker.written[0].type).toBe(ZIP_MIME);
    expect(picker.closeCalls).toBe(1);
    expect(downloads).toHaveLength(0);

    await waitFor(
      () => document.getElementById('status').textContent === 'File saved.'
    );
  });

  it('Excel cancel (AbortError) generates nothing and keeps the selection', async () => {
    const { window, document, downloads, excel } = await withPhotos(2);
    const picker = stubSavePicker(window, { cancel: true });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      autoClear: true,
    });

    await waitFor(
      () => document.getElementById('status').textContent === 'Save cancelled.'
    );

    // A cancel is a normal outcome: no generation, no write, no fallback
    // download, and above all no auto-clear.
    expect(excel).not.toHaveBeenCalled();
    expect(picker.written).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(document.getElementById('file-list').children.length).toBe(2);
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('ZIP cancel (AbortError) never builds the archive and keeps the selection', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    const picker = stubSavePicker(window, { cancel: true });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      zip: true,
      autoClear: true,
    });

    await waitFor(
      () => document.getElementById('status').textContent === 'Save cancelled.'
    );

    expect(excel).not.toHaveBeenCalled();
    expect(zipBuilder).not.toHaveBeenCalled();
    expect(picker.written).toHaveLength(0);
    expect(downloads).toHaveLength(0);
    expect(document.getElementById('file-list').children.length).toBe(2);
  });

  it('a write failure reports the failure and never auto-clears', async () => {
    const { window, document, downloads } = await withPhotos(2);
    const errorSpy = vi
      .spyOn(window.console, 'error')
      .mockImplementation(() => {});

    // The user picked a file, but the stream refuses to write.
    window.showSaveFilePicker = async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new window.Error('disk full');
        },
        close: async () => {},
      }),
    });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      autoClear: true,
    });

    await waitFor(
      () =>
        document.getElementById('status').textContent ===
        'Failed to generate Excel — see console.'
    );

    expect(errorSpy).toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
    expect(document.getElementById('file-list').children.length).toBe(2);
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('without the API the export falls back to the <a download> path', async () => {
    const { window, document, downloads } = await withPhotos(1);
    // jsdom ships no File System Access API — that IS the fallback case.
    expect(window.showSaveFilePicker).toBeUndefined();

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026_My Report.xlsx');
    await waitFor(
      () => document.getElementById('status').textContent === 'Download started.'
    );
  });
});
