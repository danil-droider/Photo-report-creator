/**
 * share-target.js — Web Share Target ingestion store (v29.0)
 *
 * Shared between the page and the service worker: the IIFE attaches to `self`,
 * which is `window` in the page and the worker global scope inside sw.js.
 *   - sw.js loads it synchronously with importScripts('./share-target.js');
 *   - index.html loads it with a <script> tag BEFORE app.js.
 * One implementation, one schema — the writer (worker) and the reader (page)
 * can never drift apart.
 *
 * Owns exactly ONE thing: the IndexedDB queue that carries photos shared from
 * the OS share sheet into the app. The service worker receives the OS POST,
 * parses the multipart body and calls storeFiles(); the page calls
 * consumePendingFiles() on launch/focus and forwards the result into the
 * existing preprocessing -> layout -> Excel pipeline. NO canvas work, NO layout
 * math, NO Excel work here.
 *
 * Records live in the 'pending-shares' store as
 *   { id (autoIncrement), name, type, blob, createdAt }.
 * consumePendingFiles() reads AND deletes every record in ONE transaction, so a
 * batch can never be ingested twice and the temporary copies are purged the
 * moment the app takes them.
 */
(function (global) {
  'use strict';

  const VERSION = 'v29.0';

  const DB_NAME = 'photo2excel';
  const DB_VERSION = 1;
  const STORE_NAME = 'pending-shares';

  // The route the manifest registers as the share target. Relative to the app
  // scope so it survives sub-path deployments (e.g. GitHub Pages project sites).
  const SHARE_ACTION = './share-target';

  function hasIndexedDb() {
    return typeof global.indexedDB !== 'undefined' && global.indexedDB !== null;
  }

  function makeRequest() {
    return {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };
  }

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Open (and, on first use, create) the share queue database.
   * Resolves to null when IndexedDB is unavailable (jsdom, Node, locked-down
   * private modes) so every caller degrades to "no shared photos" instead of
   * throwing.
   */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!hasIndexedDb()) {
        resolve(null);
        return;
      }
      let request;
      try {
        request = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // autoIncrement key. createdAt is kept for future eviction of
          // abandoned shares — nothing reads it yet.
          db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: true
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
  }

  /**
   * Run `work(store)` inside one transaction and resolve once the transaction
   * COMMITS, so any delete is durable before the promise settles.
   * `work` may schedule request callbacks that fill a value it returns; the
   * commit always fires after those callbacks, so the caller sees it complete.
   */
  function withStore(db, mode, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(STORE_NAME, mode);
      } catch (err) {
        reject(err);
        return;
      }
      let result;
      try {
        result = work(tx.objectStore(STORE_NAME));
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  /**
   * Reconstruct an uploadable File from a stored record.
   * Some engines hand a plain Blob back out of IndexedDB even when a File went
   * in, so the filename/type are re-attached here. The File constructor is
   * guarded: without it (or if it rejects the parts) the Blob is returned
   * as-is — still ingestable, only the displayed name would be missing.
   */
  function toFile(record) {
    if (!record || !record.blob) return null;
    const blob = record.blob;
    const FileCtor = global.File;
    if (typeof FileCtor === 'function' && !(blob instanceof FileCtor)) {
      try {
        return new FileCtor([blob], record.name || 'shared-photo', {
          type: record.type || blob.type || 'image/jpeg',
          lastModified: record.createdAt || Date.now()
        });
      } catch (err) {
        return blob;
      }
    }
    return blob;
  }

  /**
   * Queue shared photos for the page to pick up. Best-effort: never throws,
   * returns how many files were queued (0 when IndexedDB is unavailable).
   */
  async function storeFiles(files) {
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (list.length === 0) return 0;
    let db = null;
    try {
      db = await openDb();
      if (!db) return 0;
      await withStore(db, 'readwrite', (store) => {
        list.forEach((file) => {
          store.put({
            name: file.name || 'shared-photo',
            type: file.type || '',
            blob: file,
            createdAt: Date.now()
          });
        });
      });
      return list.length;
    } catch (err) {
      console.warn('[share-target] Could not queue shared photos:', err);
      return 0;
    } finally {
      if (db && typeof db.close === 'function') db.close();
    }
  }

  /**
   * Read AND delete every queued share in ONE transaction, returning the photos
   * as Files in insertion order. Atomic: a concurrent call (boot and a focus
   * event racing, say) can never see the same record twice, and nothing is left
   * behind for the next call to re-ingest.
   */
  async function consumePendingFiles() {
    let db = null;
    try {
      db = await openDb();
      if (!db) return [];
      const records = await withStore(db, 'readwrite', (store) => {
        const all = [];
        const request = store.getAll();
        request.onsuccess = () => {
          const result = request.result || [];
          for (let i = 0; i < result.length; i++) all.push(result[i]);
          // Purge in the SAME transaction: the delete commits together with
          // the read, so the batch cannot survive to be ingested twice.
          if (result.length > 0) store.clear();
        };
        // Filled by the callback above; the transaction commits after it runs.
        return all;
      });
      return records.map(toFile).filter(Boolean);
    } catch (err) {
      console.warn('[share-target] Could not read shared photos:', err);
      return [];
    } finally {
      if (db && typeof db.close === 'function') db.close();
    }
  }

  /** How many shares are waiting (no deletion). For UI signalling only. */
  async function pendingCount() {
    let db = null;
    try {
      db = await openDb();
      if (!db) return 0;
      const tx = db.transaction(STORE_NAME, 'readonly');
      return await requestAsPromise(tx.objectStore(STORE_NAME).count());
    } catch (err) {
      return 0;
    } finally {
      if (db && typeof db.close === 'function') db.close();
    }
  }

  global.ShareTarget = {
    VERSION: VERSION,
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    SHARE_ACTION: SHARE_ACTION,
    toFile: toFile,
    storeFiles: storeFiles,
    consumePendingFiles: consumePendingFiles,
    pendingCount: pendingCount
  };
})(typeof self !== 'undefined' ? self : this);

