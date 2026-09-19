/**
 * compressor-range.test.js — the pure, DOM-free surface of compressor.js:
 * resolveRange (KB clamping + inversion swap), the constant contract and the
 * preset table. Runs in plain Node; canvas APIs are never touched.
 */
import { describe, it, expect } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

function loadCompressor() {
  const win = {};
  loadWindiModule(win, 'compressor.js');
  return win.Compressor;
}

describe('Compressor constants contract', () => {
  const C = loadCompressor();

  it('exposes the published pipeline constants', () => {
    expect(C.MAX_WIDTH).toBe(800);
    expect(C.DEFAULT_MIN_KB).toBe(80);
    expect(C.DEFAULT_MAX_KB).toBe(220);
    expect(C.QUALITY_MIN).toBe(0.15);
    expect(C.QUALITY_MAX).toBe(0.95);
    expect(C.TOLERANCE).toBe(0.1);
    expect(C.MAX_ITERATIONS).toBe(7);
    expect(C.PICA_FILTER).toBe('lanczos3');
    expect(C.PICA_TILE).toBe(1024);
    expect(C.ORIENT_CAP_FACTOR).toBe(2);
    expect(C.ORIENT_CAP_MIN).toBe(1600);
    expect(C.BAKE_FULL_MAX_PIXELS).toBe(4000000);
    expect(C.VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('exposes the Quality preset table and the Custom stop', () => {
    expect(C.QUALITY_PRESETS).toEqual([
      { id: 'low', label: 'Low', minKB: 20, maxKB: 60 },
      { id: 'medium', label: 'Medium', minKB: 70, maxKB: 140 },
      { id: 'high', label: 'High', minKB: 140, maxKB: 400 },
    ]);
    expect(C.PRESET_CUSTOM_INDEX).toBe(3);
  });
});

describe('Compressor.resolveRange', () => {
  const C = loadCompressor();
  const DEFAULTS = { minKB: 80, maxKB: 220 };

  it('returns the defaults for missing or non-object options', () => {
    expect(C.resolveRange()).toEqual(DEFAULTS);
    expect(C.resolveRange(null)).toEqual(DEFAULTS);
    expect(C.resolveRange(undefined)).toEqual(DEFAULTS);
    expect(C.resolveRange(42)).toEqual(DEFAULTS);
    expect(C.resolveRange({})).toEqual(DEFAULTS);
  });

  it('passes a valid range through unchanged', () => {
    expect(C.resolveRange({ minKB: 150, maxKB: 200 })).toEqual({
      minKB: 150,
      maxKB: 200,
    });
    expect(C.resolveRange({ minKB: 20, maxKB: 60 })).toEqual({
      minKB: 20,
      maxKB: 60,
    });
  });

  it('swaps an inverted range so min <= max', () => {
    expect(C.resolveRange({ minKB: 200, maxKB: 80 })).toEqual({
      minKB: 80,
      maxKB: 200,
    });
    expect(C.resolveRange({ minKB: 400, maxKB: 140 })).toEqual({
      minKB: 140,
      maxKB: 400,
    });
  });

  it('falls back per-bound for junk values (0 / negative / NaN / strings)', () => {
    expect(C.resolveRange({ minKB: 0, maxKB: 100 })).toEqual({
      minKB: 80,
      maxKB: 100,
    });
    expect(C.resolveRange({ minKB: -1, maxKB: 100 })).toEqual({
      minKB: 80,
      maxKB: 100,
    });
    expect(C.resolveRange({ minKB: 'x', maxKB: 'y' })).toEqual(DEFAULTS);
    expect(C.resolveRange({ minKB: NaN, maxKB: Infinity })).toEqual({
      minKB: 80,
      maxKB: 220,
    });
  });

  it('accepts numeric strings (Number() coercion) like the DOM inputs', () => {
    expect(C.resolveRange({ minKB: '150', maxKB: '200' })).toEqual({
      minKB: 150,
      maxKB: 200,
    });
  });
});
