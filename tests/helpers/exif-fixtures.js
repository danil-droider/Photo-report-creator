/**
 * exif-fixtures.js — hand-assembled JPEG/EXIF byte fixtures for the v8.2
 * capture-date tests.
 *
 * Everything is built from primitives (DataView + Uint8Array), so the fixtures
 * are readable, dependency-free and fully under the test control: no real
 * photo, no EXIF library, no network. The layout mirrors a genuine JPEG:
 *
 *   SOI | APP1 (Exif + NUL NUL + TIFF header + IFD0 [+ Exif IFD] + ASCII pool) | EOI
 *
 * Only the tags the parser cares about are emitted, in ascending tag order as
 * the TIFF spec requires:
 *   IFD0     0x0132 DateTime, 0x8769 ExifIFDPointer
 *   Exif IFD 0x9003 DateTimeOriginal, 0x9004 DateTimeDigitized
 */

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

const TIFF_HEADER_BYTES = 8;
const IFD_ENTRY_BYTES = 12;
const STAMP_BYTES = 20; // 19 characters plus the NUL terminator

export const EXIF_TAGS = {
  DATETIME: TAG_DATETIME,
  EXIF_IFD: TAG_EXIF_IFD,
  DATETIME_ORIGINAL: TAG_DATETIME_ORIGINAL,
  DATETIME_DIGITIZED: TAG_DATETIME_DIGITIZED,
};

/** A 20-byte, NUL-terminated ASCII date stamp. */
function stampBytes(text) {
  const out = new Uint8Array(STAMP_BYTES);
  const limit = Math.min(text.length, STAMP_BYTES - 1);
  for (let i = 0; i < limit; i++) out[i] = text.charCodeAt(i);
  return out;
}

function writeAsciiEntry(view, at, tag, dataOffset, little) {
  view.setUint16(at, tag, little);
  view.setUint16(at + 2, 2, little);            // ASCII
  view.setUint32(at + 4, STAMP_BYTES, little);  // count
  view.setUint32(at + 8, dataOffset, little);   // offset into the TIFF block
}

function writeLongEntry(view, at, tag, value, little) {
  view.setUint16(at, tag, little);
  view.setUint16(at + 2, 4, little);   // LONG
  view.setUint32(at + 4, 1, little);   // count
  view.setUint32(at + 8, value, little);
}

/**
 * Build a TIFF/Exif block.
 * @param {{endian?: string, dateTime?: string, dateTimeOriginal?: string,
 *          dateTimeDigitized?: string}} [opts]
 * @returns {Uint8Array}
 */
export function buildTiffBlock(opts = {}) {
  const little = opts.endian !== 'MM';

  const ifd0 = [];
  if (opts.dateTime) ifd0.push({ tag: TAG_DATETIME, text: opts.dateTime });
  const exif = [];
  if (opts.dateTimeOriginal) {
    exif.push({ tag: TAG_DATETIME_ORIGINAL, text: opts.dateTimeOriginal });
  }
  if (opts.dateTimeDigitized) {
    exif.push({ tag: TAG_DATETIME_DIGITIZED, text: opts.dateTimeDigitized });
  }
  const withPointer = exif.length > 0;
  if (withPointer) ifd0.push({ tag: TAG_EXIF_IFD });

  const ifd0Size = 2 + ifd0.length * IFD_ENTRY_BYTES + 4;
  const exifOffset = TIFF_HEADER_BYTES + ifd0Size;
  const exifSize = withPointer ? 2 + exif.length * IFD_ENTRY_BYTES + 4 : 0;

  // Every stamp lives after the IFDs; record each offset as it is assigned.
  let cursor = exifOffset + exifSize;
  const strings = [];
  const register = (text) => {
    const entry = { offset: cursor, bytes: stampBytes(text) };
    cursor += STAMP_BYTES;
    strings.push(entry);
    return entry.offset;
  };
  const ifd0Offsets = new Map();
  ifd0.forEach((entry) => {
    if (entry.text !== undefined) ifd0Offsets.set(entry.tag, register(entry.text));
  });
  const exifOffsets = new Map();
  exif.forEach((entry) => exifOffsets.set(entry.tag, register(entry.text)));

  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);

  // TIFF header
  view.setUint16(0, little ? 0x4949 : 0x4d4d, little);
  view.setUint16(2, 42, little);
  view.setUint32(4, TIFF_HEADER_BYTES, little);

  // IFD0
  view.setUint16(TIFF_HEADER_BYTES, ifd0.length, little);
  let at = TIFF_HEADER_BYTES + 2;
  ifd0.forEach((entry) => {
    if (entry.tag === TAG_EXIF_IFD) {
      writeLongEntry(view, at, TAG_EXIF_IFD, exifOffset, little);
    } else {
      writeAsciiEntry(view, at, entry.tag, ifd0Offsets.get(entry.tag), little);
    }
    at += IFD_ENTRY_BYTES;
  });
  view.setUint32(at, 0, little); // no next IFD

  // Exif sub-IFD
  if (withPointer) {
    view.setUint16(exifOffset, exif.length, little);
    let exifAt = exifOffset + 2;
    exif.forEach((entry) => {
      writeAsciiEntry(view, exifAt, entry.tag, exifOffsets.get(entry.tag), little);
      exifAt += IFD_ENTRY_BYTES;
    });
    view.setUint32(exifAt, 0, little);
  }

  strings.forEach((entry) => bytes.set(entry.bytes, entry.offset));
  return bytes;
}

/**
 * A complete JPEG whose APP1 segment carries the given EXIF block.
 * @returns {Uint8Array}
 */
export function jpegWithExif(opts = {}) {
  const tiff = buildTiffBlock(opts);
  const payload = new Uint8Array(6 + tiff.length);

  // Exif + two NUL bytes, then the TIFF block.
  const signature = 'Exif';
  for (let i = 0; i < signature.length; i++) payload[i] = signature.charCodeAt(i);
  payload[4] = 0;
  payload[5] = 0;
  payload.set(tiff, 6);

  const out = new Uint8Array(8 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xffd8);              // SOI
  view.setUint8(2, 0xff);
  view.setUint8(3, 0xe1);                 // APP1
  view.setUint16(4, payload.length + 2);  // segment length, big-endian
  out.set(payload, 6);
  view.setUint8(out.length - 2, 0xff);    // EOI
  view.setUint8(out.length - 1, 0xd9);
  return out;
}

/** A valid JPEG that simply has no EXIF segment. */
export function jpegWithoutExif() {
  // SOI | COM (length 4, two payload bytes) | EOI
  return new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x41, 0x42, 0xff, 0xd9]);
}

/** The EXIF JPEG cut off mid-APP1, so the declared length overruns the buffer. */
export function truncatedExif(opts = {}) {
  return jpegWithExif(opts).slice(0, 12);
}

/** A PNG signature - not a JPEG at all. */
export function notAJpeg() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}
