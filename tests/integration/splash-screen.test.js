/**
 * tests/integration/splash-screen.test.js — v25.0 first-paint splash.
 *
 * Covers the three layers this feature adds:
 *   - critical inline markup/CSS that must exist before #app
 *   - the inline fail-safe controller app.js calls after init()
 *   - the generated iOS startup images referenced by index.html
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed,
 * exactly like the other integration suites.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createAppDom, waitFor } from '../helpers/app-dom.js';
import { readSource, ROOT_DIR } from '../helpers/window-shim.js';

const STARTUP_LINK_RE =
  /<link[^>]*rel="apple-touch-startup-image"[^>]*href="\.\/([^"]+)"[^>]*>/g;

/** Collect the ./icons/... hrefs of every apple-touch-startup-image link. */
function startupImageRefs(html) {
  const refs = [];
  let match;
  STARTUP_LINK_RE.lastIndex = 0;
  while ((match = STARTUP_LINK_RE.exec(html)) !== null) refs.push(match[1]);
  return refs;
}

/** Read the real PNG dimensions from the IHDR chunk (bytes 16..23). */
function readPngSize(file) {
  const buffer = readFileSync(file);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe('v25.0 splash screen', () => {
  let dom;

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dom) dom.dom.window.close();
    dom = undefined;
  });

  it('ships a critical inline splash before #app', () => {
    const html = readSource('index.html');
    const splashIndex = html.indexOf('id="splash-screen"');
    const appIndex = html.indexOf('id="app"');

    expect(splashIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(-1);
    expect(splashIndex).toBeLessThan(appIndex);

    // Critical CSS is inline and must pin the overlay above every surface.
    expect(html).toMatch(/z-index:\s*9999/);
    expect(html).toMatch(/background:\s*#f5f5f7/i);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading Photo Report Creator"');

    // iOS standalone metadata stays present alongside the new startup links.
    expect(html).toContain('apple-mobile-web-app-capable" content="yes"');

    // The fail-safe must be independent of the deferred CDN bundles.
    expect(html).toMatch(/FAILSAFE_MS\s*=\s*2500/);
    expect(html).toMatch(/REMOVE_MS\s*=\s*350/);
  });

  it('references generated startup images at their true PNG size', () => {
    const refs = startupImageRefs(readSource('index.html'));
    expect(refs.length).toBeGreaterThanOrEqual(14);

    for (const rel of refs) {
      const file = path.join(ROOT_DIR, rel.split('/').join(path.sep));
      if (!existsSync(file)) throw new Error(`Missing startup image: ${rel}`);

      const named = /apple-launch-(\d+)x(\d+)\.png$/.exec(rel);
      if (!named) throw new Error(`Unexpected startup image name: ${rel}`);

      const { width, height } = readPngSize(file);
      expect({ width, height }).toEqual({
        width: Number(named[1]),
        height: Number(named[2]),
      });
    }
  });

  it('boots the app, fades the splash and removes it without blocking controls', async () => {
    dom = createAppDom();
    const { document } = dom;

    const splash = document.getElementById('splash-screen');
    expect(splash).not.toBeNull();
    expect(splash.classList.contains('splash-screen--hidden')).toBe(true);
    expect(splash.getAttribute('aria-hidden')).toBe('true');

    // The app itself is present and bound while the overlay is still fading out.
    expect(document.getElementById('photo-input')).not.toBeNull();
    expect(document.getElementById('generate-btn')).not.toBeNull();

    const removed = await waitFor(
      () => !document.getElementById('splash-screen'),
      1500
    );
    expect(removed).toBe(true);

    // The exposed controller is idempotent: a late call is a quiet no-op.
    expect(() => dom.window.PhotoReportSplash.dismiss()).not.toThrow();
  });
});
