/**
 * zip-exporter.test.js — the v9.0 ZIP delivery stage:
 *   - sanitizeEntryName: mechanical name clean-up only (paths, whitespace,
 *     .jpg enforcement). NO dedup / renaming — duplicates stay as given.
 *   - buildZipBlob: throws a clear error when JSZip is absent; otherwise the
 *     archive contains the workbook at the root plus a photos/ folder, and
 *     every entry is STOREd (no DEFLATE) because the payloads are already
 *     compressed.
 *
 * Runs in plain Node against the real zip-exporter.js. The real JSZip 3.10.1
 * devDependency is injected as window.JSZip, mirroring the CDN global the
 * browser loads; the generated archive is re-opened with loadAsync() to
 * assert its structure, and the raw local-file headers are parsed to prove
 * the STORE compression mode.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { loadWindiModule } from '../helpers/window-shim.js';

/** Load the real module; `withJsZip=false` simulates a failed CDN bundle. */
function loadExporter(withJsZip = true) {
  const win = {};
  if (withJsZip) win.JSZip = JSZip;
  loadWindiModule(win, 'zip-exporter.js');
  return win.ZipExporter;
}

/**
 * Read the compression METHOD field (2 bytes at offset 8) of every local
 * file header (signature PK\x03\x04). 0 = STORE, 8 = DEFLATE. A minimum
 * header length of 30 bytes keeps random payload bytes from matching.
 */
function compressionMethods(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const methods = [];
  for (let i = 0; i + 30 <= bytes.length; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      methods.push(bytes[i + 8] | (bytes[i + 9] << 8));
    }
  }
  return methods;
}

const PHOTO_NAMES = ['photos/IMG_1.jpg', 'photos/IMG_2.jpg', 'photos/a b.jpg'];

/**
 * Byte payload for a photo entry. The unit tier deliberately uses byte arrays
 * instead of Node's global Blob: JSZip's Node build does not consume Blob
 * *inputs* (the browser build does, which is what production relies on), and
 * this keeps the assertion focused on the module's own behaviour.
 */
function jpegBytes(text) {
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0)));
}

function makePhotos() {
  return [
    { originalName: 'IMG_1.png', blob: jpegBytes('jpeg-1') },
    { originalName: 'IMG_2.HEIC', blob: jpegBytes('jpeg-2') },
    { originalName: 'a b.png', blob: jpegBytes('jpeg-3') },
  ];
}

describe('ZipExporter.sanitizeEntryName — mechanical clean-up only', () => {
  it('forces .jpg and keeps the readable base', () => {
    const ZE = loadExporter();
    expect(ZE.sanitizeEntryName('vacation.png')).toBe('vacation.jpg');
    expect(ZE.sanitizeEntryName('IMG_0012.HEIC')).toBe('IMG_0012.jpg');
    expect(ZE.sanitizeEntryName('already.jpg')).toBe('already.jpg');
  });

  it('strips path segments and backslash paths', () => {
    const ZE = loadExporter();
    expect(ZE.sanitizeEntryName('C:\\DCIM\\IMG_1.png')).toBe('IMG_1.jpg');
    expect(ZE.sanitizeEntryName('./IMG.png')).toBe('IMG.jpg');
    expect(ZE.sanitizeEntryName('/var/photos/deep/x.jpg')).toBe('x.jpg');
  });

  it('collapses whitespace, trims, and falls back on empties', () => {
    const ZE = loadExporter();
    expect(ZE.sanitizeEntryName('  my   photo .png ')).toBe('my photo.jpg');
    expect(ZE.sanitizeEntryName('')).toBe('photo.jpg');
    expect(ZE.sanitizeEntryName(null)).toBe('photo.jpg');
    expect(ZE.sanitizeEntryName(42)).toBe('photo.jpg');
  });

  it('caps the entry length at 120 characters', () => {
    const ZE = loadExporter();
    const long = 'x'.repeat(300) + '.png';
    expect(ZE.sanitizeEntryName(long)).toHaveLength(120);
    expect(ZE.sanitizeEntryName(long).endsWith('.jpg')).toBe(true);
  });
});

describe('ZipExporter.buildZipBlob — assembly', () => {
  it('throws a clear error when the JSZip CDN bundle is absent', async () => {
    const ZE = loadExporter(false);
    await expect(
      ZE.buildZipBlob({
        xlsxBuffer: new Uint8Array(4).buffer,
        xlsxName: 'R.xlsx',
        photos: [],
      })
    ).rejects.toThrow(/JSZip is not loaded/);
  });

  it('packages the workbook at the root plus every photo under photos/', async () => {
    const ZE = loadExporter();
    const xlsxBuffer = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).buffer;

    const blob = await ZE.buildZipBlob({
      xlsxBuffer,
      xlsxName: 'Report.xlsx',
      photos: makePhotos(),
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/zip');

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('Report.xlsx')).not.toBeNull();
    for (const name of PHOTO_NAMES) {
      expect(zip.file(name)).not.toBeNull();
    }
    // Only the three photos made it in — nothing else under photos/.
    const photoEntries = Object.keys(zip.files).filter(
      (n) => n.startsWith('photos/') && !zip.files[n].dir
    );
    expect(photoEntries).toHaveLength(PHOTO_NAMES.length);

    const restored = await zip.file('Report.xlsx').async('uint8array');
    expect(Array.from(restored)).toEqual([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  });

  it('uses STORE for every entry (no DEFLATE) and keeps photo bytes intact', async () => {
    const ZE = loadExporter();
    const blob = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([9, 8, 7]).buffer,
      xlsxName: 'Report.xlsx',
      photos: makePhotos(),
    });

    const buffer = await blob.arrayBuffer();
    const methods = compressionMethods(buffer);
    // One local header per entry: the workbook, the photos/ dir and the photos.
    expect(methods.length).toBeGreaterThanOrEqual(PHOTO_NAMES.length + 2);
    expect(methods.every((m) => m === 0)).toBe(true); // 0 = STORE

    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('photos/IMG_1.jpg').async('string')).toBe('jpeg-1');
    expect(await zip.file('photos/a b.jpg').async('string')).toBe('jpeg-3');
  });

  it('keeps duplicate original names as given (no renaming, last write wins)', async () => {
    const ZE = loadExporter();
    const blob = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [
        { originalName: 'same.png', blob: jpegBytes('first') },
        { originalName: 'same.png', blob: jpegBytes('second') },
      ],
    });

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('photos/same.jpg')).not.toBeNull();
    const photoEntries = Object.keys(zip.files).filter(
      (n) => n.startsWith('photos/') && !zip.files[n].dir
    );
    expect(photoEntries).toEqual(['photos/same.jpg']);
    expect(await zip.file('photos/same.jpg').async('string')).toBe('second');
  });

  it('skips photo entries without a blob and survives an empty photo list', async () => {
    const ZE = loadExporter();
    const empty = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [],
    });
    const emptyZip = await JSZip.loadAsync(await empty.arrayBuffer());
    expect(emptyZip.file('Report.xlsx')).not.toBeNull();

    const partial = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [
        { originalName: 'ok.png', blob: jpegBytes('ok') },
        { originalName: 'broken.png', blob: null },
      ],
    });
    const partialZip = await JSZip.loadAsync(await partial.arrayBuffer());
    expect(partialZip.file('photos/ok.jpg')).not.toBeNull();
    expect(partialZip.file('photos/broken.jpg')).toBeNull();
  });
});