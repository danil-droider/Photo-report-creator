/**
 * app-totals.test.js — the pure, DOM-free surface of app.js (v7.7):
 *   - formatSize: byte -> B / KB / MB / GB conversion (zero, boundaries, rounding)
 *   - computeTotals: the sums behind the "Total Size:" footer
 *
 * Runs in plain Node. app.js is a closed IIFE that reads document.readyState at
 * load time, so the loadAppModule() helper installs a throwaway document stub:
 * the module boots deferred (registering a no-op DOMContentLoaded listener) and
 * publishes window.AppTotals without ever touching real DOM APIs.
 */
import { describe, it, expect } from 'vitest';
import { loadAppModule } from '../helpers/window-shim.js';

const KB = 1024;

function loadAppTotals() {
  const win = {};
  loadAppModule(win);
  return win.AppTotals;
}

const T = loadAppTotals();

describe('AppTotals surface', () => {
  it('publishes the version and every pure helper', () => {
    expect(T).toBeTruthy();
    expect(T.VERSION).toMatch(/^v\d+\.\d+$/);
    expect(typeof T.formatSize).toBe('function');
    expect(typeof T.computeTotals).toBe('function');
    // v8.0 file-naming surface.
    expect(typeof T.sanitizeFilename).toBe('function');
    expect(typeof T.formatReportDate).toBe('function');
    expect(typeof T.defaultReportName).toBe('function');
    expect(typeof T.toXlsxFilename).toBe('function');
  });

  it('leaves the ambient document exactly as it found it', () => {
    const before = globalThis.document; // undefined in this tier
    loadAppTotals();
    expect(globalThis.document).toBe(before);
  });
});

describe('AppTotals.formatSize', () => {
  it('renders falsy / non-numeric input as 0 B', () => {
    expect(T.formatSize(0)).toBe('0 B');
    expect(T.formatSize(undefined)).toBe('0 B');
    expect(T.formatSize(null)).toBe('0 B');
    expect(T.formatSize(NaN)).toBe('0 B');
    expect(T.formatSize('')).toBe('0 B');
  });

  it('uses whole bytes below 1 KB', () => {
    expect(T.formatSize(1)).toBe('1 B');
    expect(T.formatSize(512)).toBe('512 B');
    expect(T.formatSize(1023)).toBe('1023 B');
  });

  it('uses one-decimal KB from 1024 bytes up', () => {
    expect(T.formatSize(KB)).toBe('1.0 KB');
    expect(T.formatSize(1536)).toBe('1.5 KB');
    expect(T.formatSize(120 * KB)).toBe('120.0 KB');
    // Just under a megabyte still reads as KB (the unit is picked by floor()).
    expect(T.formatSize(KB * KB - 1)).toBe('1024.0 KB');
  });

  it('rolls over to MB / GB at the 1024 boundaries', () => {
    expect(T.formatSize(KB * KB)).toBe('1.0 MB');
    expect(T.formatSize(5.5 * KB * KB)).toBe('5.5 MB');
    expect(T.formatSize(5 * KB * KB * KB)).toBe('5.0 GB');
  });

  it('clamps at GB for totals beyond the table', () => {
    expect(T.formatSize(3 * KB ** 4)).toBe('3072.0 GB');
  });

  it('rounds to a single decimal', () => {
    expect(T.formatSize(1126)).toBe('1.1 KB'); // 1.099609375 KB
    expect(T.formatSize(1140)).toBe('1.1 KB'); // 1.11328125 KB
    expect(T.formatSize(1600)).toBe('1.6 KB'); // 1.5625 KB
  });
});

describe('AppTotals.computeTotals', () => {
  const file = (size) => ({ name: 'x.jpg', size });
  const photo = (bytes) => ({ bytes });
  const ZERO = {
    count: 0,
    originalBytes: 0,
    compressedBytes: 0,
    complete: false,
  };

  it('returns a zeroed, incomplete result for empty input', () => {
    expect(T.computeTotals([], [])).toEqual(ZERO);
  });

  it('tolerates missing / non-array arguments', () => {
    expect(T.computeTotals()).toEqual(ZERO);
    expect(T.computeTotals(null, null)).toEqual(ZERO);
    expect(T.computeTotals(undefined, undefined)).toEqual(ZERO);
    expect(T.computeTotals({}, {})).toEqual(ZERO);
    expect(T.computeTotals([], null)).toEqual(ZERO);
  });

  it('sums a single processed photo', () => {
    expect(T.computeTotals([file(KB)], [photo(120 * KB)])).toEqual({
      count: 1,
      originalBytes: KB,
      compressedBytes: 120 * KB,
      complete: true,
    });
  });

  it('sums many photos regardless of order', () => {
    const files = [file(1000), file(2000), file(4000)];
    const photos = [photo(100 * KB), photo(200 * KB), photo(300 * KB)];

    expect(T.computeTotals(files, photos)).toEqual({
      count: 3,
      originalBytes: 7000,
      compressedBytes: 600 * KB,
      complete: true,
    });

    const reversed = T.computeTotals(
      [...files].reverse(),
      [...photos].reverse()
    );
    expect(reversed.originalBytes).toBe(7000);
    expect(reversed.compressedBytes).toBe(600 * KB);
    expect(reversed.complete).toBe(true);
  });

  it('is incomplete while compression is still running', () => {
    expect(T.computeTotals([file(1000), file(2000)], [photo(120 * KB)])).toEqual({
      count: 2,
      originalBytes: 3000,
      compressedBytes: 120 * KB,
      complete: false,
    });
  });

  it('is incomplete when a photo failed and was skipped', () => {
    const totals = T.computeTotals(
      [file(1000), file(2000), file(3000)],
      [photo(10), photo(20)]
    );
    expect(totals.count).toBe(3);
    expect(totals.complete).toBe(false);
    // Only the two survivors are summed - the originals still cover all three,
    // which is exactly why the arrow must stay hidden (see renderFileTotals).
    expect(totals.compressedBytes).toBe(30);
  });

  it('treats junk byte counts as zero instead of NaN', () => {
    const totals = T.computeTotals(
      [file(0), file(-5), file(undefined), file('nope'), {}, null],
      [photo(NaN), photo(Infinity), photo(-1), null]
    );
    expect(totals.count).toBe(6);
    expect(totals.originalBytes).toBe(0);
    expect(totals.compressedBytes).toBe(0);
    expect(Number.isNaN(totals.originalBytes)).toBe(false);
  });

  it('accepts numeric strings (Number() coercion)', () => {
    expect(T.computeTotals([file('2048')], [photo('4096')])).toMatchObject({
      originalBytes: 2048,
      compressedBytes: 4096,
      complete: true,
    });
  });

  it('never mutates its inputs', () => {
    const files = [file(1000), file(2000)];
    const photos = [photo(10), photo(20)];
    T.computeTotals(files, photos);
    expect(files).toHaveLength(2);
    expect(photos).toHaveLength(2);
    expect(files[0].size).toBe(1000);
    expect(photos[1].bytes).toBe(20);
  });

  it('composes with formatSize into the exact footer text', () => {
    const totals = T.computeTotals(
      [file(KB), file(KB)],
      [photo(120 * KB), photo(120 * KB)]
    );
    const text =
      `${T.formatSize(totals.originalBytes)} \u2192 ` +
      `${T.formatSize(totals.compressedBytes)}`;
    expect(text).toBe('2.0 KB \u2192 240.0 KB');
  });
});


describe('AppTotals.formatReportDate', () => {
  it('renders DD.MM.YYYY from local date parts', () => {
    expect(T.formatReportDate(new Date(2026, 8, 19))).toBe('19.09.2026');
  });

  it('zero-pads day and month', () => {
    expect(T.formatReportDate(new Date(2026, 0, 5))).toBe('05.01.2026');
    expect(T.formatReportDate(new Date(2026, 8, 9))).toBe('09.09.2026');
  });

  it('handles the year end without a rollover', () => {
    expect(T.formatReportDate(new Date(2026, 11, 31))).toBe('31.12.2026');
  });

  it('falls back to today for missing / invalid input', () => {
    expect(T.formatReportDate()).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(T.formatReportDate('nope')).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(T.formatReportDate(new Date('invalid'))).toMatch(
      /^\d{2}\.\d{2}\.\d{4}$/
    );
  });

  it('uses local time, so the day never shifts across the UTC boundary', () => {
    expect(T.formatReportDate(new Date(2026, 5, 1, 0, 30))).toBe('01.06.2026');
    expect(T.formatReportDate(new Date(2026, 5, 30, 23, 30))).toBe('30.06.2026');
  });
});

describe('AppTotals.defaultReportName', () => {
  it('is exactly Photo report DD.MM.YYYY', () => {
    expect(T.defaultReportName(new Date(2026, 8, 19))).toBe(
      'Photo report 19.09.2026'
    );
  });

  it('is hyphen-free, space-separated and carries no extension', () => {
    const name = T.defaultReportName(new Date(2026, 8, 19));
    expect(name.indexOf('Photo report ')).toBe(0);
    expect(name).not.toContain('-');
    expect(name).not.toContain('.xlsx');
    expect(/^Photo\.report/.test(name)).toBe(false);
  });

  it('defaults to today when no date is given', () => {
    expect(T.defaultReportName()).toMatch(/^Photo report \d{2}\.\d{2}\.\d{4}$/);
  });
});

describe('AppTotals.sanitizeFilename', () => {
  it('strips every OS-forbidden character', () => {
    for (const ch of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(T.sanitizeFilename(`a${ch}b`)).toBe('ab');
    }
  });

  it('strips a whole forbidden run at once', () => {
    expect(T.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('strips control characters', () => {
    expect(T.sanitizeFilename('a\u0000b\u001fc')).toBe('abc');
    expect(T.sanitizeFilename('tab\there')).toBe('tabhere');
  });

  it('trims surrounding whitespace', () => {
    expect(T.sanitizeFilename('  Report  ')).toBe('Report');
  });

  it('drops a spreadsheet extension the user typed', () => {
    expect(T.sanitizeFilename('Report.xlsx')).toBe('Report');
    expect(T.sanitizeFilename('Report.XLSX')).toBe('Report');
    expect(T.sanitizeFilename('Report.xls')).toBe('Report');
  });

  it('drops a trailing dot or space (Windows rejects both)', () => {
    expect(T.sanitizeFilename('Report.')).toBe('Report');
    expect(T.sanitizeFilename('Report .')).toBe('Report');
  });

  it('keeps the dots inside the name - the date needs them', () => {
    expect(T.sanitizeFilename('Photo report 19.09.2026')).toBe(
      'Photo report 19.09.2026'
    );
  });

  it('leaves non-Latin names alone', () => {
    expect(T.sanitizeFilename('Отчёт 2026')).toBe('Отчёт 2026');
  });

  it('returns an empty string when nothing survives', () => {
    expect(T.sanitizeFilename('')).toBe('');
    expect(T.sanitizeFilename('///***??||')).toBe('');
    expect(T.sanitizeFilename(null)).toBe('');
    expect(T.sanitizeFilename(undefined)).toBe('');
  });

  it('strips ONLY the listed characters - everything else is legal', () => {
    expect(T.sanitizeFilename('///***?!')).toBe('!');
    expect(T.sanitizeFilename('Report #1 (final)!')).toBe('Report #1 (final)!');
  });

  it('coerces non-strings instead of throwing', () => {
    expect(T.sanitizeFilename(42)).toBe('42');
  });
});

describe('AppTotals.toXlsxFilename', () => {
  it('appends .xlsx to a plain base name', () => {
    expect(T.toXlsxFilename('My Report')).toBe('My Report.xlsx');
  });

  it('is idempotent - never doubles the extension', () => {
    expect(T.toXlsxFilename('My Report.xlsx')).toBe('My Report.xlsx');
    expect(T.toXlsxFilename('My Report.XLSX')).toBe('My Report.xlsx');
    expect(T.toXlsxFilename('My Report.xls')).toBe('My Report.xlsx');
  });

  it('sanitizes before appending', () => {
    expect(T.toXlsxFilename('a/b:c')).toBe('abc.xlsx');
  });

  it('keeps a hyphen in a custom name - only the default is hyphen-free', () => {
    expect(T.toXlsxFilename('My-Report')).toBe('My-Report.xlsx');
  });

  it('falls back to the dated default when nothing is left', () => {
    const pattern = /^Photo report \d{2}\.\d{2}\.\d{4}\.xlsx$/;
    expect(T.toXlsxFilename('')).toMatch(pattern);
    expect(T.toXlsxFilename('   ')).toMatch(pattern);
    expect(T.toXlsxFilename('///')).toMatch(pattern);
  });

  it('uses the supplied fallback date when the name is empty (v8.2)', () => {
    expect(T.toXlsxFilename('', new Date(2026, 8, 19))).toBe(
      'Photo report 19.09.2026.xlsx'
    );
  });

  it('composes with defaultReportName', () => {
    expect(T.toXlsxFilename(T.defaultReportName(new Date(2026, 8, 19)))).toBe(
      'Photo report 19.09.2026.xlsx'
    );
  });
});
