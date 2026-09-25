/**
 * share-target.test.js — the v29.0 Web Share Target queue (share-target.js).
 *
 * Pure-logic tier: the REAL share-target.js is loaded into a sandbox object
 * with a fake IndexedDB (Node and jsdom ship none), so the store/consume
 * lifecycle is exercised without a browser.
 *
 * Covered:
 *   - the DB / store / action constants the worker and the page share
 *   - storeFiles() queues every file; consumePendingFiles() returns them
 *   - consume is ATOMIC + PURGING: everything is deleted, a 2nd call is empty
 *   - toFile() re-attaches a filename when a bare Blob was stored
 *   - graceful degradation when IndexedDB is unavailable (0 queued, [] read)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readSource } from '../helpers/window-shim.js';
import { createFakeIndexedDb } from '../helpers/fake-idb.js';

function loadShareTarget(sandbox) {
  // share-target.js binds its target global as `typeof self !== 'undefined'
  // ? self : this`; passing `self` explicitly pins it to the sandbox in Node
  // (which has no real `self`).
  // eslint-disable-next-line no-new-func
  new Function('window', 'self', readSource('share-target.js'))(
    sandbox,
    sandbox
  );
  return sandbox.ShareTarget;
}

function makeFile(name, type = 'image/jpeg', bytes = 256) {
  return new File([new Blob([new Uint8Array(bytes)], { type })], name, {
    type,
    lastModified: 1_700_000_000_000,
  });
}

describe('Web Share Target queue (v29.0)', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = {
      indexedDB: createFakeIndexedDb(),
      File,
      Blob,
      Uint8Array,
      console,
    };
  });

  it('publishes the constants the worker and the page share', () => {
    const ShareTarget = loadShareTarget(sandbox);
    expect(ShareTarget.DB_NAME).toBe('photo2excel');
    expect(ShareTarget.STORE_NAME).toBe('pending-shares');
    expect(ShareTarget.SHARE_ACTION).toBe('./share-target');
  });

  it('queues files and consumes them exactly once', async () => {
    const ShareTarget = loadShareTarget(sandbox);
    const queued = await ShareTarget.storeFiles([
      makeFile('IMG_1.jpg'),
      makeFile('IMG_2.jpg'),
    ]);
    expect(queued).toBe(2);
    expect(await ShareTarget.pendingCount()).toBe(2);

    const first = await ShareTarget.consumePendingFiles();
    expect(first.map((f) => f.name)).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);
    expect(first.every((f) => f instanceof File)).toBe(true);

    // Purged: the queue is empty and a second consume yields nothing.
    expect(await ShareTarget.pendingCount()).toBe(0);
    expect(await ShareTarget.consumePendingFiles()).toEqual([]);
  });

  it('re-attaches a filename when a bare Blob was stored', async () => {
    const ShareTarget = loadShareTarget(sandbox);
    await ShareTarget.storeFiles([
      new Blob([new Uint8Array(64)], { type: 'image/jpeg' }),
    ]);
    const files = await ShareTarget.consumePendingFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0].name).toBe('shared-photo');
    expect(files[0].type).toBe('image/jpeg');
  });

  it('degrades to a no-op without IndexedDB', async () => {
    const ShareTarget = loadShareTarget({ File, Blob, Uint8Array, console });
    expect(await ShareTarget.storeFiles([makeFile('a.jpg')])).toBe(0);
    expect(await ShareTarget.consumePendingFiles()).toEqual([]);
    expect(await ShareTarget.pendingCount()).toBe(0);
  });
});
