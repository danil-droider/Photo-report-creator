/**
 * excel-order.test.js — Stage 2 insertion-order contract (v10.0).
 *
 * Stage 1 guarantees that layout-array index 0 is the top-left (oldest) photo
 * and index N is the bottom-right (newest) one. This suite proves Stage 2 does
 * NOT disturb that: buildExcelWorkbook() registers and places every image in
 * strict array order, so the Excel drawing layer receives the photos in exactly
 * the sequence the main screen shows them — no grouping by orientation or
 * dimensions, no re-sorting by coordinates.
 *
 * The real buildExcelWorkbook() is driven against a spy ExcelJS workbook (the
 * pattern established in excel-anchor.test.js), so no .xlsx is unzipped here.
 * Layout data comes from the real layout.js, so both stages are exercised
 * end-to-end at the data level.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

const EMU_PER_PIXEL = 9525;
const COL_EMU = 64 * EMU_PER_PIXEL; // default column = 64 px
const ROW_EMU = 20 * EMU_PER_PIXEL; // default row = 20 px

const flatX = (tl) => tl.nativeCol * COL_EMU + tl.nativeColOff;
const flatY = (tl) => tl.nativeRow * ROW_EMU + tl.nativeRowOff;

function makeFakeExcelJS() {
  const calls = [];
  const workbooks = [];

  class FakeWorksheet {
    addImage(imageId, options) {
      calls.push({ imageId, ...options });
    }
  }

  class FakeWorkbook {
    constructor() {
      this.images = []; // registration order: workbook.addImage() returns i+1
      this.sheets = [];
      workbooks.push(this);
      this.xlsx = {
        writeBuffer: async () => new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      };
    }
    addWorksheet(name) {
      this.sheets.push(name);
      return new FakeWorksheet();
    }
    addImage(data) {
      this.images.push(data);
      return this.images.length;
    }
  }

  return { ExcelJS: { Workbook: FakeWorkbook }, calls, workbooks };
}

/** A JPEG-ish blob whose third byte IS the photo's index in the array. */
function markerBlob(marker) {
  return new Blob([new Uint8Array([0xff, 0xd8, marker, 0xe0]).buffer], {
    type: 'image/jpeg',
  });
}

function bytesOf(raw) {
  if (raw && raw.buffer) {
    return new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
  }
  return new Uint8Array(raw);
}

async function withWorkbook(fn) {
  const fake = makeFakeExcelJS();
  vi.stubGlobal('ExcelJS', fake.ExcelJS);
  const win = {};
  loadWindiModule(win, 'excel.js');
  try {
    return await fn(win.ExcelWriter, fake);
  } finally {
    vi.unstubAllGlobals();
  }
}

function freezeRandom() {
  vi.spyOn(Math, 'random').mockReturnValue(0);
}

/**
 * Real Stage 1 output for `count` photos, with a marker blob per entry so the
 * insertion order can be read straight out of the fake workbook afterwards.
 */
function buildLayout(count, options = { columns: 3 }) {
  freezeRandom();
  const layoutWin = {};
  loadWindiModule(layoutWin, 'layout.js');

  const photos = Array.from({ length: count }, (_, i) => ({
    id: i,
    originalName: `Photo_${i}`,
    width: 600 + (i % 3) * 100,
    height: 800,
  }));

  return layoutWin.Layout.calculateLayout(photos, options).map((entry) => ({
    ...entry,
    blob: markerBlob(entry.id),
  }));
}

describe('ExcelWriter.buildExcelWorkbook — v10.0 insertion order', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers and places images in layout-array order, index 0 first', async () => {
    const layout = buildLayout(8);
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(layout);

      // One addImage() per entry, called in array order: ids 1..N ascending.
      expect(fake.calls).toHaveLength(layout.length);
      expect(fake.calls.map((call) => call.imageId)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);

      // ...and the blobs handed to the workbook carry index 0, 1, 2, ... in
      // exactly that order — proof that nothing was re-sorted in between.
      expect(
        fake.workbooks[0].images.map((image) => bytesOf(image.buffer)[2])
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(fake.workbooks[0].sheets).toEqual(['Photo Report']);
    });
  });

  it('maps each layout index onto its own row-major anchor', async () => {
    const layout = buildLayout(6, { columns: 3 });
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(layout);

      // The i-th placement IS the i-th layout entry, serialized as-is.
      layout.forEach((entry, i) => {
        const tl = fake.calls[i].tl;
        expect(flatX(tl)).toBe(entry.x * EMU_PER_PIXEL);
        expect(flatY(tl)).toBe(entry.y * EMU_PER_PIXEL);
      });

      // Row-major walk: right within a row, then down to the next row's left.
      for (let i = 1; i < layout.length; i++) {
        const prev = layout[i - 1];
        const cur = layout[i];
        const prevTl = fake.calls[i - 1].tl;
        const curTl = fake.calls[i].tl;

        if (cur.y === prev.y) {
          expect(flatX(curTl)).toBeGreaterThan(flatX(prevTl));
          expect(flatY(curTl)).toBe(flatY(prevTl));
        } else {
          expect(cur.y).toBeGreaterThan(prev.y);
          expect(flatY(curTl)).toBeGreaterThan(flatY(prevTl));
          expect(flatX(curTl)).toBe(0); // wrapped back to the left origin
        }
      }

      // The anchors are distinct: no two photos collapse onto one another.
      const keys = fake.calls.map(
        (call) => `${flatX(call.tl)}:${flatY(call.tl)}`
      );
      expect(new Set(keys).size).toBe(layout.length);
    });
  });

  it('never re-sorts by coordinates — array order wins even when x/y descend', async () => {
    // Deliberately "wrong" coordinates (newest-first positions). Stage 2 must
    // consume them in array order regardless: no repositioning is allowed here.
    const items = [0, 1, 2].map((id) => ({
      id,
      originalName: `Photo_${id}`,
      blob: markerBlob(id),
      x: 2000 - id * 800,
      y: 900 - id * 300,
      width: 378,
      height: 378,
    }));

    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items);

      expect(fake.calls.map((call) => call.imageId)).toEqual([1, 2, 3]);
      expect(
        fake.workbooks[0].images.map((image) => bytesOf(image.buffer)[2])
      ).toEqual([0, 1, 2]);
      expect(fake.calls.map((call) => flatX(call.tl))).toEqual(
        items.map((item) => item.x * EMU_PER_PIXEL)
      );
    });
  });

  it('keeps absolute floating shapes over the untouched default grid', async () => {
    const layout = buildLayout(5, { columns: 2 });
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(layout);

      fake.calls.forEach((call, i) => {
        expect(call.editAs).toBe('absolute');
        expect(call.ext).toEqual({
          width: layout[i].width,
          height: layout[i].height,
        });
        expect(call.tl.nativeColOff).toBeLessThan(COL_EMU);
        expect(call.tl.nativeRowOff).toBeLessThan(ROW_EMU);
      });
    });
  });

  it('handles a single photo at the top-left anchor (index 0 case)', async () => {
    const layout = buildLayout(1, { columns: 2 });
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(layout);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].tl).toEqual({
        nativeCol: 0,
        nativeColOff: 0,
        nativeRow: 0,
        nativeRowOff: 0,
      });
    });
  });
});
