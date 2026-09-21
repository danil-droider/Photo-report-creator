/**
 * settings-storage.test.js — the v7.5 localStorage layer:
 *   - every user interaction writes a versioned payload
 *   - a restore hydrates the controls WITHOUT writing back
 *   - corrupt / wrong-shape / stale / inverted payloads fall back to defaults
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  readStoredSettings,
  waitFor,
} from '../helpers/app-dom.js';

function boot(storageRaw, beforeLoad) {
  return createAppDom({ storageRaw, beforeLoad });
}

function clickPreset(document, index) {
  document
    .querySelector(`#quality-preset [data-preset-index="${index}"]`)
        .click();
}

  // v17.0 — stepper helpers: click −/+ and read the live value.
  function clickStepperBtn(document, id, cls) {
    document.querySelector(`#${id} .stepper-btn.${cls}`).click();
  }

  function stepperValue(document, id) {
    return document.getElementById(id).dataset.value;
  }

  describe('settings persistence — every user interaction writes', () => {
  let dom;
  beforeEach(() => {
    dom = boot();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('writes a valid payload at startup with markup defaults', () => {
    const stored = readStoredSettings(dom.window);
    expect(stored).not.toBeNull();
    expect(stored.version).toBe(1);
    expect(stored.layout).toMatchObject({ heightCm: 10, columns: 4 });
    expect(stored.compression).toMatchObject({
      minKB: 80, maxKB: 220, presetIndex: 3, // Custom
    });
  });

  it('writes after decreasing the photo height stepper', () => {
    // Default 10 cm → two − taps at 2 cm per click → 6 cm (the minimum stop).
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-minus');
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-minus');
    expect(readStoredSettings(dom.window).layout.heightCm).toBe(6);
  });

  it('writes after increasing the photo height stepper', () => {
    // Default 10 cm → + tap 12 cm.
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-plus');
    expect(readStoredSettings(dom.window).layout.heightCm).toBe(12);
  });

  it('writes after increasing the columns stepper', () => {
    // Default 4 → + tap 5.
    clickStepperBtn(dom.document, 'columns-stepper', 'stepper-plus');
    expect(readStoredSettings(dom.window).layout.columns).toBe(5);
  });

  it('writes after a manual KB edit', () => {
    const min = dom.document.getElementById('min-kb-input');
    min.value = '100';
    min.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(readStoredSettings(dom.window).compression.minKB).toBe(100);
  });

  it('writes after tapping a preset', () => {
    clickPreset(dom.document, 1); // Medium
    expect(readStoredSettings(dom.window).compression).toMatchObject({
      minKB: 70, maxKB: 140, presetIndex: 1,
    });
  });

  it('writes a sanitized pair even when the user inverts min/max', () => {
    const min = dom.document.getElementById('min-kb-input');
    const max = dom.document.getElementById('max-kb-input');
    min.value = '300';
    max.value = '50';
    min.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const s = readStoredSettings(dom.window).compression;
    expect(s.minKB).toBe(50);
    expect(s.maxKB).toBe(300);
  });

  it('writes a clamped pair when the user exceeds the hard bounds', () => {
    const max = dom.document.getElementById('max-kb-input');
    max.value = '99999';
    max.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(readStoredSettings(dom.window).compression.maxKB).toBe(4096);
    });
});

describe('settings restore — hydrates controls WITHOUT writing back', () => {
  it('hydrates layout, compression and preset from a valid payload', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 14, columns: 3 },
      compression: { minKB: 90, maxKB: 300, presetIndex: 2 },
    });
    const dom = boot(raw);
    const { window, document } = dom;

    expect(stepperValue(document, 'height-stepper')).toBe('14');
    expect(stepperValue(document, 'columns-stepper')).toBe('3');
    expect(document.getElementById('min-kb-input').value).toBe('90');
    expect(document.getElementById('max-kb-input').value).toBe('300');
    const active = window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('2');

    // The hydrated payload must NOT have been re-written during init.
    const stored = readStoredSettings(window);
    expect(stored.compression).toMatchObject({
      minKB: 90, maxKB: 300, presetIndex: 2,
    });
    dom.dom.window.close();
  });

  it('does NOT write back when storage was already in sync', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 14, columns: 3 },
      compression: { minKB: 90, maxKB: 300, presetIndex: 2 },
    });
    let writeCount = 0;
    const dom = createAppDom({
      storageRaw: raw,
      beforeLoad(window) {
        const orig = window.localStorage.setItem.bind(window.localStorage);
        window.localStorage.setItem = (...args) => {
          writeCount++;
          return orig(...args);
        };
      },
    });

    // loadSettings runs during init (before settingsLoaded = true).
    // It must not call setItem during hydration.
    expect(writeCount).toBe(0);
    dom.dom.window.close();
  });

  it('restores a preset that matches the table, leaving the KB pair as-is', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 2 },
      compression: { minKB: 20, maxKB: 60, presetIndex: 0 },
    });
    const dom = boot(raw);
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('0'); // Low
    expect(dom.document.getElementById('min-kb-input').value).toBe('20');
    expect(dom.document.getElementById('max-kb-input').value).toBe('60');
    dom.dom.window.close();
  });
});

describe('settings restore — corrupt / wrong-shape / stale payloads', () => {
  function assertDefaults(dom) {
    const d = dom.document;
    expect(stepperValue(d, 'height-stepper')).toBe('10');
    expect(stepperValue(d, 'columns-stepper')).toBe('4');
    expect(d.getElementById('min-kb-input').value).toBe('80');
    expect(d.getElementById('max-kb-input').value).toBe('220');
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
        expect(active.dataset.presetIndex).toBe('3'); // Custom
  }

  it('falls back to defaults when the JSON is corrupt', () => {
    const dom = boot('{ this is not json }}}');
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back to defaults when the payload is an array', () => {
    const dom = boot('[1, 2, 3]');
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back to defaults when the payload is null', () => {
    const dom = boot('null');
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back to defaults when layout is missing', () => {
    const raw = JSON.stringify({
      version: 1,
      compression: { minKB: 90, maxKB: 300, presetIndex: 2 },
    });
    const dom = boot(raw);
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back to defaults when compression is missing', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 15, columns: 3 },
    });
    const dom = boot(raw);
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back when heightCm is not a valid option', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 99, columns: 2 },
      compression: { minKB: 80, maxKB: 220, presetIndex: 3 },
    });
    const dom = boot(raw);
    expect(stepperValue(dom.document, 'height-stepper')).toBe('10');
    dom.dom.window.close();
  });

  it('falls back when columns is not a valid option', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 99 },
      compression: { minKB: 80, maxKB: 220, presetIndex: 3 },
    });
    const dom = boot(raw);
    expect(stepperValue(dom.document, 'columns-stepper')).toBe('4');
    dom.dom.window.close();
  });

  it('falls back when heightCm is off the 2 cm grid (not a valid option)', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 7, columns: 4 },
      compression: { minKB: 80, maxKB: 220, presetIndex: 3 },
    });
    const dom = boot(raw);
    expect(stepperValue(dom.document, 'height-stepper')).toBe('10');
    dom.dom.window.close();
  });

  it('snaps to Custom when the stored preset KB pair does not match the table', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 2 },
      compression: { minKB: 70, maxKB: 140, presetIndex: 2 },
    });
    const dom = boot(raw);
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('3'); // Custom
    expect(dom.document.getElementById('min-kb-input').value).toBe('70');
    expect(dom.document.getElementById('max-kb-input').value).toBe('140');
    dom.dom.window.close();
  });

  it('treats a presetIndex of 99 as Custom', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 2 },
      compression: { minKB: 80, maxKB: 220, presetIndex: 99 },
    });
    const dom = boot(raw);
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('3');
    dom.dom.window.close();
  });

    it('treats a presetIndex of -1 as Custom', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 2 },
      compression: { minKB: 80, maxKB: 220, presetIndex: -1 },
    });
    const dom = boot(raw);
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('3');
    dom.dom.window.close();
  });

  it('handles a payload where compression values are strings', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: '14', columns: '3' },
      compression: { minKB: '90', maxKB: '300', presetIndex: 2 },
    });
    const dom = boot(raw);
    expect(stepperValue(dom.document, 'height-stepper')).toBe('14');
    expect(stepperValue(dom.document, 'columns-stepper')).toBe('3');
    expect(dom.document.getElementById('min-kb-input').value).toBe('90');
    expect(dom.document.getElementById('max-kb-input').value).toBe('300');
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('2');
    dom.dom.window.close();
  });

  it('handles an inverted preset pair by relying on the sanitizer', () => {
    const raw = JSON.stringify({
      version: 1,
      layout: { heightCm: 10, columns: 2 },
      compression: { minKB: 300, maxKB: 90, presetIndex: 3 },
    });
    const dom = boot(raw);
    expect(dom.document.getElementById('min-kb-input').value).toBe('90');
    expect(dom.document.getElementById('max-kb-input').value).toBe('300');
    const active = dom.window.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('3');
    dom.dom.window.close();
  });

  it('falls back to defaults when localStorage throws on read', () => {
    const dom = createAppDom({
      beforeLoad(window) {
        Object.defineProperty(window.localStorage, 'getItem', {
          configurable: true,
          value: () => { throw new Error('Blocked: private mode'); },
        });
      },
    });
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('falls back to defaults when localStorage is absent', () => {
    const dom = createAppDom({
      beforeLoad(window) {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          value: null,
        });
      },
    });
    assertDefaults(dom);
    dom.dom.window.close();
  });

  it('handles a missing version field', () => {
    const raw = JSON.stringify({
      layout: { heightCm: 14, columns: 3 },
      compression: { minKB: 90, maxKB: 300, presetIndex: 2 },
    });
    const dom = boot(raw);
    expect(stepperValue(dom.document, 'height-stepper')).toBe('14');
    expect(dom.document.getElementById('min-kb-input').value).toBe('90');
    dom.dom.window.close();
  });
});

describe('settings restore — live re-hydration', () => {
  it('a second boot with the written payload reproduces the same controls', async () => {
    let dom = boot();
    const { document } = dom;
    clickPreset(document, 1); // Medium (70/140)
    await waitFor(() => {
      const s = readStoredSettings(dom.window);
      return s !== null && s.compression.minKB === 70;
    });
    const stored = readStoredSettings(dom.window);
    const raw = JSON.stringify(stored);
    dom.dom.window.close();

    // Second boot: the stored payload must restore Medium exactly.
    dom = boot(raw);
    const { document: d2, window: w2 } = dom;
    expect(d2.getElementById('min-kb-input').value).toBe('70');
    expect(d2.getElementById('max-kb-input').value).toBe('140');
    const active = w2.document.querySelector(
      '#quality-preset .segmented-btn.is-active'
    );
    expect(active.dataset.presetIndex).toBe('1');
    dom.dom.window.close();
  });
});

// --- v17.0 stepper behaviour ----------------------------------------------
// The steppers replace the layout dropdowns: [−] value [+] in one container.
// Bounds, disables, display repaint, runLayout() trigger and rehydration.
describe('stepper controls — bounds, paint and layout trigger', () => {
  let dom;
  beforeEach(() => {
    dom = boot();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  function minusDisabled(id) {
    return dom.document.querySelector(`#${id} .stepper-minus`).disabled;
  }
  function plusDisabled(id) {
    return dom.document.querySelector(`#${id} .stepper-plus`).disabled;
  }
  function display(id) {
    return dom.document.querySelector(`#${id} .stepper-value`).textContent;
  }

  it('disables minus at the minimum height stop (6 cm) and plus at the maximum (24 cm)', () => {
    const id = 'height-stepper';
    // Default 10 cm: neither boundary.
    expect(minusDisabled(id)).toBe(false);
    expect(plusDisabled(id)).toBe(false);

    // v18.0 — 2 cm per click: 10 → 12 → 14 → 16 → 18 → 20 → 22 → 24.
    for (let i = 0; i < 7; i++) {
      clickStepperBtn(dom.document, id, 'stepper-plus');
      expect(stepperValue(dom.document, id)).toBe(String(12 + 2 * i));
    }
    expect(stepperValue(dom.document, id)).toBe('24');
    expect(plusDisabled(id)).toBe(true);
    expect(minusDisabled(id)).toBe(false);

    // Back down the same 2 cm ladder to the 6 cm floor.
    for (let i = 22; i >= 6; i -= 2) {
      clickStepperBtn(dom.document, id, 'stepper-minus');
      expect(stepperValue(dom.document, id)).toBe(String(i));
    }
    expect(stepperValue(dom.document, id)).toBe('6');
    expect(minusDisabled(id)).toBe(true);
    expect(plusDisabled(id)).toBe(false);
  });

  it('disables minus at 1 column and plus at 15 columns', () => {
    const id = 'columns-stepper';
    // Default 4 → three − taps reach the 1 floor.
    for (let i = 3; i >= 1; i--) {
      clickStepperBtn(dom.document, id, 'stepper-minus');
      expect(stepperValue(dom.document, id)).toBe(String(i));
    }
    expect(stepperValue(dom.document, id)).toBe('1');
    expect(minusDisabled(id)).toBe(true);
    expect(plusDisabled(id)).toBe(false);

    // v18.0 — climb 1 → 15 (step 1); the plus button only disables at 15.
    for (let i = 2; i <= 15; i++) {
      clickStepperBtn(dom.document, id, 'stepper-plus');
      expect(stepperValue(dom.document, id)).toBe(String(i));
    }
    expect(stepperValue(dom.document, id)).toBe('15');
    expect(plusDisabled(id)).toBe(true);
    expect(minusDisabled(id)).toBe(false);
  });

  it('repaints the display with the suffix and stays in sync with data-value', () => {
    expect(display('height-stepper')).toBe('10 cm');
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-plus');
    expect(display('height-stepper')).toBe('12 cm');
    expect(stepperValue(dom.document, 'height-stepper')).toBe('12');

    expect(display('columns-stepper')).toBe('4');
    clickStepperBtn(dom.document, 'columns-stepper', 'stepper-plus');
    expect(display('columns-stepper')).toBe('5');
  });

  it('clicking a disabled boundary button changes nothing and rewrites no storage', () => {
    // Default 10 cm → 6 cm via two − taps; the third tap hits a disabled button.
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-minus');
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-minus');
    expect(stepperValue(dom.document, 'height-stepper')).toBe('6');

    const before = readStoredSettings(dom.window);
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-minus'); // disabled
    expect(stepperValue(dom.document, 'height-stepper')).toBe('6');
    expect(readStoredSettings(dom.window)).toEqual(before);
  });

  it('every committed click funnels into runLayout()', () => {
    // With no photos selected runLayout() takes the early-exit branch, whose
    // console line is its only observable here.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    clickStepperBtn(dom.document, 'height-stepper', 'stepper-plus');
    expect(logSpy).toHaveBeenCalledWith(
      '[app] No processed photos — layout skipped.'
    );
  });

  it('rehydrates the stepper values on a second boot', () => {
    // Exercise the new v18.0 extremes: 24 cm (7 × +2 from 10) and 15 columns
    // (11 × +1 from 4) — both must survive the storage round-trip.
    for (let i = 0; i < 7; i++) {
      clickStepperBtn(dom.document, 'height-stepper', 'stepper-plus'); // → 24
    }
    for (let i = 0; i < 11; i++) {
      clickStepperBtn(dom.document, 'columns-stepper', 'stepper-plus'); // → 15
    }
    const stored = readStoredSettings(dom.window);
    const raw = JSON.stringify(stored);
    dom.dom.window.close();

    const dom2 = boot(raw);
    expect(stepperValue(dom2.document, 'height-stepper')).toBe('24');
    expect(stepperValue(dom2.document, 'columns-stepper')).toBe('15');
    expect(
      dom2.document.querySelector('#height-stepper .stepper-value').textContent
    ).toBe('24 cm');
    dom2.dom.window.close();
  });
});


