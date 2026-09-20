/**
 * file-total.test.js — the v9.1 top status summary (#file-summary):
 *   - always visible; shows "No photos selected." at idle
 *   - shows "N photos selected." while keys are read / compression pending
 *   - flips to "Total size: {original} → {compressed}" once the whole batch
 *     is processed (computeTotals().complete === true)
 *   - recalculated on a KB-range change (re-compression) and on removal
 *   - stays on the count text (no arrow) when a photo failed / was skipped
 *     so the batch is incomplete
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  fakePhoto,
  readFileTotal,
  stubCompressor,
} from '../helpers/app-dom.js';

const KB = 1024;
const ARROW = '\u2192';

// selectFiles() passes `size` into the File constructor.
const IMG = { name: 'a.jpg', type: 'image/jpeg', size: KB };
const IMG2 = { name: 'b.png', type: 'image/png', size: KB };

describe('top status summary (#file-summary)', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('shows "No photos selected." at boot', () => {
    const total = readFileTotal(dom.document);
    expect(total.row).not.toBeNull();
    expect(total.hidden).toBe(false);
    expect(total.size).toBe('No photos selected.');
    expect(dom.document.getElementById('file-list').children).toHaveLength(0);
  });

  it('shows the count while compression is still pending', async () => {
    const { window, document } = dom;
    let release;
    vi.spyOn(window.Compressor, 'compressToTarget').mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(fakePhoto(window));
      })
    );

    selectFiles(window, [IMG, IMG2]);

    // Synchronous: renderFileList() already ran, the compressor has not resolved.
    const pending = readFileTotal(document);
    expect(pending.hidden).toBe(false);
    expect(pending.size).toBe('2 photos selected.');

    release();
    await waitFor(() => readFileTotal(document).size.includes(ARROW));
  });

  it('flips to "Total size: original → compressed" once every photo is processed', async () => {
    const { window, document } = dom;
    stubCompressor(window); // fakePhoto reports 120 KB per photo

    selectFiles(window, [IMG, IMG2]);

    await waitFor(
      () => readFileTotal(document).size === `Total size: 2.0 KB → 240.0 KB`
    );
    const total = readFileTotal(document);
    expect(total.hidden).toBe(false);
    expect(total.size).toBe(`Total size: 2.0 KB → 240.0 KB`);
  });

  it('keeps one <li> per photo and does not contain #file-summary', async () => {
    const { window, document } = dom;
    stubCompressor(window);

    selectFiles(window, [IMG, IMG2]);
    await waitFor(() => readFileTotal(document).size.includes(ARROW));

    const list = document.getElementById('file-list');
    expect(list.children).toHaveLength(2);
    expect(document.querySelectorAll('#file-list li')).toHaveLength(2);
    expect(list.contains(document.getElementById('file-summary'))).toBe(false);
  });

  it('recalculates when a KB-range change re-compresses the selection', async () => {
    const { window, document } = dom;
    let calls = 0;
    const compress = vi
      .spyOn(window.Compressor, 'compressToTarget')
      .mockImplementation(() => {
        calls += 1;
        return Promise.resolve(
          fakePhoto(window, { bytes: calls <= 2 ? 120 * KB : 100 * KB })
        );
      });

    selectFiles(window, [IMG, IMG2]);
    await waitFor(
      () => readFileTotal(document).size === `Total size: 2.0 KB → 240.0 KB`
    );

    const min = document.getElementById('min-kb-input');
    min.value = '120';
    min.dispatchEvent(new window.Event('change', { bubbles: true }));

    await waitFor(
      () => readFileTotal(document).size === `Total size: 2.0 KB → 200.0 KB`
    );
    expect(compress.mock.calls.length).toBe(4);
    expect(compress.mock.calls[3][1]).toMatchObject({ minKB: 120, maxKB: 220 });
  });

  it('recalculates when a new selection replaces the old one', async () => {
    const { window, document } = dom;
    stubCompressor(window);

    selectFiles(window, [IMG, IMG2]);
    await waitFor(
      () => readFileTotal(document).size === `Total size: 2.0 KB → 240.0 KB`
    );

    selectFiles(window, [IMG]);
    await waitFor(
      () => readFileTotal(document).size === `Total size: 1.0 KB → 120.0 KB`
    );
    expect(document.getElementById('file-list').children).toHaveLength(1);
  });

  it('stays on the count when a photo failed and was skipped', async () => {
    const { window, document } = dom;
    vi.spyOn(window.Compressor, 'compressToTarget').mockImplementation((file) =>
      file.name === 'bad.jpg'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve(fakePhoto(window))
    );

    selectFiles(window, [
      IMG,
      { name: 'bad.jpg', type: 'image/jpeg', size: KB },
      IMG2,
    ]);
    await waitFor(() =>
      document.getElementById('status').textContent.startsWith('Processed 2/3')
    );

    const total = readFileTotal(document);
    expect(total.hidden).toBe(false);
    expect(total.size).toBe('3 photos selected.');
    expect(total.size).not.toContain(ARROW);
  });

  it('shows "No photos selected." after Clear', async () => {
    const { window, document } = dom;
    stubCompressor(window);

    selectFiles(window, [IMG, IMG2]);
    await waitFor(() => readFileTotal(document).size.includes(ARROW));

    document.getElementById('clear-btn').click();

    const total = readFileTotal(document);
    expect(total.hidden).toBe(false);
    expect(total.size).toBe('No photos selected.');
    expect(document.getElementById('file-list').children).toHaveLength(0);
  });

  it('shows "No photos selected." when the selection contained no images', () => {
    const { window, document } = dom;
    stubCompressor(window);

    selectFiles(window, [{ name: 'notes.txt', type: 'text/plain', size: 10 }]);

    const total = readFileTotal(document);
    expect(total.hidden).toBe(false);
    expect(total.size).toBe('No photos selected.');
  });
});
