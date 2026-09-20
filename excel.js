/**
 * excel.js — Stage 2 (Excel writing)
 *
 * Takes the PRE-COMPUTED layout data and writes it into a new workbook via
 * ExcelJS. Photos are placed as absolute-positioned floating shapes over an
 * untouched grid (default column widths and row heights).
 *
 * STRICT CONSTRAINT: ZERO repositioning or coordinate-calculation logic is
 * allowed here. This module consumes the X/Y/W/H values it is given as-is.
 * The only transform is a fixed px -> EMU unit conversion (plus splitting
 * that EMU position into an anchor cell + a bounded in-cell offset), which
 * is a serialization detail of the OOXML drawing coordinate system - not a
 * repositioning of the photo.
 */
(function (global) {
  'use strict';

  const EMU_PER_PIXEL = 9525; // 1 px = 9525 EMU at 96 DPI.

  // Excel's native default cell geometry (used ONLY to encode an absolute
  // EMU position as an anchor cell + a bounded in-cell offset):
  const DEFAULT_COL_PX = 64; // default column width = 8.43 chars = 64 px
  const DEFAULT_ROW_PX = 20; // default row height = 15 pt = 20 px
  const COL_EMU = DEFAULT_COL_PX * EMU_PER_PIXEL; // 609,600 EMU
  const ROW_EMU = DEFAULT_ROW_PX * EMU_PER_PIXEL; // 190,500 EMU

  const SHEET_NAME = 'Photo Report';

  function blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error('Failed to read image blob.'));
      reader.readAsArrayBuffer(blob);
    });
  }

  /**
   * Convert an absolute pixel position into a spreadsheet anchor: a cell
   * (nativeCol/nativeRow) plus an in-cell EMU offset (nativeColOff/
   * nativeRowOff) that is always within [0, cellSize). Keeping the offsets
   * in range avoids the out-of-cell overflow that Excel would otherwise
   * misposition (the original cause of overlapping photos).
   */
  function toCellAnchor(xPx, yPx) {
    const xEmu = Math.round(xPx * EMU_PER_PIXEL);
    const yEmu = Math.round(yPx * EMU_PER_PIXEL);

    return {
      nativeCol: Math.floor(xEmu / COL_EMU),
      nativeColOff: xEmu % COL_EMU,
      nativeRow: Math.floor(yEmu / ROW_EMU),
      // The vertical safety gap added between rows in Stage 1 (layout.js)
      // is already contained in yPx, so it flows through here as-is in EMU.
      nativeRowOff: yEmu % ROW_EMU
    };
  }

  /**
   * buildExcelWorkbook
   *
   * Writes each photo as an absolute floating image at the exact pixel
   * coordinates computed in Stage 1 (layout.js). The worksheet grid is left
   * at its native defaults — no column widths or row heights are touched.
   *
   * v10.0 ORDER CONTRACT: images are registered and placed strictly in
   * layout-array order, so the drawing layer reproduces the visual sequence
   * (index 0 = top-left / oldest, index N = bottom-right / newest). No sorting
   * and no secondary grouping (e.g. by orientation or dimensions) may ever be
   * introduced between the array and the worksheet.
   *
   * @param {Array} layoutData - [{ blob, x, y, width, height }, ...]
   * @returns {Promise<Uint8Array|ArrayBuffer>} the .xlsx file buffer.
   */
  async function buildExcelWorkbook(layoutData) {
    if (typeof ExcelJS === 'undefined') {
      throw new Error('ExcelJS (CDN) is not loaded.');
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(SHEET_NAME);

    const items = Array.isArray(layoutData) ? layoutData : [];

    for (const item of items) {
      const buffer = await blobToArrayBuffer(item.blob);

      // Register the JPEG with the workbook; returns an index for placement.
      const imageId = workbook.addImage({ buffer: buffer, extension: 'jpeg' });

      // Absolute floating shape over the default grid, anchored to the
      // correct cell with a bounded in-cell offset. Zero repositioning
      // logic here — the pixel coordinate is consumed as-is.
      worksheet.addImage(imageId, {
        tl: toCellAnchor(item.x, item.y),
        ext: {
          width: item.width,
          height: item.height
        },
        editAs: 'absolute'
      });
    }

    return workbook.xlsx.writeBuffer();
  }

  global.ExcelWriter = { buildExcelWorkbook: buildExcelWorkbook };
})(window);
