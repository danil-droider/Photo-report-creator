/**
 * sw-share-target.test.js — the v29.0 service-worker half of Web Share Target.
 *
 * Loads the REAL sw.js into a sandbox `self` (capturing its event listeners)
 * with share-target.js injected through a fake importScripts, then drives the
 * fetch handler directly. Covered:
 *   - a POST to the manifest's action URL is intercepted: the images are queued
 *     through ShareTarget (non-images dropped) and a 303 redirect to './'
 *     launches/foregrounds the app;
 *   - a POST to any OTHER path is left alone (the GET guard ignores it);
 *   - the action path is derived from the worker scope (sub-path safe).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readSource } from '../helpers/window-shim.js';
import { createFakeIndexedDb } from '../helpers/fake-idb.js';

const SCOPE = 'https://example.com/Photo-report-creator/';

function loadServiceWorker(sandbox) {
  const listeners = {};
  sandbox.addEventListener = (type, fn) => {
    listeners[type] = fn;
  };
  sandbox.importScripts = (rel) => {
    // The worker imports the shared queue module synchronously.
    // eslint-disable-next-line no-new-func
    new Function('window', 'self', readSource(rel))(sandbox, sandbox);
  };
  sandbox.registration = { scope: SCOPE };
  sandbox.location = { href: `${SCOPE}sw.js` };
  sandbox.clients = { matchAll: async () => [] };
  sandbox.skipWaiting = async () => {};
  sandbox.indexedDB = createFakeIndexedDb();

  const redirects = [];
  const FakeResponse = {
    redirect: (url, status) => {
      redirects.push({ url, status });
      return { redirected: true, url, status };
    },
  };

  // eslint-disable-next-line no-new-func
  new Function('self', 'importScripts', 'Response', readSource('sw.js'))(
    sandbox,
    sandbox.importScripts,
    FakeResponse
  );

  return { listeners, redirects };
}

function shareRequest(url, formData) {
  return {
    method: 'POST',
    url,
    formData: async () => formData,
  };
}

function formDataWith(entries) {
  return {
    getAll: (name) =>
      Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : [],
  };
}

describe('service-worker share target (v29.0)', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = { File, Blob, Uint8Array, console, URL };
  });

  it('queues images from a share POST and answers with a 303 redirect', async () => {
    const { listeners, redirects } = loadServiceWorker(sandbox);
    const image = new File([new Blob([new Uint8Array(8)], { type: 'image/png' })], 'p.png', {
      type: 'image/png',
    });
    const notAnImage = { type: 'text/plain' };

    let responded;
    const event = {
      request: shareRequest(`${SCOPE}share-target`, formDataWith({
        photos: [image, notAnImage],
      })),
      respondWith: (promise) => {
        responded = promise;
      },
    };

    listeners.fetch(event);
    const response = await responded;

    // Only the image reached the queue.
    const queued = await sandbox.ShareTarget.consumePendingFiles();
    expect(queued.map((f) => f.name)).toEqual(['p.png']);

    // 303 See Other back to the app shell.
    expect(redirects).toEqual([{ url: './', status: 303 }]);
    expect(response.status).toBe(303);
  });

  it('ignores a POST to a path that is not the share target', async () => {
    const { listeners, redirects } = loadServiceWorker(sandbox);
    let called = false;
    const event = {
      request: shareRequest(`${SCOPE}not-a-share`, formDataWith({})),
      respondWith: () => {
        called = true;
      },
    };

    listeners.fetch(event);
    expect(called).toBe(false);
    expect(redirects).toEqual([]);
  });

  it('derives the action from the scope, so a sub-path deploy matches', async () => {
    const { listeners } = loadServiceWorker(sandbox);
    const event = {
      request: shareRequest(`${SCOPE}share-target`, formDataWith({})),
      respondWith: () => {},
    };
    // Should be treated as the share target (respondWith reached) even though
    // the path is namespaced under the GitHub Pages project folder.
    let intercepted = false;
    event.respondWith = () => {
      intercepted = true;
    };
    listeners.fetch(event);
    expect(intercepted).toBe(true);
  });
});
