/**
 * preset-sync.test.js — the v7.4 Quality preset segmented control:
 * preset -> inputs (one way), manual edit -> Custom (the other way), keyboard
 * navigation, single-selection invariants and the fallback preset table.
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  presetButtons,
  activePresetIndex,
  fakePhoto,
  readStoredSettings,
} from '../helpers/app-dom.js';

const IMG = { name: 'a.jpg', type: 'image/jpeg' };

function boot() {
  const dom = createAppDom();
  const { window, document } = dom;
  const label = document.getElementById('quality-preset-label');
  const min = document.getElementById('min-kb-input');
  const max = document.getElementById('max-kb-input');
  return { dom, window, document, label, min, max };
}

function clickPreset(document, index) {
  document
    .querySelector(`#quality-preset [data-preset-index="${index}"]`)
    .click();
}

describe('preset -> inputs (one-way)', () => {
  let ctx;
  beforeEach(() => {
    ctx = boot();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    ctx.dom.dom.window.close();
  });

  it('boots on Custom with the markup defaults untouched', () => {
    const { label, min, max, document, window } = ctx;
    expect(label.textContent).toBe('Custom');
    expect(min.value).toBe('80');
    expect(max.value).toBe('220');
    expect(activePresetIndex(window)).toBe(3);
    expect(document.querySelectorAll('.segmented-btn.is-active')).toHaveLength(
      1
    );
  });

  it('fills both KB fields when Medium is tapped', async () => {
    const { window, document, label, min, max } = ctx;
    clickPreset(document, 1);

    expect(min.value).toBe('70');
    expect(max.value).toBe('140');
    expect(label.textContent).toBe('Medium');
    expect(activePresetIndex(window)).toBe(1);
    await waitFor(() => readStoredSettings(window) !== null);
    expect(readStoredSettings(window).compression).toMatchObject({
      minKB: 70,
      maxKB: 140,
      presetIndex: 1,
    });
  });

  it('moves between stops and persists each one', async () => {
    const { window, document } = ctx;
    clickPreset(document, 0); // Low
    expect(activePresetIndex(window)).toBe(0);
    await waitFor(
      () => readStoredSettings(window)?.compression.presetIndex === 0
    );

    clickPreset(document, 2); // High
    expect(document.getElementById('min-kb-input').value).toBe('140');
    expect(document.getElementById('max-kb-input').value).toBe('400');
    await waitFor(
      () => readStoredSettings(window)?.compression.presetIndex === 2
    );
  });
});

describe('inputs -> preset (snap to Custom)', () => {
  let ctx;
  beforeEach(() => {
    ctx = boot();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    ctx.dom.dom.window.close();
  });

  it('a manual `input` edit snaps to Custom without overwriting the values', () => {
    const { window, document, label, min } = ctx;
    clickPreset(document, 2); // High -> 140/400
    min.value = '90';
    min.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(label.textContent).toBe('Custom');
    expect(activePresetIndex(window)).toBe(3);
    expect(min.value).toBe('90'); // user value preserved
    expect(document.getElementById('max-kb-input').value).toBe('400');
  });

  it('a change-only edit (spinner commit / autofill) snaps to Custom too', () => {
    const { window, document, label, max } = ctx;
    clickPreset(document, 1); // Medium -> 70/140
    max.value = '200';
    max.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(label.textContent).toBe('Custom');
    expect(activePresetIndex(window)).toBe(3);
  });

  it('a preset tap is never mistaken for a manual edit', async () => {
    const { window, document, label } = ctx;
    clickPreset(document, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(label.textContent).toBe('High');
    expect(activePresetIndex(window)).toBe(2);
  });

  it('re-tapping the active preset is a UI no-op that still persists', async () => {
    const { window, document, label, min, max } = ctx;
    clickPreset(document, 2); // High
    const before = `${min.value}/${max.value}`;
    const labelBefore = label.textContent;

    clickPreset(document, 2); // again
    expect(label.textContent).toBe(labelBefore);
    expect(`${min.value}/${max.value}`).toBe(before);
    await waitFor(() => readStoredSettings(window) !== null);
    expect(readStoredSettings(window).compression.presetIndex).toBe(2);
  });

  it('tapping Custom keeps the user values and announces Custom', () => {
    const { window, document, label, min, max } = ctx;
    min.value = '33';
    max.value = '77';
    clickPreset(document, 3);

    expect(label.textContent).toBe('Custom');
    expect(activePresetIndex(window)).toBe(3);
    expect(min.value).toBe('33');
    expect(max.value).toBe('77');
  });
});

describe('keyboard navigation (radiogroup convention)', () => {
  let ctx;
  beforeEach(() => {
    ctx = boot();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    ctx.dom.dom.window.close();
  });

  function press(document, index, key) {
    const button = document.querySelector(
      `#quality-preset [data-preset-index="${index}"]`
    );
    button.focus();
    const event = new document.defaultView.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
    });
    button.dispatchEvent(event);
    return event;
  }

    it('ArrowRight / ArrowDown move forward and wrap around', () => {
    const { window, document } = ctx;
    clickPreset(document, 0); // make Low active so focus & selection are in sync
    let event = press(document, 0, 'ArrowRight');
    expect(event.defaultPrevented).toBe(true);
    expect(activePresetIndex(window)).toBe(1);

    press(document, 1, 'ArrowDown');
    expect(activePresetIndex(window)).toBe(2);

    press(document, 2, 'ArrowRight'); // High -> wraps to Custom
    expect(activePresetIndex(window)).toBe(3);

    press(document, 3, 'ArrowRight'); // Custom -> wraps to Low
    expect(activePresetIndex(window)).toBe(0);
  });

  it('ArrowLeft / ArrowUp move backward and wrap around', () => {
    const { window, document } = ctx;
    clickPreset(document, 0); // make Low active so focus & selection are in sync
    press(document, 0, 'ArrowLeft'); // Low -> wraps back to Custom
    expect(activePresetIndex(window)).toBe(3);

    press(document, 3, 'ArrowUp'); // Custom -> High
    expect(activePresetIndex(window)).toBe(2);
  });

  it('ignores non-arrow keys and moves focus to the new stop', () => {
    const { window, document } = ctx;
    clickPreset(document, 0); // make Low active
    const event = press(document, 0, 'a');
    expect(event.defaultPrevented).toBe(false);
    expect(activePresetIndex(window)).toBe(0); // unchanged

    press(document, 0, 'ArrowRight');
    expect(document.activeElement.dataset.presetIndex).toBe('1');
  });
});

describe('single-selection invariants and resilience', () => {
  let ctx;
  beforeEach(() => {
    ctx = boot();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    ctx.dom.dom.window.close();
  });

  it('keeps exactly one active, aria-checked stop across all four states', () => {
    const { window, document } = ctx;
    const labels = ['Low', 'Medium', 'High', 'Custom'];
    for (const index of [0, 1, 2, 3, 1]) {
      clickPreset(document, index);
      expect(document.querySelectorAll('.segmented-btn.is-active')).toHaveLength(1);
      expect(
        document.querySelectorAll('#quality-preset [aria-checked="true"]')
      ).toHaveLength(1);
      expect(activePresetIndex(window)).toBe(index);
      expect(
        document.getElementById('quality-preset-label').textContent
      ).toBe(labels[index]);
    }
  });

  it('never disables or locks the KB inputs while a preset is active', () => {
    const { document } = ctx;
    clickPreset(document, 1);
    const min = document.getElementById('min-kb-input');
    const max = document.getElementById('max-kb-input');
    expect(min.disabled).toBe(false);
    expect(max.disabled).toBe(false);
    expect(min.readOnly).toBe(false);
    expect(max.readOnly).toBe(false);
  });

  it('lists all three preset ranges in the hint copy', () => {
    const hint = ctx.document.getElementById('quality-preset-hint')
      .textContent;
    expect(hint).toContain('Low 20–60 KB');
    expect(hint).toContain('Medium 70–140 KB');
    expect(hint).toContain('High 140–400 KB');
  });

  it('drives a re-encode with the preset KB range once photos are loaded', async () => {
    const { window, document } = ctx;
    const compress = vi
      .spyOn(window.Compressor, 'compressToTarget')
      .mockImplementation(() => Promise.resolve(fakePhoto(window)));

    selectFiles(window, [IMG]);
    await waitFor(() => compress.mock.calls.length >= 1);

    clickPreset(document, 2); // High
    await waitFor(() => compress.mock.calls.length >= 2);

    expect(compress).toHaveBeenCalledTimes(2);
    expect(compress.mock.calls[1][1]).toMatchObject({ minKB: 140, maxKB: 400 });
  });

  it('falls back to the built-in table when Compressor failed to load', () => {
    const { window, document, label, min, max } = ctx;
    window.Compressor = undefined;

    clickPreset(document, 1);
    expect(label.textContent).toBe('Medium');
    expect(min.value).toBe('70');
    expect(max.value).toBe('140');
    expect(activePresetIndex(window)).toBe(1);
  });

  it('exposes the four stops as radio buttons inside a labelled group', () => {
    const { window, document } = ctx;
    const group = document.getElementById('quality-preset');
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe('quality-preset-title');
    const buttons = presetButtons(window);
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.getAttribute('role')).toBe('radio');
    }
  });
});

