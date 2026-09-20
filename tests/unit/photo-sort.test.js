/**
 * photo-sort.test.js — the v8.3 ingest-sorting helpers in compressor.js:
 *   - compareNamesNatural() is a numeric-aware natural filename comparison
 *   - sortPhotoKeys() orders photo keys by ascending capture timestamp, with
 *     natural filename order as the cascading tie-breaker
 *
 * Runs in plain Node: compressor.js is loaded through the shared window shim,
 * so the cascade is exercised with no DOM, canvas, layout or Excel code.
 */
import { describe, it, expect } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';
import {
  jpegWithExif,
  jpegWithoutExif,
} from '../helpers/exif-fixtures.js';

function loadCompressor() {
  const win = {};
  loadWindiModule(win, 'compressor.js');
  return win.Compressor;
}

const C = loadCompressor();

/** Build a sort key; `timestamp` is epoch ms, or null/NaN for "no date". */
function key(index, name, timestamp = null) {
  return { index, timestamp, name };
}

/** Names in sorted order — the assertion shape that reads best in failures. */
function order(keys) {
  return C.sortPhotoKeys(keys)
    .map((k) => k.name)
    .join(',');
}

/** Epoch ms for a local calendar date, so tests never depend on the clock. */
function at(year, month, day) {
  return new Date(year, month - 1, day).getTime();
}

describe('Compressor sorting surface (v8.3)', () => {
  it('publishes the two sorting helpers alongside the bumped version', () => {
    expect(typeof C.compareNamesNatural).toBe('function');
    expect(typeof C.sortPhotoKeys).toBe('function');
    expect(C.VERSION).toMatch(/^v\d+\.\d+$/);
  });
});

describe('Compressor.compareNamesNatural', () => {
  it('ranks camera sequence numbers numerically, not lexicographically', () => {
    expect(C.compareNamesNatural('IMG_4490.jpg', 'IMG_4501.jpg')).toBeLessThan(0);
    expect(C.compareNamesNatural('IMG_4501.jpg', 'IMG_4490.jpg')).toBeGreaterThan(0);
  });

  it('puts photo_2.jpg before photo_10.jpg', () => {
    expect(C.compareNamesNatural('photo_2.jpg', 'photo_10.jpg')).toBeLessThan(0);
    expect(C.compareNamesNatural('photo_10.jpg', 'photo_2.jpg')).toBeGreaterThan(0);
  });

  it('is case-insensitive (sensitivity: base)', () => {
    expect(C.compareNamesNatural('img_1.jpg', 'IMG_1.jpg')).toBe(0);
  });

  it('reports 0 for identical names and treats null/undefined as empty', () => {
    expect(C.compareNamesNatural('a.jpg', 'a.jpg')).toBe(0);
    expect(C.compareNamesNatural(null, '')).toBe(0);
    expect(C.compareNamesNatural(undefined, null)).toBe(0);
  });
});

describe('Compressor.sortPhotoKeys — chronological ordering', () => {
  it('orders photos oldest-first regardless of selection order', () => {
    const keys = [
      key(0, 'c.jpg', at(2026, 9, 19)),
      key(1, 'a.jpg', at(2020, 1, 1)),
      key(2, 'b.jpg', at(2024, 5, 7)),
    ];
    expect(order(keys)).toBe('a.jpg,b.jpg,c.jpg');
  });

  it('keeps a strictly descending selection from leaking through', () => {
    const keys = [
      key(0, 'new.jpg', at(2030, 12, 31)),
      key(1, 'old.jpg', at(1999, 12, 31)),
    ];
    expect(order(keys)).toBe('old.jpg,new.jpg');
  });

  it('returns the original indices so callers can reorder their own array', () => {
    const keys = [
      key(0, 'late.jpg', at(2026, 1, 1)),
      key(1, 'early.jpg', at(2020, 1, 1)),
    ];
    expect(C.sortPhotoKeys(keys).map((k) => k.index)).toEqual([1, 0]);
  });

  it('compares by instant, not by day', () => {
    const keys = [
      key(0, 'later.jpg', at(2024, 5, 7) + 60 * 60 * 1000),
      key(1, 'earlier.jpg', at(2024, 5, 7)),
    ];
    expect(order(keys)).toBe('earlier.jpg,later.jpg');
  });
});


describe('Compressor.sortPhotoKeys — EXIF tie-breaker by filename', () => {
  const sameMoment = new Date(2024, 4, 7, 12, 0, 0, 0).getTime();

  it('uses natural filename order when the timestamps are identical', () => {
    const keys = [
      key(0, 'IMG_4501.jpg', sameMoment),
      key(1, 'IMG_4490.jpg', sameMoment),
    ];
    expect(order(keys)).toBe('IMG_4490.jpg,IMG_4501.jpg');
  });

  it('beats the selection order (IMG_4490 selected second still comes first)', () => {
    const keys = [
      key(0, 'IMG_4501.jpg', sameMoment),
      key(1, 'IMG_4490.jpg', sameMoment),
    ];
    expect(C.sortPhotoKeys(keys)[0].name).toBe('IMG_4490.jpg');
    expect(C.sortPhotoKeys(keys)[0].index).toBe(1);
  });

  it('ranks sequence numbers numerically on a tie', () => {
    const keys = [
      key(0, 'photo_10.jpg', sameMoment),
      key(1, 'photo_2.jpg', sameMoment),
    ];
    expect(order(keys)).toBe('photo_2.jpg,photo_10.jpg');
  });
});

describe('Compressor.sortPhotoKeys — EXIF-less photos', () => {
  it('falls back to natural filename order when every timestamp is missing', () => {
    const keys = [
      key(0, 'photo_10.jpg', null),
      key(1, 'photo_2.jpg', null),
      key(2, 'photo_1.jpg', null),
    ];
    expect(order(keys)).toBe('photo_1.jpg,photo_2.jpg,photo_10.jpg');
  });

  it('falls back to natural filename order when only one side has a date', () => {
    const keys = [
      key(0, 'b.jpg', null),
      key(1, 'a.jpg', at(2024, 1, 1)),
    ];
    expect(order(keys)).toBe('a.jpg,b.jpg');
  });

  it('treats NaN and Infinity timestamps as missing', () => {
    const keys = [
      key(0, 'photo_10.jpg', NaN),
      key(1, 'photo_2.jpg', Infinity),
    ];
    expect(order(keys)).toBe('photo_2.jpg,photo_10.jpg');
  });

  it('still uses the capture date when both sides have one', () => {
    const keys = [
      key(0, 'zzz.jpg', at(1999, 1, 1)),
      key(1, 'aaa.jpg', at(2030, 1, 1)),
    ];
    expect(order(keys)).toBe('zzz.jpg,aaa.jpg');
  });
});

describe('Compressor.sortPhotoKeys — stability and purity', () => {
  it('keeps the selection order for a full tie (same timestamp AND name)', () => {
    const sameMoment = at(2024, 1, 1);
    const keys = [
      key(0, 'same.jpg', sameMoment),
      key(5, 'same.jpg', sameMoment),
      key(9, 'same.jpg', sameMoment),
    ];
    expect(C.sortPhotoKeys(keys).map((k) => k.index)).toEqual([0, 5, 9]);
  });

  it('never mutates the input array or its records', () => {
    const keys = [
      { index: 0, timestamp: 300, name: 'c.jpg' },
      { index: 1, timestamp: 100, name: 'a.jpg' },
      { index: 2, timestamp: 200, name: 'b.jpg' },
    ];
    const snapshot = JSON.parse(JSON.stringify(keys));
    C.sortPhotoKeys(keys);
    expect(keys).toEqual(snapshot);
  });

  it('handles empty and non-array input without throwing', () => {
    expect(C.sortPhotoKeys([])).toEqual([]);
    expect(C.sortPhotoKeys(null)).toEqual([]);
    expect(C.sortPhotoKeys(undefined)).toEqual([]);
  });

  it('leaves a single key untouched', () => {
    const keys = [key(0, 'only.jpg', 123)];
    expect(C.sortPhotoKeys(keys)).toEqual(keys);
  });
});

describe('capture date -> sort key pipeline (v9.2 contract)', () => {
  /** The exact key shape app.js builds in readSortKeys(). */
  function buildKeys(files, lastModified) {
    return files.map((file, index) => {
      const date = C.resolveCaptureDate(file.bytes, lastModified);
      return {
        index,
        timestamp: date instanceof Date ? date.getTime() : null,
        name: file.name,
      };
    });
  }

  it('orders real EXIF fixtures oldest-first and files them by lastModified otherwise', () => {
    const files = [
      { name: 'c.jpg', bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }) },
      { name: 'a.jpg', bytes: jpegWithExif({ dateTimeOriginal: '2020:01:01 08:00:00' }) },
      { name: 'b.jpg', bytes: jpegWithoutExif() },
    ];
    // b.jpg has no EXIF: its file timestamp (2024) lands it between a and c.
    const keys = buildKeys(files, at(2024, 5, 7));
    expect(order(keys)).toBe('a.jpg,b.jpg,c.jpg');
  });

  it('breaks a real fixture tie by natural filename order', () => {
    const stamp = { dateTimeOriginal: '2024:05:07 12:00:00' };
    const files = [
      { name: 'IMG_4501.jpg', bytes: jpegWithExif(stamp) },
      { name: 'IMG_4490.jpg', bytes: jpegWithExif(stamp) },
    ];
    expect(order(buildKeys(files))).toBe('IMG_4490.jpg,IMG_4501.jpg');
  });

  it('orders EXIF-less fixtures naturally when the file timestamps also tie', () => {
    const files = [
      { name: 'photo_10.jpg', bytes: jpegWithoutExif() },
      { name: 'photo_2.jpg', bytes: jpegWithoutExif() },
    ];
    expect(order(buildKeys(files, at(2024, 5, 7)))).toBe(
      'photo_2.jpg,photo_10.jpg'
    );
  });

  it('has no timestamp at all when EXIF is absent and lastModified is undefined', () => {
    const keys = buildKeys([{ name: 'x.jpg', bytes: jpegWithoutExif() }]);
    expect(keys[0].timestamp).toBeNull();
  });
});

