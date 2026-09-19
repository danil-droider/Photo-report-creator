/**
 * excel-anchor.test.js — Stage 2 serialization math, verified fast.
 *
 * toCellAnchor() is private inside excel.js, so the real buildExcelWorkbook()
 * is driven against a spy ExcelJS workbook that captures every
 * addImage(imageId, { tl, ext, editAs }) call. This pins the v6.0 overlap fix
 * (EMU cell anchoring with bounded in-cell offsets) without unzipping a real
 * .xlsx — that deeper check stays in _selftest Phase 3.
 *
 * Reference values (1 px = 9525 EMU; default grid = 64 px per column,
 * 20 px per row):
 *   x=0,   y=0   -> cell (0,0), offset (0,0)
 *   x=64,  y=20  -> cell (1,1), offset (0,0)      (exactly one cell)
 *   x=506, y=395 -> cell (7,19), offset (552450, 142875)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadWindiModule } from '../helpers/window-shim.js';

const EMU_PER_PIXEL = 9525;
const COL_EMU = 64 * EMU_PER_PIXEL;
const ROW_EMU = 20 * EMU_PER_PIXEL;

function makeFakeExcelJS() {
  const calls = [];
  const writeBufferCalls = { count: 0 };
  const workbooks = [];

  class FakeWorksheet {
    addImage(imageId, options) {
      calls.push({ imageId, ...options });
    }
  }

  class FakeWorkbook {
    constructor() {
      this.images = [];
      this.sheets = [];
      workbooks.push(this);
      this.xlsx = {
        writeBuffer: async () => {
          writeBufferCalls.count += 1;
          return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        },
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

  return {
    ExcelJS: { Workbook: FakeWorkbook },
    calls,
    writeBufferCalls,
    workbooks,
  };
}

function makeBlob() {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer], {
    type: 'image/jpeg',
  });
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

const items = (xs) =>
  xs.map(({ x, y, width = 504, height = 378 }) => ({
    blob: makeBlob(),
    x,
    y,
    width,
    height,
  }));

describe('ExcelWriter.buildExcelWorkbook — cell anchoring (v6.0 fix)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('anchors pixel (0,0) at cell (0,0) with a zero in-cell offset', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items([{ x: 0, y: 0 }]));
      expect(fake.calls[0].tl).toEqual({
        nativeCol: 0,
        nativeColOff: 0,
        nativeRow: 0,
        nativeRowOff: 0,
      });
    });
  });

  it('maps exact cell-boundary pixels (64 px, 20 px) onto the next cell', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items([{ x: 64, y: 20 }]));
      expect(fake.calls[0].tl).toEqual({
        nativeCol: 1,
        nativeColOff: 0,
        nativeRow: 1,
        nativeRowOff: 0,
      });
    });
  });

  it('anchors the golden layout coordinates at the expected cells', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items([{ x: 506, y: 395 }]));
      expect(fake.calls[0].tl).toEqual({
        nativeCol: 7,
        nativeColOff: 506 * EMU_PER_PIXEL - 7 * COL_EMU, // 552450
        nativeRow: 19,
        nativeRowOff: 395 * EMU_PER_PIXEL - 19 * ROW_EMU, // 142875
      });
      expect(fake.calls[0].tl.nativeColOff).toBe(552450);
      expect(fake.calls[0].tl.nativeRowOff).toBe(142875);
    });
  });

  it('is monotonic: a larger x/y never lands on a smaller anchor', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(
        items([
          { x: 100, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 300 },
        ])
      );
      const [a, b, c] = fake.calls.map((call) => call.tl);
      const flat = (t) => t.nativeCol * COL_EMU + t.nativeColOff;
      const flatY = (t) => t.nativeRow * ROW_EMU + t.nativeRowOff;
      expect(flat(b)).toBeGreaterThan(flat(a));
      expect(flatY(c)).toBeGreaterThan(flatY(b));
    });
  });
});

describe('ExcelWriter.buildExcelWorkbook — architectural constraints', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes every photo as an absolute floating shape (editAs: absolute)', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items([{ x: 0, y: 0 }, { x: 506, y: 0 }]));
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls.every((call) => call.editAs === 'absolute')).toBe(true);
    });
  });

  it('consumes Stage 1 dimensions verbatim — zero repositioning', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(
        items([{ x: 10, y: 20, width: 284, height: 378 }])
      );
      expect(fake.calls[0].ext).toEqual({ width: 284, height: 378 });
    });
  });

  it('keeps every in-cell offset inside [0, cellSize) across a pixel sweep', async () => {
    await withWorkbook(async (writer, fake) => {
      const xs = [0, 1, 63, 64, 65, 128, 506, 1000, 1500, 2000];
      const ys = [0, 1, 19, 20, 21, 40, 395, 800, 1200];
      const list = [];
      for (const x of xs) {
        for (const y of ys) list.push({ x, y });
      }
      await writer.buildExcelWorkbook(items(list));

      expect(fake.calls).toHaveLength(list.length);
      for (const call of fake.calls) {
        expect(call.tl.nativeCol).toBeGreaterThanOrEqual(0);
        expect(call.tl.nativeRow).toBeGreaterThanOrEqual(0);
        expect(call.tl.nativeColOff).toBeGreaterThanOrEqual(0);
        expect(call.tl.nativeColOff).toBeLessThan(COL_EMU);
        expect(call.tl.nativeRowOff).toBeGreaterThanOrEqual(0);
        expect(call.tl.nativeRowOff).toBeLessThan(ROW_EMU);
      }
    });
  });

  it('uses the Photo Report sheet and buffers one image per item', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook(items([{ x: 0, y: 0 }, { x: 506, y: 0 }]));
      expect(fake.workbooks[0].sheets).toEqual(['Photo Report']);
      expect(fake.workbooks[0].images).toHaveLength(2);
      expect(fake.writeBufferCalls.count).toBe(1);
    });
  });

  it('tolerates an empty or non-array layout (empty workbook, no throw)', async () => {
    await withWorkbook(async (writer, fake) => {
      await writer.buildExcelWorkbook([]);
      await writer.buildExcelWorkbook(undefined);
      await writer.buildExcelWorkbook('nope');
      expect(fake.writeBufferCalls.count).toBe(3);
      expect(fake.workbooks[0].images).toHaveLength(0);
    });
  });

  it('rejects with a clear error when ExcelJS (CDN) is not loaded', async () => {
    const win = {};
    loadWindiModule(win, 'excel.js');
    await expect(
      win.ExcelWriter.buildExcelWorkbook(items([{ x: 0, y: 0 }]))
    ).rejects.toThrow('ExcelJS (CDN) is not loaded.');
  });
});
