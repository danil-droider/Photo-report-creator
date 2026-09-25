/**
 * sw.js — Service Worker
 *
 * Pre-caches the app shell + ExcelJS (CDN) for full offline use, purges
 * old caches on activation, and serves cache-first with network fallback.
 *
 * Cache-first means the app works in Airplane Mode; runtime caching also
 * stores freshly-fetched (readable) responses so a later offline session
 * still works even if a resource wasn't in the initial precache.
 *
 * v29.0 — Web Share Target: the OS delivers photos shared from another app as a
 * POST to the action declared in the manifest. This worker intercepts that POST
 * (the page can never see a request body), queues the files through the shared
 * ShareTarget store and 303-redirects to the app shell, which then picks them up
 * on launch/focus. All share logic lives in share-target.js / app.js; the worker
 * only bridges the two.
 */

'use strict';

// v29.0 — the share queue (IndexedDB writer/reader) is shared verbatim between
// this worker and the page, so the DB name, store name and record shape have
// ONE definition. Classic workers load it synchronously.
importScripts('./share-target.js');

// Bump this key whenever the app version changes to invalidate old caches.
const CACHE_NAME = 'photo2excel-v30.1';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './pica.min.js',
  './compressor.js',
  './layout.js',
  './excel.js',
  './zip-exporter.js', // v9.0 — ZIP export stage.
  './preview.js', // v27.0 — desktop Excel layout preview.
  './share-target.js', // v29.0 — Web Share Target queue (page + worker).
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // v25.0 — iOS native startup images (portrait iPhone set).
  './icons/apple-launch-1320x2868.png',
  './icons/apple-launch-1260x2736.png',
  './icons/apple-launch-1290x2796.png',
  './icons/apple-launch-1206x2622.png',
  './icons/apple-launch-1878x2670.png',
  './icons/apple-launch-1398x2034.png',
  './icons/apple-launch-1179x2556.png',
  './icons/apple-launch-1284x2778.png',
  './icons/apple-launch-1170x2532.png',
  './icons/apple-launch-1080x2340.png',
  './icons/apple-launch-1242x2688.png',
  './icons/apple-launch-1125x2436.png',
  './icons/apple-launch-828x1792.png',
  './icons/apple-launch-750x1334.png'
];

const EXCELJS_CDN =
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';

// v9.0 — the ZIP export stage needs JSZip; precache it the same best-effort
// way as ExcelJS so the archive builder works fully offline (airplane mode).
const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';

/**
 * v29.0 — the manifest's share-target action resolved to a pathname.
 * Derived from this worker's own scope (falling back to its script URL) so a
 * sub-path deployment — e.g. a GitHub Pages project site — matches the action
 * the manifest declares under the same scope, with no hard-coded repo name.
 */
function shareActionPath() {
  try {
    const base =
      (self.registration && self.registration.scope) || self.location.href;
    return new URL('./share-target', base).pathname;
  } catch (err) {
    return '/share-target';
  }
}

function isShareTargetRequest(request) {
  let pathname;
  try {
    pathname = new URL(request.url).pathname;
  } catch (err) {
    return false;
  }
  return pathname === shareActionPath();
}

/**
 * v29.0 — handle an incoming Web Share Target POST.
 *
 * The page can never observe a request body, so the multipart share is consumed
 * here: parse it, keep only images, queue them in the shared IndexedDB store,
 * foreground an already-open app window, then answer with a 303 See Other so
 * the browser navigates to the app shell (opening or focusing the PWA) and a
 * later refresh can never re-submit the original POST.
 */
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const photos = formData.getAll('photos').filter((file) => {
      return (
        file &&
        typeof file === 'object' &&
        typeof file.type === 'string' &&
        file.type.startsWith('image/')
      );
    });
    if (photos.length > 0 && self.ShareTarget) {
      await self.ShareTarget.storeFiles(photos);
    }
  } catch (err) {
    console.warn('[sw] Could not handle the shared content:', err);
  }

  // Bring an already-open app window to the front, so the shared photos land in
  // the visible instance instead of a background copy.
  try {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    const client = windowClients[0];
    if (client && typeof client.focus === 'function') {
      await client.focus();
    }
  } catch (err) {
    console.warn('[sw] Could not focus an app window:', err);
  }

  return Response.redirect('./', 303);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL);

      // Best-effort: pre-cache the ExcelJS bundle (CORS-enabled CDN).
      // Working offline during install should not break the shell precache.
      try {
        await cache.add(EXCELJS_CDN);
      } catch (err) {
        console.warn('[sw] Could not pre-cache ExcelJS CDN:', err);
      }

      // v9.0 — same best-effort pre-cache for the JSZip bundle.
      try {
        await cache.add(JSZIP_CDN);
      } catch (err) {
        console.warn('[sw] Could not pre-cache JSZip CDN:', err);
      }

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // v29.0 — Web Share Target. A POST to the manifest's action URL carries the
  // shared photos. It must be intercepted BEFORE the GET-only guard below.
  if (request.method === 'POST' && isShareTargetRequest(request)) {
    event.respondWith(handleShareTarget(request));
    return;
  }

  if (request.method !== 'GET') return;

  // Only intercept http(s) requests.
  let protocol;
  try {
    protocol = new URL(request.url).protocol;
  } catch (err) {
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') return;

  event.respondWith(
    (async () => {
      // 1. Cache-first.
      const cached = await caches.match(request);
      if (cached) return cached;

      // 2. Network, caching readable (basic/cors) responses for later.
      try {
        const response = await fetch(request);

        if (
          response &&
          response.ok &&
          (response.type === 'basic' || response.type === 'cors')
        ) {
          const clone = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, clone);
        }

        return response;
      } catch (err) {
        // 3. Offline: fall back to the app shell for navigations.
        if (request.mode === 'navigate') {
          const shell =
            (await caches.match('./index.html')) || (await caches.match('./'));
          if (shell) return shell;
        }

        return new Response('Offline', {
          status: 503,
          statusText: 'Offline'
        });
      }
    })()
  );
});
