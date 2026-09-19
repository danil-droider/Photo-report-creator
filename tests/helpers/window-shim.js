/**
 * helpers/window-shim.js — loads the production IIFE modules (which attach
 * themselves to `window` and have no ESM exports) into a window object so the
 * pure-logic tests can exercise them in a plain Node environment.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(HERE, '..', '..');

/** Read a production file from the repo root. */
export function readSource(relPath) {
  return readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
}

/**
 * Execute a production IIFE module (layout.js / compressor.js / excel.js /
 * app.js) against a window object. The modules only *touch* DOM/canvas APIs
 * at call time, so they load cleanly in Node as long as `window` is defined.
 */
export function loadWindiModule(windowObj, relPath) {
  // eslint-disable-next-line no-new-func
  new Function('window', readSource(relPath))(windowObj);
}

/** Deterministic PRNG (mulberry32) for property-style tests. */
export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
