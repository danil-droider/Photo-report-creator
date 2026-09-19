/**
 * exif-date.test.js — the v8.2 capture-date helpers in compressor.js:
 *   - readExifStamp() walks a JPEG APP1 / TIFF block (both byte orders)
 *   - parseExifStamp() validates the YYYY:MM:DD HH:MM:SS stamp into a LOCAL Date
 *   - resolveCaptureDate() applies EXIF -> file.lastModified -> null
 *
 * Runs in plain Node: compressor.js is loaded through the shared window shim and
 * every fixture is hand-assembled bytes, so nothing depends on a real photo.
 */
import { describe, it, expect } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';
import {
  jpegWithExif,
  jpegWithoutExif,
  truncatedExif,
  notAJpeg,
} from '../helpers/exif-fixtures.js';

function loadCompressor() {
  const win = {};
  loadWindiModule(win, 'compressor.js');
  return win.Compressor;
}

const C = loadCompressor();

/** Format a Date the way app.js does, to prove the two agree. */
function asReportDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

describe('Compressor EXIF surface', () => {
  it('publishes the three date helpers alongside the bumped version', () => {
    expect(typeof C.readExifStamp).toBe('function');
    expect(typeof C.parseExifStamp).toBe('function');
    expect(typeof C.resolveCaptureDate).toBe('function');
    expect(C.VERSION).toMatch(/^v\d+\.\d+$/);
  });
});

describe('Compressor.readExifStamp', () => {
  it('reads DateTimeOriginal out of a little-endian block', () => {
    const bytes = jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' });
    expect(C.readExifStamp(bytes)).toBe('2026:09:19 14:30:21');
  });

  it('reads DateTimeOriginal out of a big-endian block', () => {
    const bytes = jpegWithExif({
      endian: 'MM',
      dateTimeOriginal: '2024:05:07 08:09:10',
    });
    expect(C.readExifStamp(bytes)).toBe('2024:05:07 08:09:10');
  });

  it('prefers DateTimeOriginal over DateTimeDigitized and DateTime', () => {
    const bytes = jpegWithExif({
      dateTime: '2019:01:01 00:00:00',
      dateTimeDigitized: '2020:02:02 00:00:00',
      dateTimeOriginal: '2026:09:19 14:30:21',
    });
    expect(C.readExifStamp(bytes)).toBe('2026:09:19 14:30:21');
  });

  it('falls back to DateTimeDigitized, then to IFD0 DateTime', () => {
    expect(
      C.readExifStamp(
        jpegWithExif({
          dateTime: '2019:01:01 00:00:00',
          dateTimeDigitized: '2020:02:02 00:00:00',
        })
      )
    ).toBe('2020:02:02 00:00:00');

    expect(
      C.readExifStamp(jpegWithExif({ dateTime: '2019:01:01 00:00:00' }))
    ).toBe('2019:01:01 00:00:00');
  });

  it('accepts an ArrayBuffer and a DataView as well as a Uint8Array', () => {
    const bytes = jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' });
    expect(C.readExifStamp(bytes.buffer)).toBe('2026:09:19 14:30:21');
    expect(C.readExifStamp(new DataView(bytes.buffer))).toBe(
      '2026:09:19 14:30:21'
    );
  });

  it('returns null when there is no EXIF to read', () => {
    expect(C.readExifStamp(jpegWithoutExif())).toBeNull();
    expect(C.readExifStamp(notAJpeg())).toBeNull();
    expect(C.readExifStamp(truncatedExif())).toBeNull();
    expect(C.readExifStamp(jpegWithExif({}))).toBeNull(); // no tags at all
  });

  it('never throws on junk input', () => {
    expect(C.readExifStamp(null)).toBeNull();
    expect(C.readExifStamp(undefined)).toBeNull();
    expect(C.readExifStamp(new Uint8Array(0))).toBeNull();
    expect(C.readExifStamp(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(C.readExifStamp(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(C.readExifStamp('nope')).toBeNull();
    expect(() => C.readExifStamp({})).not.toThrow();
  });
});

describe('Compressor.parseExifStamp', () => {
  it('builds a LOCAL date that echoes the stamp exactly', () => {
    const date = C.parseExifStamp('2026:09:19 14:30:21');
    expect(date).toBeInstanceOf(Date);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8); // September
    expect(date.getDate()).toBe(19);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
    expect(date.getSeconds()).toBe(21);
  });

  it('ignores anything trailing the stamp', () => {
    expect(C.parseExifStamp('2026:09:19 14:30:21 trailing')).toBeInstanceOf(
      Date
    );
  });

  it('rejects the unknown-value placeholder and out-of-range fields', () => {
    expect(C.parseExifStamp('0000:00:00 00:00:00')).toBeNull();
    expect(C.parseExifStamp('2026:13:01 00:00:00')).toBeNull();
    expect(C.parseExifStamp('2026:00:10 00:00:00')).toBeNull();
    expect(C.parseExifStamp('2026:02:30 10:00:00')).toBeNull(); // rolls to Mar 2
    expect(C.parseExifStamp('2026:01:01 25:00:00')).toBeNull();
    expect(C.parseExifStamp('2026:01:01 10:60:00')).toBeNull();
    expect(C.parseExifStamp('1900:01:01 00:00:00')).toBeNull();
    expect(C.parseExifStamp('2099:01:01 00:00:00')).toBeNull();
  });

  it('rejects anything that is not a stamp at all', () => {
    expect(C.parseExifStamp('')).toBeNull();
    expect(C.parseExifStamp('garbage')).toBeNull();
    expect(C.parseExifStamp('2026-09-19 14:30:21')).toBeNull();
    expect(C.parseExifStamp(null)).toBeNull();
    expect(C.parseExifStamp(undefined)).toBeNull();
    expect(C.parseExifStamp(20260919)).toBeNull();
  });
});

describe('Compressor.resolveCaptureDate', () => {
  const LOCAL_TS = new Date(2024, 4, 7, 12, 0, 0).getTime();

  it('prefers EXIF over the file timestamp', () => {
    const date = C.resolveCaptureDate(
      jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      LOCAL_TS
    );
    expect(asReportDate(date)).toBe('19.09.2026');
  });

  it('falls back to file.lastModified when there is no EXIF', () => {
    const date = C.resolveCaptureDate(jpegWithoutExif(), LOCAL_TS);
    expect(date.getTime()).toBe(LOCAL_TS);
  });

  it('falls back to lastModified when the EXIF stamp is unusable', () => {
    const date = C.resolveCaptureDate(
      jpegWithExif({ dateTimeOriginal: '0000:00:00 00:00:00' }),
      LOCAL_TS
    );
    expect(date.getTime()).toBe(LOCAL_TS);
  });

  it('returns null when nothing usable is available', () => {
    expect(C.resolveCaptureDate(jpegWithoutExif(), undefined)).toBeNull();
    expect(C.resolveCaptureDate(jpegWithoutExif(), 0)).toBeNull();
    expect(C.resolveCaptureDate(jpegWithoutExif(), -1)).toBeNull();
    expect(C.resolveCaptureDate(jpegWithoutExif(), NaN)).toBeNull();
    expect(C.resolveCaptureDate(null, null)).toBeNull();
  });

  it('never throws on junk bytes', () => {
    const junk = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
    ]);
    expect(() => C.resolveCaptureDate(junk, LOCAL_TS)).not.toThrow();
    expect(C.resolveCaptureDate(junk, LOCAL_TS).getTime()).toBe(LOCAL_TS);
    expect(C.resolveCaptureDate('junk', LOCAL_TS).getTime()).toBe(LOCAL_TS);
  });

  it('produces a date that formats as DD.MM.YYYY', () => {
    const date = C.resolveCaptureDate(
      jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      0
    );
    expect(asReportDate(date)).toBe('19.09.2026');
  });
});
