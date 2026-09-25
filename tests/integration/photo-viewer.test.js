/**
 * photo-viewer.test.js — the v30.0 fullscreen photo viewer contract:
 *   - tapping a file-list row (thumbnail or text) opens the card on THAT photo
 *     and shows its ORIGINAL high-res preview (thumbnailUrls[index]);
 *   - the row's remove cross still wins over the row (no viewer opens);
 *   - Keep closes the viewer and keeps the photo;
 *   - Delete removes the photo through the existing removeFile() path, revokes
 *     its Object URL exactly once and slides the next photo in; the viewer
 *     closes when the batch is now empty;
 *   - Esc closes, Delete / Backspace removes, the backdrop dismisses and a click
 *     inside the card does not;
 *   - the viewer mints NO Object URL of its own.
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
} from '../helpers/app-dom.js';

const KB = 1024;

describe('fullscreen photo viewer (v30.0)', () => {
  let dom;

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    if (dom) dom.dom.window.close();
    dom = null;
  });

  /** One preview URL per File plus a record of every revoke. */
  function stubViewerUrls(window) {
    const created = [];
    const revoked = [];
    window.URL.createObjectURL = (blob) => {
      const url = `blob:view-${blob && blob.name ? blob.name : created.length}`;
      created.push(url);
      return url;
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);
    return { created, revoked };
  }

  async function withPhotos(names) {
    dom = createAppDom();
    const { window, document } = dom;
    const urls = stubViewerUrls(window);
    stubCompressor(window);

    selectFiles(
      window,
      names.map((name) => ({ name, type: 'image/jpeg', size: KB }))
    );
    await waitFor(
      () =>
        document.getElementById('file-list').children.length === names.length
    );
    await waitFor(() => !document.getElementById('generate-btn').disabled);

    return { window, document, urls };
  }

  const viewer = (document) => document.getElementById('photo-viewer-modal');
  const viewerImg = (document) => document.getElementById('photo-viewer-img');
  const viewerName = (document) => document.getElementById('photo-viewer-name');
  const viewerCounter = (document) =>
    document.getElementById('photo-viewer-counter');
  const rows = (document) =>
    Array.from(document.querySelectorAll('#file-list li'));
  const rowNames = (document) =>
    Array.from(document.querySelectorAll('#file-list .file-name')).map(
      (n) => n.textContent
    );

  function openRow(document, index) {
    rows(document)[index].querySelector('img.photo-thumb').click();
  }

  it('is hidden at boot', () => {
    dom = createAppDom();
    expect(viewer(dom.document).hidden).toBe(true);
  });

  it('opens on the tapped row and shows that photo original preview', async () => {
    const { document } = await withPhotos(['p0.jpg', 'p1.jpg', 'p2.jpg']);

    const row = rows(document)[1];
    expect(row.querySelector('img.photo-thumb')).not.toBeNull();
    row.querySelector('img.photo-thumb').click();

    expect(viewer(document).hidden).toBe(false);
    expect(viewerImg(document).getAttribute('src')).toBe('blob:view-p1.jpg');
    expect(viewerImg(document).alt).toBe('p1.jpg');
    expect(viewerName(document).textContent).toBe('p1.jpg');
    expect(viewerCounter(document).textContent).toBe('2 / 3');
  });

  it('also opens when the row text (not just the thumbnail) is tapped', async () => {
    const { document } = await withPhotos(['p0.jpg', 'p1.jpg']);

    rows(document)[1].querySelector('.file-name').click();

    expect(viewer(document).hidden).toBe(false);
    expect(viewerName(document).textContent).toBe('p1.jpg');
  });

  it('lets the remove cross win over the row', async () => {
    const { document } = await withPhotos(['p0.jpg', 'p1.jpg']);

    rows(document)[0].querySelector('.file-remove-btn').click();

    expect(viewer(document).hidden).toBe(true);
    expect(rowNames(document)).toEqual(['p1.jpg']);
  });

  it('Keep closes the viewer and keeps the photo', async () => {
    const { document, urls } = await withPhotos(['p0.jpg', 'p1.jpg']);
    openRow(document, 0);
    expect(viewer(document).hidden).toBe(false);

    document.getElementById('photo-viewer-keep').click();

    expect(viewer(document).hidden).toBe(true);
    expect(viewerImg(document).getAttribute('src')).toBeNull();
    expect(rowNames(document)).toEqual(['p0.jpg', 'p1.jpg']);
    // The viewer never owned a URL: the only two created are the row previews.
    expect(urls.created).toEqual(['blob:view-p0.jpg', 'blob:view-p1.jpg']);
  });

  it('Delete removes the photo, revokes its URL once and slides the next in', async () => {
    const { document, urls } = await withPhotos(['p0.jpg', 'p1.jpg', 'p2.jpg']);
    openRow(document, 0);

    document.getElementById('photo-viewer-delete').click();

    expect(rowNames(document)).toEqual(['p1.jpg', 'p2.jpg']);
    expect(urls.revoked).toEqual(['blob:view-p0.jpg']);
    // Still open, now on the photo that slid into index 0.
    expect(viewer(document).hidden).toBe(false);
    expect(viewerName(document).textContent).toBe('p1.jpg');
    expect(viewerCounter(document).textContent).toBe('1 / 2');
  });

  it('clamps to the previous photo when the last one is deleted, then closes', async () => {
    const { document, urls } = await withPhotos(['p0.jpg', 'p1.jpg']);
    openRow(document, 1);
    expect(viewerCounter(document).textContent).toBe('2 / 2');

    document.getElementById('photo-viewer-delete').click();

    expect(rowNames(document)).toEqual(['p0.jpg']);
    expect(viewer(document).hidden).toBe(false);
    expect(viewerName(document).textContent).toBe('p0.jpg');
    expect(viewerCounter(document).textContent).toBe('1 / 1');

    // Emptying the batch closes the viewer.
    document.getElementById('photo-viewer-delete').click();
    expect(rowNames(document)).toEqual([]);
    expect(viewer(document).hidden).toBe(true);
    expect(urls.revoked).toEqual(['blob:view-p1.jpg', 'blob:view-p0.jpg']);
  });

  it('closes on Escape without touching the photos', async () => {
    const { window, document } = await withPhotos(['p0.jpg', 'p1.jpg']);
    openRow(document, 0);

    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );

    expect(viewer(document).hidden).toBe(true);
    expect(rowNames(document)).toEqual(['p0.jpg', 'p1.jpg']);
  });

  it('removes the photo on the Delete key', async () => {
    const { window, document } = await withPhotos(['p0.jpg', 'p1.jpg']);
    openRow(document, 0);

    document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true })
    );

    expect(rowNames(document)).toEqual(['p1.jpg']);
    expect(viewer(document).hidden).toBe(false);
    expect(viewerName(document).textContent).toBe('p1.jpg');
  });

  it('dismisses on a backdrop click but not on a card click', async () => {
    const { document } = await withPhotos(['p0.jpg', 'p1.jpg']);
    openRow(document, 0);

    // A click inside the card must NOT close.
    document.querySelector('#photo-viewer-modal .photo-viewer-card').click();
    expect(viewer(document).hidden).toBe(false);

    // A click on the overlay itself must close.
    viewer(document).click();
    expect(viewer(document).hidden).toBe(true);
  });

  it('never mints an Object URL of its own across open/close cycles', async () => {
    const { document, urls } = await withPhotos(['p0.jpg', 'p1.jpg']);
    expect(urls.created).toHaveLength(2);

    openRow(document, 0);
    document.getElementById('photo-viewer-keep').click();
    openRow(document, 1);
    document.getElementById('photo-viewer-close').click();

    expect(urls.created).toHaveLength(2);
    expect(urls.revoked).toEqual([]);
  });
});
