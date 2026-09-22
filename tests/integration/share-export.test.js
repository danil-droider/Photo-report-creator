/**
 * share-export.test.js — the v19.0 Web Share API export transport.
 *
 * When no save-picker handle exists, the finished file is offered to the
 * native share sheet via navigator.share({ files }) — the iOS Safari path
 * whose "Save to Files" / AirDrop rows replace the forced Downloads drop —
 * and only degrades to the classic <a download> anchor when the API is
 * missing or refuses the file.
 *
 * Covered here:
 *   - Excel export: the sheet receives a File carrying the composed
 *     "<date>_<name>.xlsx" name and the spreadsheet MIME, and NO anchor
 *     download runs
 *   - ZIP export: the same for "<date>_<name>.zip" and the ZIP MIME
 *   - v24.0: the share payload is FILES-ONLY ({ files } with no title / text /
 *     url), because iOS WebKit serializes such a string as a second share item
 *     and drops a stray text.txt / text 2.txt beside the saved file
 *   - dismissal (AbortError) on either button: the workbook may already be
 *     built, but nothing downloads, nothing is cleared and the generating
 *     state never sticks — the selection simply survives for a retry
 *   - NotAllowedError (the build outlived the tap's transient activation):
 *     a silent degrade to the anchor download — the export is never lost
 *   - canShare() refusing the file: the same anchor fallback
 *   - without the Web Share API at all (jsdom default / desktop Firefox):
 *     the unchanged <a download> path the older suites pin
 *
 * Runs the REAL index.html + app.js in jsdom; the canvas, Excel and ZIP
 * stages are stubbed — only the delivery transport is under test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
  stubDownloads,
  stubShare,
  confirmSave,
} from '../helpers/app-dom.js';

const KB = 1024;
const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ZIP_MIME = 'application/zip';

describe('Web Share export transport (v19.0)', () => {
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

  it('Excel: the sheet receives the composed .xlsx File and no anchor download runs', async () => {
    const { window, document, downloads } = await withPhotos(2);
    const shares = stubShare(window);

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    await waitFor(() => shares.length === 1);

    expect(shares[0].files).toHaveLength(1);
    const file = shares[0].files[0];
    expect(file).toBeInstanceOf(window.File);
    expect(file.name).toBe('19.09.2026 My Report.xlsx');
    expect(file.type).toBe(XLSX_MIME);

    // v24.0 — FILES-ONLY payload: iOS WebKit serializes an accompanying
    // title / text / url string as a second share item, which is what dropped a
    // stray text.txt sidecar next to the saved file.
    expect(Object.keys(shares[0])).toEqual(['files']);
    expect(shares[0].title).toBeUndefined();
    expect(shares[0].text).toBeUndefined();
    expect(shares[0].url).toBeUndefined();

    // The sheet replaced the anchor download entirely.
    expect(downloads).toHaveLength(0);
    await waitFor(
      () => document.getElementById('status').textContent === 'File shared.'
    );
  });

  it('ZIP: the sheet receives the .zip File and no anchor download runs', async () => {
    const { window, document, downloads, excel, zipBuilder } =
      await withPhotos(2);
    const shares = stubShare(window);

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      zip: true,
    });

    await waitFor(() => shares.length === 1);

    expect(zipBuilder).toHaveBeenCalledTimes(1);
    expect(excel).toHaveBeenCalledTimes(1); // the workbook is built exactly once
    expect(shares[0].files).toHaveLength(1);
    expect(shares[0].files[0].name).toBe('19.09.2026 My Report.zip');
    expect(shares[0].files[0].type).toBe(ZIP_MIME);
    // v24.0 — the .zip offer is files-only as well: no auxiliary string field
    // may ride along, or iOS saves a text.txt sidecar beside the archive.
    expect(Object.keys(shares[0])).toEqual(['files']);
    expect(shares[0].title).toBeUndefined();
    expect(shares[0].text).toBeUndefined();
    expect(shares[0].url).toBeUndefined();
    expect(downloads).toHaveLength(0);
    await waitFor(
      () => document.getElementById('status').textContent === 'File shared.'
    );
  });

  // v24.0 — iOS SIDECAR REGRESSION GUARD. The stray text.txt / text 2.txt that
  // appeared next to the saved .zip was WebKit serializing the share payload's
  // `title` string as a SECOND share item. The payload must therefore stay
  // files-only: exactly one key, one File, and not a single string value.
  it('ZIP share payload is files-only — no title / text / url that iOS could save as text.txt', async () => {
    const { window, document } = await withPhotos(2);
    const shares = stubShare(window);

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report', zip: true });

    await waitFor(() => shares.length === 1);

    const payload = shares[0];
    expect(Object.keys(payload)).toEqual(['files']);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toBeInstanceOf(window.File);
    expect(payload.files[0].name).toBe('19.09.2026 My Report.zip');
    expect(payload.files[0].type).toBe(ZIP_MIME);
    // Not one string payload rides along, so the platform cannot mint a sidecar.
    expect(Object.values(payload).filter((v) => typeof v === 'string')).toEqual(
      []
    );
  });

  it('Excel dismissal (AbortError) downloads nothing and keeps the selection', async () => {
    const { window, document, downloads, excel } = await withPhotos(2);
    const shares = stubShare(window, { cancel: true });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
    });

    await waitFor(
      () => document.getElementById('status').textContent === 'Share cancelled.'
    );

    // Unlike a picker cancel the workbook WAS built (the sheet needs the
    // finished file), but a dismissal is still a normal outcome: no download,
    // no clearing, no stuck generating state.
    expect(excel).toHaveBeenCalledTimes(1);
    expect(shares).toHaveLength(1);
    expect(downloads).toHaveLength(0);
    expect(document.getElementById('file-list').children.length).toBe(2);
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('ZIP dismissal (AbortError) downloads nothing and keeps the selection', async () => {
    const { window, document, downloads, zipBuilder } = await withPhotos(2);
    const shares = stubShare(window, { cancel: true });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
      zip: true,
    });

    await waitFor(
      () => document.getElementById('status').textContent === 'Share cancelled.'
    );

    expect(zipBuilder).toHaveBeenCalledTimes(1);
    expect(shares).toHaveLength(1);
    expect(downloads).toHaveLength(0);
    expect(document.getElementById('file-list').children.length).toBe(2);
  });

  it('NotAllowedError (dead user activation) degrades to the anchor download', async () => {
    const { window, document, downloads } = await withPhotos(2);
    const warnSpy = vi
      .spyOn(window.console, 'warn')
      .mockImplementation(() => {});
    const shares = stubShare(window, { notAllowed: true });

    document.getElementById('generate-btn').click();
    confirmSave(window, {
      date: '19.09.2026',
      filename: 'My Report',
    });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026 My Report.xlsx');
    expect(downloads.types[0]).toBe(XLSX_MIME);
    expect(shares).toHaveLength(1);
    await waitFor(
      () =>
        document.getElementById('status').textContent === 'Download started.'
    );
    expect(warnSpy).toHaveBeenCalled();
    // The export went through and the selection stays intact (v26.0).
    expect(document.getElementById('file-list').children.length).toBe(2);
  });

  it('a canShare() refusal degrades to the anchor download', async () => {
    const { window, document, downloads } = await withPhotos(1);
    const shares = stubShare(window, { accept: false });

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026 My Report.xlsx');
    // The engine refused the file, so the sheet was never opened.
    expect(shares).toHaveLength(0);
    await waitFor(
      () =>
        document.getElementById('status').textContent === 'Download started.'
    );
  });

  it('without the Web Share API the export falls back to the <a download> path', async () => {
    const { window, document, downloads } = await withPhotos(1);
    // jsdom ships no Web Share API — that IS the fallback case.
    expect(window.navigator.share).toBeUndefined();

    document.getElementById('generate-btn').click();
    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026 My Report.xlsx');
    await waitFor(
      () =>
        document.getElementById('status').textContent === 'Download started.'
    );
  });
});
