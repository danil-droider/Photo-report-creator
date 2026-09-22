/**
 * zip-exporter.test.js — the v9.0 ZIP delivery stage, v11.0 root-folder shape:
 *   - sanitizeEntryName: mechanical name clean-up only (paths, whitespace,
 *     .jpg enforcement). NO dedup / renaming — duplicates stay as given.
 *   - buildZipBlob: throws a clear error when JSZip is absent; otherwise the
 *     archive holds EXACTLY ONE top-level folder (spec.rootFolder) containing
 *     the workbook and every photo, and every entry is STOREd (no DEFLATE)
 *     because the payloads are already compressed.
 *   - v23.0: the archive is an ALLOWLIST — the .xlsx workbook plus .jpg photos
 *     only. A dedicated test re-opens the generated buffer and asserts that no
 *     .txt / .json / .md / metadata entry exists in the file list.
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

const ROOT = 'Report';
const PHOTO_NAMES = [
  `${ROOT}/IMG_1.jpg`,
  `${ROOT}/IMG_2.jpg`,
  `${ROOT}/a b.jpg`,
];

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

  it('nests the workbook and every photo inside the single root folder', async () => {
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
    expect(zip.file(`${ROOT}/Report.xlsx`)).not.toBeNull();
    for (const name of PHOTO_NAMES) {
      expect(zip.file(name)).not.toBeNull();
    }

    // v11.0 — exactly ONE top-level entry (the root folder) and no loose file
    // at the archive root: opening the ZIP displays only ${ROOT}/.
    // Depth 0 == no slash except the directory's own trailing one.
    const topLevel = (z) =>
      Object.keys(z.files).filter(
        (n) => n.replace(/\/$/, '').indexOf('/') === -1
      );
    expect(topLevel(zip)).toEqual([`${ROOT}/`]);
    expect(zip.files[`${ROOT}/`].dir).toBe(true);
    expect(topLevel(zip).filter((n) => !zip.files[n].dir)).toEqual([]);

    // The photos sit FLAT in the root folder — no photos/ subfolder anywhere.
    expect(
      Object.keys(zip.files).some((n) => n.startsWith('photos/'))
    ).toBe(false);
    const photoEntries = Object.keys(zip.files).filter(
      (n) => n.startsWith(`${ROOT}/`) && !zip.files[n].dir
    );
    expect(photoEntries).toHaveLength(PHOTO_NAMES.length + 1); // photos + xlsx

    const restored = await zip.file(`${ROOT}/Report.xlsx`).async('uint8array');
    expect(Array.from(restored)).toEqual([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
  });

  it('honors an explicit rootFolder matching the .zip / .xlsx base name', async () => {
    const ZE = loadExporter();
    const blob = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'My Report.xlsx',
      rootFolder: 'My Report',
      photos: [{ originalName: 'IMG_1.png', blob: jpegBytes('jpeg-1') }],
    });

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(
      Object.keys(zip.files).filter(
        (n) => n.replace(/\/$/, '').indexOf('/') === -1
      )
    ).toEqual(['My Report/']);
    expect(zip.file('My Report/My Report.xlsx')).not.toBeNull();
    expect(zip.file('My Report/IMG_1.jpg')).not.toBeNull();
  });

  it('derives the root folder from xlsxName when rootFolder is blank/absent', async () => {
    const ZE = loadExporter();

    const padded = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      rootFolder: '   ',
      photos: [],
    });
    const paddedZip = await JSZip.loadAsync(await padded.arrayBuffer());
    expect(paddedZip.file('Report/Report.xlsx')).not.toBeNull();

    const derived = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      photos: [],
    });
    const derivedZip = await JSZip.loadAsync(await derived.arrayBuffer());
    expect(derivedZip.file('Report/Report.xlsx')).not.toBeNull();
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
    // One local header per entry: the root folder, the workbook, the photos.
    expect(methods.length).toBeGreaterThanOrEqual(PHOTO_NAMES.length + 2);
    expect(methods.every((m) => m === 0)).toBe(true); // 0 = STORE

    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file(`${ROOT}/IMG_1.jpg`).async('string')).toBe('jpeg-1');
    expect(await zip.file(`${ROOT}/a b.jpg`).async('string')).toBe('jpeg-3');
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
    expect(zip.file(`${ROOT}/same.jpg`)).not.toBeNull();
    const photoEntries = Object.keys(zip.files).filter(
      (n) =>
        n.startsWith(`${ROOT}/`) && !zip.files[n].dir && !n.endsWith('.xlsx')
    );
    expect(photoEntries).toEqual([`${ROOT}/same.jpg`]);
    expect(await zip.file(`${ROOT}/same.jpg`).async('string')).toBe('second');
  });

  it('skips photo entries without a blob and survives an empty photo list', async () => {
    const ZE = loadExporter();
    const empty = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [],
    });
    const emptyZip = await JSZip.loadAsync(await empty.arrayBuffer());
    expect(emptyZip.file(`${ROOT}/Report.xlsx`)).not.toBeNull();
    // Even with zero photos there is NO loose entry at the archive root.
    const emptyTop = Object.keys(emptyZip.files).filter(
      (n) => n.replace(/\/$/, '').indexOf('/') === -1
    );
    expect(emptyTop.filter((n) => !emptyZip.files[n].dir)).toEqual([]);

    const partial = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([1]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [
        { originalName: 'ok.png', blob: jpegBytes('ok') },
        { originalName: 'broken.png', blob: null },
      ],
    });
    const partialZip = await JSZip.loadAsync(await partial.arrayBuffer());
    expect(partialZip.file(`${ROOT}/ok.jpg`)).not.toBeNull();
    expect(partialZip.file(`${ROOT}/broken.jpg`)).toBeNull();
  });

  // v23.0 — CLEAN ARCHIVE GUARANTEE. The archive is an explicit allowlist: the
  // workbook plus .jpg photos. The generated buffer is re-opened and its ENTIRE
  // file list checked, so a .txt / .json / .md / metadata entry can never sneak
  // back into the payload unnoticed.
  it('bundles ONLY the .xlsx report and .jpg photos (no .txt / .json / metadata)', async () => {
    const ZE = loadExporter();
    const blob = await ZE.buildZipBlob({
      xlsxBuffer: new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer,
      xlsxName: 'Report.xlsx',
      photos: [
        // Declared images — the normal path.
        { originalName: 'IMG_1.png', blob: jpegBytes('jpeg-1') },
        { originalName: 'a b.HEIC', blob: jpegBytes('jpeg-2') },
        // Adversarial names: a text/metadata payload must never reach the
        // archive under its own extension (the sanitizer forces .jpg).
        { originalName: 'notes.txt', blob: jpegBytes('notes') },
        { originalName: 'manifest.json', blob: jpegBytes('manifest') },
        { originalName: 'README.md', blob: jpegBytes('readme') },
      ],
    });

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

    // 1) No text / metadata extension survives anywhere in the archive.
    expect(
      entries.filter((n) =>
        /\.(txt|json|md|xml|csv|log|ini|yaml|yml|metadata)$/i.test(n)
      )
    ).toEqual([]);

    // 2) The entry set is EXACTLY the workbook plus one .jpg per photo.
    expect(entries.slice().sort()).toEqual(
      [
        `${ROOT}/Report.xlsx`,
        `${ROOT}/IMG_1.jpg`,
        `${ROOT}/a b.jpg`,
        `${ROOT}/notes.jpg`,
        `${ROOT}/manifest.jpg`,
        `${ROOT}/README.jpg`,
      ].sort()
    );

    // 3) Every non-workbook entry is an image, and nothing sits loose at the root.
    expect(
      entries.filter((n) => !n.endsWith('.xlsx')).every((n) => /\.jpg$/i.test(n))
    ).toBe(true);
    expect(
      entries.filter((n) => n.replace(/\/$/, '').indexOf('/') === -1)
    ).toEqual([]);

    // 4) The workbook payload is preserved byte-for-byte.
    expect(
      Array.from(await zip.file(`${ROOT}/Report.xlsx`).async('uint8array'))
    ).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});