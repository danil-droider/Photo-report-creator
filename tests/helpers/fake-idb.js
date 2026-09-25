/**
 * helpers/fake-idb.js — minimal in-memory IndexedDB stand-in (v29.0).
 *
 * jsdom ships no IndexedDB, so the Web Share Target suites run the REAL
 * share-target.js against this shim instead. It implements exactly the surface
 * share-target.js touches:
 *
 *   indexedDB.open(name, version) -> request { onupgradeneeded, onsuccess }
 *   db.objectStoreNames.contains(name)
 *   db.createObjectStore(name, { keyPath, autoIncrement })
 *   db.transaction(name, mode) -> tx { objectStore, oncomplete }
 *   store.put(record), store.getAll(), store.clear(), store.count()
 *
 * Request callbacks are deferred to a MICROTASK (real IDB never fires them
 * synchronously) while the transaction "commits" on a MACROTASK — so every
 * getAll()/clear() callback has already run by the time oncomplete fires,
 * matching the real commit ordering that share-target.js relies on.
 */

function makeRequest() {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null
  };
}

function microtask(fn) {
  Promise.resolve().then(fn);
}

/**
 * Build a fake `indexedDB` object. Each `open()` shares one database per name,
 * so a store written through one open() is visible to a later open() — enough
 * to model the worker-writes / page-reads split.
 */
export function createFakeIndexedDb() {
  const databases = new Map(); // name -> { version, stores: Map }

  function makeStore(storeDef) {
    return {
      put(value) {
        const request = makeRequest();
        const keyPath = storeDef.options.keyPath;
        const record = Object.assign({}, value);
        let key = record[keyPath];
        if (storeDef.options.autoIncrement && key == null) {
          key = storeDef.nextKey++;
          record[keyPath] = key;
        }
        const at = storeDef.records.findIndex((r) => r && r[keyPath] === key);
        if (at === -1) storeDef.records.push(record);
        else storeDef.records[at] = record;
        request.result = key;
        return request;
      },
      getAll() {
        const request = makeRequest();
        request.result = storeDef.records.map((r) => Object.assign({}, r));
        microtask(() => {
          if (typeof request.onsuccess === 'function') {
            request.onsuccess({ target: request });
          }
        });
        return request;
      },
      clear() {
        const request = makeRequest();
        storeDef.records.length = 0;
        microtask(() => {
          if (typeof request.onsuccess === 'function') {
            request.onsuccess({ target: request });
          }
        });
        return request;
      },
      count() {
        const request = makeRequest();
        request.result = storeDef.records.length;
        microtask(() => {
          if (typeof request.onsuccess === 'function') {
            request.onsuccess({ target: request });
          }
        });
        return request;
      }
    };
  }

  function makeDatabase(def) {
    return {
      objectStoreNames: {
        contains: (name) => def.stores.has(name)
      },
      createObjectStore(name, options) {
        const storeDef = { options: options || {}, records: [], nextKey: 1 };
        def.stores.set(name, storeDef);
        return makeStore(storeDef);
      },
      transaction(name) {
        const storeDef = def.stores.get(name);
        const tx = {
          objectStore: () => makeStore(storeDef),
          oncomplete: null,
          onerror: null,
          onabort: null
        };
        // Commit on the next macrotask: by then every request callback
        // (scheduled as a microtask) has run, so a getAll -> clear transaction
        // hands the caller its records BEFORE oncomplete resolves.
        setTimeout(() => {
          if (typeof tx.oncomplete === 'function') tx.oncomplete({ target: tx });
        }, 0);
        return tx;
      },
      close() {
        /* nothing to release in memory */
      }
    };
  }

  function open(name, version) {
    const request = makeRequest();
    microtask(() => {
      let def = databases.get(name);
      if (!def) {
        def = { version: 0, stores: new Map() };
        databases.set(name, def);
      }
      if (version > def.version) {
        def.version = version;
        request.result = makeDatabase(def);
        if (typeof request.onupgradeneeded === 'function') {
          request.onupgradeneeded({ target: request });
        }
      } else {
        request.result = makeDatabase(def);
      }
      if (typeof request.onsuccess === 'function') {
        request.onsuccess({ target: request });
      }
    });
    return request;
  }

  return { open, _databases: databases };
}

/**
 * Install a fresh fake IndexedDB on a window and return it. Called after the
 * modules have loaded (share-target.js reads indexedDB lazily, at open time).
 */
export function installFakeIndexedDb(window) {
  const fake = createFakeIndexedDb();
  Object.defineProperty(window, 'indexedDB', {
    value: fake,
    configurable: true,
    writable: true
  });
  return fake;
}
