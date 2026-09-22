/**
 * sw.js — Service Worker
 *
 * Pre-caches the app shell + ExcelJS (CDN) for full offline use, purges
 * old caches on activation, and serves cache-first with network fallback.
 *
 * Cache-first means the app works in Airplane Mode; runtime caching also
 * stores freshly-fetched (readable) responses so a later offline session
 * still works even if a resource wasn't in the initial precache.
 */

'use strict';

// Bump this key whenever the app version changes to invalidate old caches.
const CACHE_NAME = 'photo2excel-v26.0';

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
