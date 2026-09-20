/**
 * save-modal.test.js — the v8.0 save/confirm dialog:
 *   - Generate opens the dialog instead of exporting straight away
 *   - the metrics show the file count and the COMPRESSED total only (the size
 *     line is hidden while the batch is not fully compressed)
 *   - v12.0 — the name is split into a DATE field (left, auto-filled with the
 *     detected report date) and a BASE NAME field (right, default
 *     "Photo report"); the fields hold no extension, the app joins them with
 *     "_" and attaches .xlsx on export
 *   - the auto-clear checkbox empties the selection via clearFiles() on success
 *   - Cancel / Escape / backdrop close without exporting
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  fakePhoto,
  stubCompressor,
  stubDownloads,
  readSaveModal,
  confirmSave,
  todayDefaultName,
  todayDateText,
  readStoredAutoclear,
  AUTOCLEAR_KEY,
} from '../helpers/app-dom.js';
import {
  jpegWithExif,
  jpegWithoutExif,
} from '../helpers/exif-fixtures.js';

const KB = 1024;
const ARROW = '\u2192';

describe('save dialog', () => {
  let dom;

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    if (dom) dom.dom.window.close();
    dom = null;
  });

  /** Fresh window with the download path captured and Stage 2 stubbed. */
  function setup() {
    dom = createAppDom();
    const { window, document } = dom;
    const downloads = stubDownloads(window);
    const excel = vi
      .spyOn(window.ExcelWriter, 'buildExcelWorkbook')
      .mockResolvedValue(new window.Uint8Array([0x50, 0x4b]));
    return { window, document, downloads, excel };
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

  it('is hidden at boot, and its buttons do nothing while it is closed', () => {
    const { document, downloads, excel } = setup();

    const modal = readSaveModal(document);
    expect(modal.overlay).not.toBeNull();
    expect(modal.hidden).toBe(true);
    expect(modal.sizeHidden).toBe(true);
    expect(modal.suffix).toBe('.xlsx');
    expect(modal.confirm).not.toBeNull();
    expect(modal.cancel).not.toBeNull();

    modal.confirm.click();
    modal.cancel.click();

    expect(downloads).toHaveLength(0);
    expect(excel).not.toHaveBeenCalled();
    expect(readSaveModal(document).hidden).toBe(true);
  });

  it('cannot open while there is nothing to export', () => {
    const { document } = setup();
    const generate = document.getElementById('generate-btn');
    expect(generate.disabled).toBe(true);

    generate.click(); // jsdom does not dispatch on a disabled button
    expect(readSaveModal(document).hidden).toBe(true);
  });

  it('renders no title or hint, and the export buttons read Excel / ZIP / Cancel', () => {
    const { document } = setup();
    const modal = readSaveModal(document);

    expect(modal.title).toBeNull();
    expect(modal.hint).toBeNull();
    // v9.0 — three explicit actions instead of a single "Save".
    expect(modal.confirmLabel).toBe('Download Excel');
    expect(modal.zipLabel).toBe('Download Photos & Excel in ZIP');
    expect(modal.cancel.textContent.trim()).toBe('Cancel');
    // The dialog still has an accessible name without a visible heading.
    expect(modal.overlay.getAttribute('aria-label')).toBe('Save photo report');
  });

  it('shows the file count, the compressed total and the split default name', async () => {
    const { document } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    const modal = readSaveModal(document);
    expect(modal.hidden).toBe(false);
    expect(modal.files).toBe('Photos quantity: 2');
    expect(modal.size).toBe('Total size: 240.0 KB'); // 2 x fakePhoto 120 KB
    expect(modal.sizeHidden).toBe(false);

    // v12.0 — LEFT field: the auto-detected date (today - these fakes carry no
    // capture date); RIGHT field: the default base name. Neither holds an
    // extension, and the join happens only on export.
    expect(modal.date).toBe(todayDateText());
    expect(modal.date).not.toContain('.xlsx');
    expect(modal.filename).toBe('Photo report');
    expect(modal.filename).not.toContain('.xlsx');
    expect(modal.suffix).toBe('.xlsx');

    // The controls really are laid out date-first inside the one row.
    const ids = Array.from(
      document.querySelectorAll('#save-modal .modal-name-box .modal-input')
    ).map((input) => input.id);
    expect(ids).toEqual(['save-date', 'save-filename']);

    expect(modal.autoclear).toBe(false);
    expect(document.activeElement).toBe(
      document.getElementById('save-filename')
    );
  });

  it('agrees with the top summary it replaced (v9.1)', async () => {
    const { document } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    // v9.1 — the grid footer (#file-total-size) is gone; its totals now live
    // in the top status bar (#file-summary) and the dialog must match them.
    expect(document.getElementById('file-total-size')).toBeNull();
    const summary = document.getElementById('file-summary').textContent;
    const modal = readSaveModal(document);
    const compressed = modal.size.replace('Total size: ', '');

    expect(summary).toBe(`Total size: 2.0 KB ${ARROW} ${compressed}`);
  });

  it('hides the size line while the batch is not fully compressed', async () => {
    const ctx = await withPhotos(2);
    const { window, document } = ctx;

    // Re-compress with the FIRST call gated: state.processedPhotos is emptied
    // immediately while the previous layout is still in place, which is exactly
    // the "in progress" state the size line must not report a number for.
    let release;
    vi.spyOn(window.Compressor, 'compressToTarget').mockImplementation(() => {
      if (!release) {
        return new Promise((resolve) => {
          release = () => resolve(fakePhoto(window));
        });
      }
      return Promise.resolve(fakePhoto(window));
    });

    const min = document.getElementById('min-kb-input');
    min.value = '150';
    min.dispatchEvent(new window.Event('change', { bubbles: true }));

    document.getElementById('generate-btn').click();

    const modal = readSaveModal(document);
    expect(modal.hidden).toBe(false);
    expect(modal.files).toBe('Photos quantity: 2');
    expect(modal.sizeHidden).toBe(true);
    expect(modal.size).toBe('');

    // Once the batch completes, a fresh open shows the number again.
    // v9.2 — the re-compression run sorts the batch (EXIF head reads) before it
    // reaches the encode loop, so wait for the gated first call to arrive.
    await waitFor(() => typeof release === 'function');
    release();
    await waitFor(() =>
      document.getElementById('status').textContent.startsWith('Processed 2/2')
    );
    document.getElementById('save-cancel-btn').click();
    document.getElementById('generate-btn').click();
    expect(readSaveModal(document).sizeHidden).toBe(false);
  });

  it('sanitizes the name field in real time', async () => {
    const { window, document } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    const input = document.getElementById('save-filename');
    const type = (value) => {
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    type('a/b\\c:d*e?f"g<h>i|j');
    expect(input.value).toBe('abcdefghij');

    type('Report.xlsx');
    expect(input.value).toBe('Report');

    type('   ');
    expect(input.value).toBe('');
  });

  it('sanitizes the DATE field live but keeps dots typeable (v12.0)', async () => {
    const { window, document } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    const input = document.getElementById('save-date');
    const type = (value) => {
      input.value = value;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };

    // The forbidden characters go exactly as in the base-name field...
    type('19/09/2026');
    expect(input.value).toBe('19092026');

    // ...but the dots survive keystroke by keystroke: the full sanitize would
    // eat the trailing dot and make "19.09.2026" impossible to type.
    type('19.');
    expect(input.value).toBe('19.');
    type('19.09.2026');
    expect(input.value).toBe('19.09.2026');

    // Only the export-time sanitize strips a typed extension from this field.
    type('19.09.2026.xlsx');
    expect(input.value).toBe('19.09.2026.xlsx');
  });

  it('exports the two fields joined by "_" with exactly one .xlsx', async () => {
    const { window, document, downloads, excel } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '19.09.2026', filename: 'My Report' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026_My Report.xlsx');
    expect(readSaveModal(document).hidden).toBe(true);
    expect(excel).toHaveBeenCalledTimes(1);
    await waitFor(
      () => document.getElementById('status').textContent === 'Download started.'
    );
  });

  it('never doubles an extension the user typed into either field', async () => {
    const { window, document, downloads } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '19.09.2026', filename: 'Report.xlsx' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026_Report.xlsx');
  });

  it('falls back to the dated default when both fields are emptied', async () => {
    const { window, document, downloads } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '', filename: '' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe(`${todayDefaultName()}.xlsx`);
  });

  it('keeps the date as the strict prefix when only the name is emptied', async () => {
    const { window, document, downloads } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    confirmSave(window, { date: '19.09.2026', filename: '   ' });

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe('19.09.2026_Photo report.xlsx');
  });

  it('confirms on Enter in the name field', async () => {
    const { window, document, downloads } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    document
      .getElementById('save-filename')
      .dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe(`${todayDefaultName()}.xlsx`);
  });

  it('confirms on Enter in the date field too (v12.0)', async () => {
    const { window, document, downloads } = await withPhotos(1);
    document.getElementById('generate-btn').click();

    document
      .getElementById('save-date')
      .dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );

    await waitFor(() => downloads.length === 1);
    expect(downloads[0]).toBe(`${todayDefaultName()}.xlsx`);
  });

  it('clears the selection after a successful save when auto-clear is ticked', async () => {
    const { window, document, downloads } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    confirmSave(window, { filename: 'Clear me', autoClear: true });

    await waitFor(() => downloads.length === 1);
    expect(document.getElementById('file-list').children).toHaveLength(0);
    expect(document.getElementById('file-summary').textContent).toBe(
      'No photos selected.'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(true);
    // clearFiles() blanks the status line, so the success message must outlive it.
    expect(document.getElementById('status').textContent).toBe(
      'Download started.'
    );
  });

  it('keeps the selection when auto-clear is left unchecked (the default)', async () => {
    const { window, document, downloads } = await withPhotos(2);
    document.getElementById('generate-btn').click();

    confirmSave(window, { filename: 'Keep me' });

    await waitFor(() => downloads.length === 1);
    expect(document.getElementById('file-list').children).toHaveLength(2);
    expect(document.getElementById('file-summary').textContent).toBe(
      'Total size: 2.0 KB → 240.0 KB'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('closes without exporting on Cancel, Escape and a backdrop click', async () => {
    const { window, document, downloads, excel } = await withPhotos(1);
    const generate = document.getElementById('generate-btn');

    generate.click();
    document.getElementById('save-cancel-btn').click();
    expect(readSaveModal(document).hidden).toBe(true);

    generate.click();
    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(readSaveModal(document).hidden).toBe(true);

    // A click on the card itself must NOT close the dialog...
    generate.click();
    document
      .querySelector('#save-modal .modal')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(readSaveModal(document).hidden).toBe(false);

    // ...but the backdrop (the overlay element itself) does.
    document
      .getElementById('save-modal')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(readSaveModal(document).hidden).toBe(true);

    expect(downloads).toHaveLength(0);
    expect(excel).not.toHaveBeenCalled();
  });

  it('reports a Stage 2 failure without exporting or clearing', async () => {
    const { window, document, downloads, excel } = await withPhotos(2);
    excel.mockRejectedValue(new Error('no workbook for you'));

    document.getElementById('generate-btn').click();
    confirmSave(window, { filename: 'Nope', autoClear: true });

    await waitFor(() =>
      document.getElementById('status').textContent.includes('Failed')
    );
    expect(document.getElementById('status').textContent).toBe(
      'Failed to generate Excel — see console.'
    );
    expect(downloads).toHaveLength(0);
    expect(readSaveModal(document).hidden).toBe(true);
    expect(document.getElementById('file-list').children).toHaveLength(2);
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('reopens with a fresh name but remembers the auto-clear choice', async () => {
    const { window, document, downloads } = await withPhotos(2);
    const generate = document.getElementById('generate-btn');

    generate.click();
    confirmSave(window, { filename: 'First', autoClear: true });
    await waitFor(() => downloads.length === 1);
    expect(generate.disabled).toBe(true);
    expect(readStoredAutoclear(window)).toBe('true');

    // Nothing is selected any more, so the dialog cannot reopen...
    generate.click();
    expect(readSaveModal(document).hidden).toBe(true);

    // ...until a new selection arrives: the name is fresh, the choice is kept.
    stubCompressor(window);
    selectFiles(window, [{ name: 'c.jpg', type: 'image/jpeg', size: KB }]);
    await waitFor(() => !generate.disabled);

    generate.click();
    const modal = readSaveModal(document);
    expect(modal.hidden).toBe(false);
    // v12.0 — both fields come back fresh: the detected date and the default
    // base name (the typed "First" is gone).
    expect(modal.date).toBe(todayDateText());
    expect(modal.filename).toBe('Photo report');
    expect(modal.autoclear).toBe(true);
    expect(modal.size).toBe('Total size: 120.0 KB');
  });

  it('remembers the auto-clear checkbox across opens, in both directions', async () => {
    const { window, document } = await withPhotos(1);
    const generate = document.getElementById('generate-btn');
    const box = document.getElementById('save-autoclear');

    generate.click();
    expect(box.checked).toBe(false); // nothing stored yet

    box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(readStoredAutoclear(window)).toBe('true');

    document.getElementById('save-cancel-btn').click();
    generate.click();
    expect(readSaveModal(document).autoclear).toBe(true);

    box.checked = false;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(readStoredAutoclear(window)).toBe('false');

    document.getElementById('save-cancel-btn').click();
    generate.click();
    expect(readSaveModal(document).autoclear).toBe(false);
  });

  it('restores the stored preference at boot, before the dialog is ever opened', () => {
    dom = createAppDom({ seedStorage: { [AUTOCLEAR_KEY]: 'true' } });
    const document = dom.window.document;

    expect(document.getElementById('save-autoclear').checked).toBe(true);
    expect(readSaveModal(document).hidden).toBe(true);
  });

  it('treats a junk stored value as unchecked', () => {
    dom = createAppDom({ seedStorage: { [AUTOCLEAR_KEY]: 'yes' } });

    expect(
      dom.window.document.getElementById('save-autoclear').checked
    ).toBe(false);
  });

  it('takes the default name from the EARLIEST photo EXIF capture date (v9.2)', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    // Selected newest-first: v9.2 sorts the batch chronologically, so the
    // oldest capture (2020) at index 0 names the report.
    selectFiles(ctx.window, [
      {
        name: 'first.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      },
      {
        name: 'second.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2020:01:01 08:00:00' }),
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    const modal = readSaveModal(ctx.document);
    // v12.0 — the detected date fills the LEFT field, the default base name the
    // RIGHT one.
    expect(modal.date).toBe('01.01.2020');
    expect(modal.filename).toBe('Photo report');
  });

  it('falls back to the file timestamp when the first photo has no EXIF', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    const stamp = new Date(2024, 4, 7, 12, 0, 0).getTime();
    selectFiles(ctx.window, [
      {
        name: 'plain.jpg',
        type: 'image/jpeg',
        bytes: jpegWithoutExif(),
        lastModified: stamp,
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    expect(readSaveModal(ctx.document).date).toBe('07.05.2024');
  });

  it('falls back to today when neither EXIF nor a timestamp is usable', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    selectFiles(ctx.window, [
      {
        name: 'none.jpg',
        type: 'image/jpeg',
        bytes: jpegWithoutExif(),
        lastModified: 0,
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    expect(readSaveModal(ctx.document).date).toBe(todayDateText());
  });

  it('exports an EXIF-derived date with exactly one .xlsx', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    selectFiles(ctx.window, [
      {
        name: 'first.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    confirmSave(ctx.window, { filename: '' }); // emptied -> the default base name

    await waitFor(() => ctx.downloads.length === 1);
    expect(ctx.downloads[0]).toBe('19.09.2026_Photo report.xlsx');
  });

  it('lets the user override the detected date in the left field', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    selectFiles(ctx.window, [
      {
        name: 'first.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    expect(readSaveModal(ctx.document).date).toBe('19.09.2026');

    // A retyped date wins over the detected one and stays the prefix.
    confirmSave(ctx.window, { date: '01.02.2030', filename: 'Site visit' });

    await waitFor(() => ctx.downloads.length === 1);
    expect(ctx.downloads[0]).toBe('01.02.2030_Site visit.xlsx');
  });

  it('drops back to today after the selection is cleared', async () => {
    const ctx = setup();
    stubCompressor(ctx.window);
    selectFiles(ctx.window, [
      {
        name: 'first.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    expect(readSaveModal(ctx.document).date).toBe('19.09.2026');
    ctx.document.getElementById('save-cancel-btn').click();

    ctx.document.getElementById('clear-btn').click();
    selectFiles(ctx.window, [
      {
        name: 'none.jpg',
        type: 'image/jpeg',
        bytes: jpegWithoutExif(),
        lastModified: 0,
      },
    ]);
    await waitFor(() => !ctx.document.getElementById('generate-btn').disabled);

    ctx.document.getElementById('generate-btn').click();
    expect(readSaveModal(ctx.document).date).toBe(todayDateText());
  });
});
