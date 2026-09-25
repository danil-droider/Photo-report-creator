/**
 * share-target-ingest.test.js — the v29.0 app-side ingestion of Web Share
 * Target photos.
 *
 * Runs the REAL index.html + share-target.js + app.js in jsdom with the canvas
 * compressor stubbed. A fake IndexedDB plays the role of the service worker's
 * queue: the test writes files the way sw.js would, then fires the launch /
 * focus signals app.js listens for and asserts the photos reach the file list,
 * get sorted by the existing pipeline and are purged from the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  waitFor,
  stubCompressor,
  stubDownloads,
  readFileTotal,
} from '../helpers/app-dom.js';
import { installFakeIndexedDb } from '../helpers/fake-idb.js';

/** The rendered file names, in display order. */
function readNames(document) {
  return Array.from(document.querySelectorAll('#file-list .file-name')).map(
    (name) => name.textContent
  );
}

/**
 * A plain image File the way a shared photo arrives. The identical lastModified
 * makes the EXIF-less sort fall through to the natural filename order, so the
 * expected order is deterministic.
 */
function sharedFile(window, name) {
  return new window.File([new window.Uint8Array(2048)], name, {
    type: 'image/jpeg',
    lastModified: 1_700_000_000_000,
  });
}

describe('Web Share Target ingestion (v29.0)', () => {
  let dom;

  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('imports photos queued by the service worker on focus', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window);
    installFakeIndexedDb(window);

    // The worker would have queued these just before the redirect.
    await window.ShareTarget.storeFiles([
      sharedFile(window, 'IMG_4501.jpg'),
      sharedFile(window, 'IMG_4490.jpg'),
    ]);

    // The app was already open when the share arrived.
    window.dispatchEvent(new window.Event('focus'));
    await waitFor(
      () => document.getElementById('file-list').children.length === 2
    );

    // Natural filename order: 4490 before 4501.
    expect(readNames(document)).toEqual(['IMG_4490.jpg', 'IMG_4501.jpg']);
    // The queue is purged, so nothing is re-imported.
    expect(await window.ShareTarget.pendingCount()).toBe(0);
    await waitFor(() => !document.getElementById('generate-btn').disabled);
  });

  it('imports a shared batch on pageshow (a share-triggered launch)', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window);
    installFakeIndexedDb(window);

    await window.ShareTarget.storeFiles([sharedFile(window, 'IMG_1.jpg')]);
    window.dispatchEvent(new window.Event('pageshow'));
    await waitFor(
      () => document.getElementById('file-list').children.length === 1
    );

    expect(readNames(document)).toEqual(['IMG_1.jpg']);
    expect(await window.ShareTarget.pendingCount()).toBe(0);
  });

  it('never imports the same batch twice across repeated focus events', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window);
    installFakeIndexedDb(window);

    await window.ShareTarget.storeFiles([sharedFile(window, 'IMG_9.jpg')]);
    window.dispatchEvent(new window.Event('focus'));
    window.dispatchEvent(new window.Event('focus'));
    window.dispatchEvent(new window.Event('focus'));
    await waitFor(
      () => document.getElementById('file-list').children.length === 1
    );

    // Give any stray second import a chance to fire, then confirm it did not.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.getElementById('file-list').children).toHaveLength(1);
  });

  it('stays in the idle state when nothing was shared', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    installFakeIndexedDb(window);

    window.dispatchEvent(new window.Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.getElementById('file-list').children).toHaveLength(0);
    expect(readFileTotal(document).size).toBe('No photos selected.');
  });
});
