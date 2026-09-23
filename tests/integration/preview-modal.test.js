/**
 * preview-modal.test.js — the v27.0 desktop Excel layout preview.
 *
 * Runs the REAL index.html + app.js + preview.js in jsdom with the canvas
 * compressor stubbed. Verifies:
 *   - Preview is disabled at boot and until a batch is fully processed;
 *   - opening forwards state.layout UNCHANGED and never re-runs Stage 1;
 *   - images sit at the exact Stage 1 x/y/width/height;
 *   - the simulated Excel headers/grid are rendered;
 *   - zoom controls update the scale;
 *   - close/Escape clear the DOM and revoke every preview-owned Object URL;
 *   - a missing createObjectURL degrades to placeholders;
 *   - Excel generation is never triggered by the preview.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
} from '../helpers/app-dom.js';

const KB = 1024;

describe('desktop layout preview', () => {
  let dom;

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    if (dom) dom.dom.window.close();
    dom = null;
  });

  function stubPreviewUrls(window) {
    const created = [];
    const revoked = [];
    window.URL.createObjectURL = () => {
      const url = `blob:preview-${created.length}`;
      created.push(url);
      return url;
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);
    return { created, revoked };
  }

  function capturePreviewOpen(window) {
    const calls = [];
    const original = window.Preview.open;
    vi.spyOn(window.Preview, 'open').mockImplementation((layout) => {
      calls.push(layout);
      return original.call(window.Preview, layout);
    });
    return calls;
  }

  async function withPhotos(count = 2) {
    dom = createAppDom();
    const { window, document } = dom;
    const urls = stubPreviewUrls(window);
    const calls = capturePreviewOpen(window);
    stubCompressor(window);

    const files = Array.from({ length: count }, (_, i) => ({
      name: `p${i}.jpg`,
      type: 'image/jpeg',
      size: KB,
    }));
    selectFiles(window, files);
    await waitFor(() => !document.getElementById('preview-btn').disabled);

    // The selection itself creates the file-list thumbnail URLs through the
    // same stubbed API. Reset the counters so these tests observe ONLY the
    // preview-owned URLs created when the modal opens.
    urls.created.length = 0;
    urls.revoked.length = 0;

    return { window, document, urls, calls };
  }

  it('is hidden and disabled at boot', () => {
    dom = createAppDom();
    const { document } = dom;

    expect(document.getElementById('preview-modal').hidden).toBe(true);
    expect(document.getElementById('preview-btn').disabled).toBe(true);
    expect(document.getElementById('version-badge').textContent).toBe('v27.0');
  });

  it('stays disabled while the batch is not processed', async () => {
    dom = createAppDom();
    const { window, document } = dom;
    stubPreviewUrls(window);
    // Hold every encode open so the layout never becomes current.
    vi.spyOn(window.Compressor, 'compressToTarget').mockReturnValue(
      new Promise(() => {})
    );

    selectFiles(window, [{ name: 'a.jpg', type: 'image/jpeg', size: KB }]);
    await waitFor(() => document.querySelector('#file-list li') !== null);

    expect(document.getElementById('preview-btn').disabled).toBe(true);
  });

  it('opens with one image per Stage 1 rectangle and never calls Excel', async () => {
    const { window, document, calls } = await withPhotos(3);
    const excel = vi.spyOn(window.ExcelWriter, 'buildExcelWorkbook');
    const layoutCalls = vi.spyOn(window.Layout, 'calculateLayout');
    layoutCalls.mockClear(); // selection already ran Stage 1

    document.getElementById('preview-btn').click();

    expect(document.getElementById('preview-modal').hidden).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);

    const images = document.querySelectorAll(
      '#preview-photos img.preview-photo'
    );
    expect(images).toHaveLength(3);

    // Exact Stage 1 geometry, consumed unchanged.
    for (let i = 0; i < 3; i++) {
      expect(images[i].style.left).toBe(calls[0][i].x + 'px');
      expect(images[i].style.top).toBe(calls[0][i].y + 'px');
      expect(images[i].style.width).toBe(calls[0][i].width + 'px');
      expect(images[i].style.height).toBe(calls[0][i].height + 'px');
    }

    expect(layoutCalls).not.toHaveBeenCalled();
    expect(excel).not.toHaveBeenCalled();
  });

  it('renders the simulated Excel headers and desktop baseline', async () => {
    const { document } = await withPhotos(1);
    document.getElementById('preview-btn').click();

    const columns = document.querySelectorAll(
      '#preview-column-headers .preview-col-label'
    );
    const rows = document.querySelectorAll(
      '#preview-row-headers .preview-row-label'
    );

    expect(columns).toHaveLength(20); // 1280 px / 64 px
    expect(rows).toHaveLength(36); // 720 px / 20 px
    expect(columns[0].textContent).toBe('A');
    expect(rows[0].textContent).toBe('1');
    // The rails precede the grid: A starts at x=44, row 1 at y=24.
    expect(columns[0].style.left).toBe('44px');
    expect(rows[0].style.top).toBe('24px');
    expect(columns[1].style.left).toBe('108px');

    const grid = document.getElementById('preview-grid');
    expect(grid.style.width).toBe('1280px');
    expect(grid.style.height).toBe('720px');
    expect(grid.style.backgroundSize).toBe('64px 20px');
  });

  it('zooms in/out and Fit restores the initial scale', async () => {
    const { document } = await withPhotos(1);
    const label = document.getElementById('preview-zoom-label');

    document.getElementById('preview-btn').click();
    const fitted = label.textContent;
    expect(fitted).toMatch(/^\d+%$/);

    document.getElementById('preview-zoom-in').click();
    expect(label.textContent).not.toBe(fitted);

    document.getElementById('preview-zoom-fit').click();
    expect(label.textContent).toBe(fitted);
  });

  it('close clears the photos and revokes every preview-owned URL', async () => {
    const { document, urls } = await withPhotos(2);
    document.getElementById('preview-btn').click();
    expect(urls.created).toHaveLength(2);

    document.getElementById('preview-close').click();

    expect(document.getElementById('preview-modal').hidden).toBe(true);
    expect(document.querySelectorAll('#preview-photos img')).toHaveLength(0);
    expect(document.body.classList.contains('preview-open')).toBe(false);
    expect(urls.revoked).toEqual(urls.created);
  });

  it('Escape closes the preview and releases its URLs', async () => {
    const { window, document, urls } = await withPhotos(1);
    document.getElementById('preview-btn').click();

    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    expect(document.getElementById('preview-modal').hidden).toBe(true);
    expect(urls.revoked).toEqual(urls.created);
  });

  it('falls back to placeholders when createObjectURL is unavailable', async () => {
    const { window, document } = await withPhotos(2);
    window.URL.createObjectURL = undefined;

    document.getElementById('preview-btn').click();

    expect(document.querySelectorAll('#preview-photos img')).toHaveLength(0);
    expect(
      document.querySelectorAll('#preview-photos .preview-photo-placeholder')
    ).toHaveLength(2);
  });
});
