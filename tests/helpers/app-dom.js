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
// v8.1 — the save dialog auto-clear preference is stored under its own key.
export const AUTOCLEAR_KEY = 'photo2excel.autoclear';

// The CDN tag is stripped: tests must never touch the network.
const CDN_TAG_RE = /<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*/;

/**
 * Create a fresh app DOM.
 * @param {object} [opts]
 * @param {string}   [opts.storageRaw]  Raw JSON string seeded into
 *        localStorage('photo2excel.settings') BEFORE app.js boots.
 * @param {object}   [opts.seedStorage] Extra localStorage entries (key =>
 *        value) written before the modules load, so a reload test can start
 *        from exactly what a previous window persisted.
 * @param {boolean}  [opts.onLine]      Initial navigator.onLine value
 *        (patched in beforeParse so app.js sees it at boot).
 * @param {function} [opts.beforeLoad]  Hook (window) => void that runs after the
 *        DOM is built (and storage seeded) but before the modules load — use
 *        it to install console spies or delete globals.
 */
export function createAppDom({ storageRaw, onLine, beforeLoad, seedStorage } = {}) {
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
  // v8.1 — extra seeds (e.g. the auto-clear preference) so a reload test can
  // start from exactly what a previous window persisted.
  if (seedStorage && typeof seedStorage === 'object') {
    for (const key of Object.keys(seedStorage)) {
      window.localStorage.setItem(key, String(seedStorage[key]));
    }
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
 * @param {{name:string,type:string,size?:number,bytes?:Uint8Array,
 *          lastModified?:number}[]} files plain descriptors
 */
export function selectFiles(window, files) {
  const document = window.document;
  const input = document.getElementById('photo-input');
  const mapped = files.map((f) => {
    // v8.2 — `bytes` lets a test carry a real EXIF header (see exif-fixtures);
    // the default stays an all-zero buffer of `size` bytes.
    const body = f.bytes || new window.Uint8Array(f.size || 1024);
    const options = { type: f.type || 'image/jpeg' };
    if (typeof f.lastModified === 'number') options.lastModified = f.lastModified;
    return new window.File([body], f.name, options);
  });
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

/** v8.1 — the persisted auto-clear preference (raw string, or null). */
export function readStoredAutoclear(window) {
  return window.localStorage.getItem(AUTOCLEAR_KEY);
}

/**
 * v7.7 — Read the "Total Size:" footer in one shot.
 * @returns {{row: Element|null, hidden: boolean|null, label: string, size: string}}
 */
export function readFileTotal(document) {
  const row = document.getElementById('file-total');
  const size = document.getElementById('file-total-size');
  const label = row ? row.querySelector('.file-total-name') : null;
  return {
    row,
    hidden: row ? row.hidden : null,
    label: label ? label.textContent : '',
    size: size ? size.textContent : '',
  };
}

/**
 * v8.0 — Read the save dialog in one shot.
 * @returns {{overlay: Element|null, hidden: boolean|null, files: string,
 *   size: string, sizeHidden: boolean|null, filename: string|null,
 *   title: Element|null, hint: Element|null, suffix: string,
 *   autoclear: boolean|null, confirm: Element|null, confirmLabel: string,
 *   cancel: Element|null}}
 */
export function readSaveModal(document) {
  const overlay = document.getElementById('save-modal');
  const files = document.getElementById('save-summary-files');
  const size = document.getElementById('save-summary-size');
  const filename = document.getElementById('save-filename');
  const suffix = document.getElementById('save-filename-suffix');
  const autoclear = document.getElementById('save-autoclear');
  const confirm = document.getElementById('save-confirm-btn');
  return {
    overlay,
    hidden: overlay ? overlay.hidden : null,
    // v8.1 — the visible heading and hint were removed; the refs come back so a
    // test can assert their absence.
    title: document.getElementById('save-modal-title'),
    hint: document.querySelector('#save-modal .modal-hint'),
    files: files ? files.textContent : '',
    size: size ? size.textContent : '',
    sizeHidden: size ? size.hidden : null,
    filename: filename ? filename.value : null,
    suffix: suffix ? suffix.textContent : '',
    autoclear: autoclear ? autoclear.checked : null,
    confirm,
    confirmLabel: confirm ? confirm.textContent.trim() : '',
    cancel: document.getElementById('save-cancel-btn'),
  };
}

/**
 * v8.0 — Neutralize the real download path and capture what would have been
 * saved. jsdom implements no navigation, so an un-stubbed <a download> click
 * would surface as "Not implemented" noise.
 * @returns {string[]} the captured `download` names, in order.
 */
export function stubDownloads(window) {
  const downloads = [];
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function captureDownload() {
    downloads.push(this.download);
  };
  return downloads;
}

/**
 * v8.0 — Drive the save dialog the way a user would: optionally retype the
 * name (through the real `input` event so live sanitization runs), optionally
 * tick auto-clear, then confirm.
 */
export function confirmSave(window, { filename, autoClear } = {}) {
  const document = window.document;
  if (typeof filename === 'string') {
    const input = document.getElementById('save-filename');
    input.value = filename;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  if (typeof autoClear === 'boolean') {
    const box = document.getElementById('save-autoclear');
    box.checked = autoClear;
    // A real toggle emits `change` (the app persists on it), so the helper has
    // to emit it too or persistence could never be exercised.
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  document.getElementById('save-confirm-btn').click();
}

/** Today's default base name, formatted independently of app.js's own helper. */
export function todayDefaultName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `Photo report ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.` +
    `${date.getFullYear()}`
  );
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
