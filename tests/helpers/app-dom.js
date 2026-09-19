/**
 * helpers/app-dom.js — jsdom bootstrap that runs the REAL index.html markup
 * with the REAL compressor.js / layout.js / excel.js / app.js, and stubs only
 * what jsdom cannot do (canvas, ExcelJS CDN, URL.createObjectURL).
 *
 * A fresh JSDOM is created per call, so every test gets pristine module state
 * (app.js is a closed IIFE with no exports — this is the only way to reach it)
 * and no cross-test reset is needed: state.files / state.processedPhotos /
 * state.layout die together with their window.
 *
 * Deliberate DOM shims, and why they are safe:
 *   - document.readyState is forced to 'complete' (see beforeParse) so app.js
 *     boots synchronously instead of on a later DOMContentLoaded macrotask.
 *     Only app.js's boot check reads that property.
 *   - canvas toBlob / toDataURL are stubbed because jsdom drops toBlob's
 *     callback when the optional `canvas` package is absent — a Promise that
 *     stays pending forever and hangs the runner. They only ever fire when
 *     Compressor.compressToTarget is left unmocked.
 *   - URL.createObjectURL and <img> decoding are NOT stubbed: an un-mocked
 *     compression must fail loudly (jsdom implements no createObjectURL)
 *     instead of silently resolving through a fabricated decode path.
 */
import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import { readSource, loadWindiModule } from './window-shim.js';

export const SETTINGS_KEY = 'photo2excel.settings';

// The CDN tag is stripped: tests must never touch the network.
const CDN_TAG_RE = /<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*/;

/**
 * Create a fresh app DOM.
 * @param {object} [opts]
 * @param {string}   [opts.storageRaw]  Raw JSON string seeded into
 *        localStorage('photo2excel.settings') BEFORE app.js boots.
 * @param {boolean}  [opts.onLine]      Initial navigator.onLine value
 *        (patched in beforeParse so app.js sees it at boot).
 * @param {function} [opts.beforeLoad]  Hook (window) => void that runs after the
 *        DOM is built (and storage seeded) but before the modules load — use
 *        it to install console spies or delete globals.
 */
export function createAppDom({ storageRaw, onLine, beforeLoad } = {}) {
  const html = readSource('index.html').replace(
    CDN_TAG_RE,
    '<!-- ExcelJS is stubbed in tests -->\n'
  );

  const dom = new JSDOM(html, {
    url: 'https://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // jsdom has no matchMedia; the inline <head> script in index.html needs
      // it for the standalone-PWA detection (always non-matching in tests).
      window.matchMedia = (query) => ({
        matches: false,
        media: String(query),
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return false;
        },
      });
      // Patch navigator.onLine in beforeParse so it is in place before any
      // script (including the inline head script and deferred app.js) runs.
      if (typeof onLine === 'boolean') {
        Object.defineProperty(window.navigator, 'onLine', {
          configurable: true,
          get: () => onLine,
        });
      }
      // jsdom finishes parsing with document.readyState === 'loading' and only
      // dispatches DOMContentLoaded on a LATER macrotask, so app.js used to take
      // its deferred branch and run init() -> loadSettings() -> hydration after
      // createAppDom() had already returned. Every synchronous assertion then
      // read the un-hydrated markup. Reporting 'complete' lets the REAL boot
      // path run synchronously inside this helper.
      Object.defineProperty(window.document, 'readyState', {
        configurable: true,
        get: () => 'complete',
      });
      // jsdom's toBlob never invokes its callback without the optional `canvas`
      // package (HTMLCanvasElement-impl.js → notImplementedMethod), which would
      // leave compressor.js encode()'s Promise pending forever. This safety net
      // only fires when a test stops mocking Compressor.compressToTarget.
      window.HTMLCanvasElement.prototype.toBlob = function toBlob(
        callback,
        type
      ) {
        callback(
          new window.Blob([new window.Uint8Array(50000)], {
            type: type || 'image/jpeg',
          })
        );
      };
      window.HTMLCanvasElement.prototype.toDataURL = () =>
        'data:image/jpeg;base64,';
    },
  });
  const { window } = dom;

  if (storageRaw !== undefined) {
    window.localStorage.setItem(SETTINGS_KEY, storageRaw);
  }
  if (typeof beforeLoad === 'function') beforeLoad(window);

  // Evaluate INSIDE the jsdom realm (window.eval) so the modules' bare
  // `document`/`navigator`/`localStorage` references bind to THIS window —
  // not to the vitest jsdom test environment's global document.
  for (const rel of [
    'compressor.js',
    'layout.js',
    'excel.js',
    'app.js',
  ]) {
    window.eval(readSource(rel));
  }

  return { dom, window, document: window.document };
}

/**
 * Simulate a file selection (DataTransfer is not implemented in jsdom).
 * @param {Window} window
 * @param {{name:string,type:string,size?:number}[]} files plain descriptors
 */
export function selectFiles(window, files) {
  const document = window.document;
  const input = document.getElementById('photo-input');
  const mapped = files.map(
    (f) =>
      new window.File([new window.ArrayBuffer(f.size || 1024)], f.name, {
        type: f.type || 'image/jpeg',
      })
  );
  Object.defineProperty(input, 'files', { value: mapped, configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  return mapped;
}

/** Poll a condition with real timers until it holds or the timeout elapses. */
export async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** Count visible occurrences of the idle sentence across the status surfaces. */
export function countIdleText(document) {
  const joined = ['file-summary', 'status', 'file-list']
    .map((id) => document.getElementById(id))
    .map((el) => (el ? el.textContent : ''))
    .join('\n');
  return joined.split('No photos selected.').length - 1;
}

/** Index of the active preset stop (Custom === 3 by default). */
export function activePresetIndex(window) {
  const active = window.document.querySelector(
    '#quality-preset .segmented-btn.is-active'
  );
  return active ? Number(active.dataset.presetIndex) : -1;
}

export function presetButtons(window) {
  return Array.from(
    window.document.querySelectorAll('#quality-preset [data-preset-index]')
  );
}

export function readStoredSettings(window) {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Default fake compressor result (dimensions match the 800px pipeline). */
export function fakePhoto(window, overrides = {}) {
  return {
    blob: new window.Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    width: 800,
    height: 600,
    bytes: 120 * 1024,
    quality: 0.8,
    targetBytes: 130 * 1024,
    encoding: 'target',
    engine: 'stub',
    ...overrides,
  };
}

/**
 * Replace Compressor.compressToTarget with a stub that resolves immediately.
 * Shared by the file-list / status / preset suites; tests that need a gated or
 * rejecting compressor build their own spy instead.
 * @returns {import('vitest').Mock} the spy (call `vi.restoreAllMocks()` after)
 */
export function stubCompressor(window, overrides = {}) {
  return vi
    .spyOn(window.Compressor, 'compressToTarget')
    .mockImplementation(() => Promise.resolve(fakePhoto(window, overrides)));
}
