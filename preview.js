/**
 * preview.js — Desktop Excel visual preview (introduced in app v27.0)
 *
 * Renders the ALREADY-CALCULATED Stage 1 layout over a simulated Excel sheet,
 * so the user can inspect gaps, alignment and row wrapping before exporting.
 *
 * STRICT SEPARATION:
 *   - It NEVER calls Layout.calculateLayout(): re-running Stage 1 would reroll
 *     the randomized gaps and the preview could disagree with the export.
 *   - It NEVER touches ExcelWriter or writes workbook geometry.
 *   - It only consumes the plain { x, y, width, height } rectangles produced by
 *     Stage 1 and stored in app state.
 *
 * Rendering is DOM/CSS only (absolute-positioned images over a CSS-gradient
 * grid). A full-sheet canvas would need a large iOS bitmap, while DOM images
 * reuse the normalized compressed blobs and let the browser scale them.
 *
 * Pure functions (createModel / getColumnName / calculateFitScale / zoomAtPoint
 * / clampScale) are DOM-free and unit tested in plain Node.
 */
(function (global) {
  'use strict';

  const VERSION = 'v1.0';

  // Excel's native default grid geometry — must match excel.js.
  const CELL_WIDTH_PX = 64;
  const CELL_HEIGHT_PX = 20;

  // Worksheet chrome dimensions (app-owned UI, not Excel geometry).
  const ROW_HEADER_WIDTH = 44;
  const COLUMN_HEADER_HEIGHT = 24;

  // 20 x 36 default cells = 1280 x 720 px, a 16:9 desktop baseline. The sheet
  // grows beyond this whenever the layout bounds need more room.
  const MIN_COLUMNS = 20;
  const MIN_ROWS = 36;

  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 1.25;
  const MIN_FIT_SCALE = 0.01;

  // Used when the viewport cannot be measured (jsdom, a hidden modal, etc.).
  const FALLBACK_VIEWPORT_WIDTH = 1024;
  const FALLBACK_VIEWPORT_HEIGHT = 600;

  function toFiniteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clampScale(scale, minScale, maxScale) {
    const min = toFiniteNumber(minScale, MIN_ZOOM);
    const max = Math.max(min, toFiniteNumber(maxScale, MAX_ZOOM));
    const value = toFiniteNumber(scale, min);
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Excel-style column label: 0 -> A, 25 -> Z, 26 -> AA.
   * @param {number} index
   * @returns {string}
   */
  function getColumnName(index) {
    let n = Math.floor(toFiniteNumber(index, 0));
    if (!Number.isFinite(n) || n < 0) n = 0;
    let name = '';
    n += 1;
    while (n > 0) {
      const remainder = (n - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  /**
   * Fit scale for a virtual sheet inside a viewport.
   * Never exceeds 1, so opening the preview cannot magnify a small sheet.
   */
  function calculateFitScale(sheetSize, viewportSize) {
    const sheetWidth = toFiniteNumber(sheetSize && sheetSize.width, 0);
    const sheetHeight = toFiniteNumber(sheetSize && sheetSize.height, 0);
    const viewportWidth = toFiniteNumber(viewportSize && viewportSize.width, 0);
    const viewportHeight = toFiniteNumber(viewportSize && viewportSize.height, 0);

    if (sheetWidth <= 0 || sheetHeight <= 0) return 1;
    if (viewportWidth <= 0 || viewportHeight <= 0) return 1;

    const fit = Math.min(
      viewportWidth / sheetWidth,
      viewportHeight / sheetHeight,
      1
    );
    return clampScale(fit, MIN_FIT_SCALE, 1);
  }

  /**
   * Pure focal zoom: the worksheet point currently under `point` stays under
   * `point` after the scale change. Used by both buttons and pinch zoom.
   *
   * @param {{scale:number,scrollLeft:number,scrollTop:number}} viewState
   * @param {number} nextScale
   * @param {{x:number,y:number}} point viewport-relative coordinates
   * @param {{min:number,max:number}} [limits]
   */
  function zoomAtPoint(viewState, nextScale, point, limits) {
    const oldScale = toFiniteNumber(viewState && viewState.scale, 1) || 1;
    const minScale = limits ? limits.min : MIN_ZOOM;
    const maxScale = limits ? limits.max : MAX_ZOOM;
    const scale = clampScale(nextScale, minScale, maxScale);
    const px = toFiniteNumber(point && point.x, 0);
    const py = toFiniteNumber(point && point.y, 0);
    const scrollLeft = toFiniteNumber(viewState && viewState.scrollLeft, 0);
    const scrollTop = toFiniteNumber(viewState && viewState.scrollTop, 0);

    const contentX = (scrollLeft + px) / oldScale;
    const contentY = (scrollTop + py) / oldScale;

    return {
      scale: scale,
      scrollLeft: contentX * scale - px,
      scrollTop: contentY * scale - py
    };
  }

  /** Sanitize one Stage 1 rectangle. Geometry is preserved as-is. */
  function normalizeRect(entry, index) {
    if (!entry || typeof entry !== 'object') return null;

    const x = toFiniteNumber(entry.x, 0);
    const y = toFiniteNumber(entry.y, 0);
    const width = toFiniteNumber(entry.width, 0);
    const height = toFiniteNumber(entry.height, 0);
    if (width <= 0 || height <= 0) return null;

    return {
      id: entry.id === undefined ? index : entry.id,
      originalName:
        entry.originalName === undefined ? '' : String(entry.originalName),
      blob: entry.blob || null,
      x: Math.max(0, x),
      y: Math.max(0, y),
      width: width,
      height: height
    };
  }

  /**
   * Build the DOM-free preview model from Stage 1 rectangles.
   *
   * The model carries the minimum 1280 x 720 desktop sheet, expands it to the
   * real layout bounds, and reports the fit scale for the given viewport.
   */
  function createModel(layout, viewportSize) {
    const entries = Array.isArray(layout) ? layout : [];
    const rects = [];

    for (let i = 0; i < entries.length; i++) {
      const rect = normalizeRect(entries[i], i);
      if (rect) rects.push(rect);
    }

    let maxRight = 0;
    let maxBottom = 0;
    for (let i = 0; i < rects.length; i++) {
      maxRight = Math.max(maxRight, rects[i].x + rects[i].width);
      maxBottom = Math.max(maxBottom, rects[i].y + rects[i].height);
    }

    // One spare row/column keeps the last photo visually inside the grid.
    const spare = rects.length > 0 ? 1 : 0;
    const columns = Math.max(
      MIN_COLUMNS,
      Math.ceil(maxRight / CELL_WIDTH_PX) + spare
    );
    const rows = Math.max(
      MIN_ROWS,
      Math.ceil(maxBottom / CELL_HEIGHT_PX) + spare
    );

    const sheetWidth = columns * CELL_WIDTH_PX;
    const sheetHeight = rows * CELL_HEIGHT_PX;
    const totalWidth = ROW_HEADER_WIDTH + sheetWidth;
    const totalHeight = COLUMN_HEADER_HEIGHT + sheetHeight;
    const fitScale = calculateFitScale(
      { width: totalWidth, height: totalHeight },
      viewportSize
    );

    return {
      cellWidth: CELL_WIDTH_PX,
      cellHeight: CELL_HEIGHT_PX,
      rowHeaderWidth: ROW_HEADER_WIDTH,
      columnHeaderHeight: COLUMN_HEADER_HEIGHT,
      columns: columns,
      rows: rows,
      sheetWidth: sheetWidth,
      sheetHeight: sheetHeight,
      totalWidth: totalWidth,
      totalHeight: totalHeight,
      fitScale: fitScale,
      minScale: Math.min(fitScale, MIN_ZOOM),
      maxScale: MAX_ZOOM,
      rects: rects
    };
  }


  // --- DOM rendering and interaction -----------------------------------------
  let refs = null;
  let openState = false;
  let model = null;
  let scale = 1;
  let sourceLayout = [];
  let previewUrls = [];
  let returnFocusEl = null;
  let panState = null;
  let pinchState = null;

  function measureViewport() {
    const width = refs && refs.viewport ? refs.viewport.clientWidth : 0;
    const height = refs && refs.viewport ? refs.viewport.clientHeight : 0;
    return {
      width: width > 0 ? width : FALLBACK_VIEWPORT_WIDTH,
      height: height > 0 ? height : FALLBACK_VIEWPORT_HEIGHT
    };
  }

  function viewportCenter() {
    const size = measureViewport();
    return { x: size.width / 2, y: size.height / 2 };
  }

  function createPreviewUrl(blob) {
    if (!blob || typeof URL === 'undefined') return null;
    if (typeof URL.createObjectURL !== 'function') return null;
    try {
      return URL.createObjectURL(blob);
    } catch (err) {
      return null;
    }
  }

  function releaseUrls() {
    const urls = previewUrls;
    previewUrls = [];
    if (
      typeof URL === 'undefined' ||
      typeof URL.revokeObjectURL !== 'function'
    ) {
      return;
    }
    urls.forEach((url) => {
      if (!url) return;
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        /* best-effort cleanup */
      }
    });
  }

  function createPhotoPlaceholder(rect) {
    const box = document.createElement('div');
    box.className = 'preview-photo preview-photo-placeholder';
    box.style.left = rect.x + 'px';
    box.style.top = rect.y + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.textContent = '\u{1F4F7}';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', rect.originalName || 'Photo placeholder');
    return box;
  }

  function buildPhotos(rects) {
    const fragment = document.createDocumentFragment();

    rects.forEach((rect) => {
      const url = createPreviewUrl(rect.blob);
      if (!url) {
        fragment.appendChild(createPhotoPlaceholder(rect));
        return;
      }

      previewUrls.push(url);
      const img = document.createElement('img');
      img.className = 'preview-photo';
      img.style.left = rect.x + 'px';
      img.style.top = rect.y + 'px';
      img.style.width = rect.width + 'px';
      img.style.height = rect.height + 'px';
      img.alt = rect.originalName || 'Photo';
      img.decoding = 'async';
      img.draggable = false;
      img.onerror = function () {
        if (img.parentNode) {
          img.parentNode.replaceChild(createPhotoPlaceholder(rect), img);
        }
      };
      img.src = url;
      fragment.appendChild(img);
    });

    return fragment;
  }

  function buildColumnHeaders(previewModel) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < previewModel.columns; i++) {
      const label = document.createElement('span');
      label.className = 'preview-col-label';
      // Column A starts after the row-header rail, exactly where the grid does.
      label.style.left =
        previewModel.rowHeaderWidth + i * previewModel.cellWidth + 'px';
      label.style.width = previewModel.cellWidth + 'px';
      label.textContent = getColumnName(i);
      fragment.appendChild(label);
    }
    return fragment;
  }

  function buildRowHeaders(previewModel) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < previewModel.rows; i++) {
      const label = document.createElement('span');
      label.className = 'preview-row-label';
      // Row 1 starts below the column-header rail, exactly where the grid does.
      label.style.top =
        previewModel.columnHeaderHeight + i * previewModel.cellHeight + 'px';
      label.style.height = previewModel.cellHeight + 'px';
      label.textContent = String(i + 1);
      fragment.appendChild(label);
    }
    return fragment;
  }


  function renderSheet(previewModel) {
    if (!refs || !previewModel) return;

    refs.stage.style.width = previewModel.totalWidth + 'px';
    refs.stage.style.height = previewModel.totalHeight + 'px';

    refs.grid.style.left = previewModel.rowHeaderWidth + 'px';
    refs.grid.style.top = previewModel.columnHeaderHeight + 'px';
    refs.grid.style.width = previewModel.sheetWidth + 'px';
    refs.grid.style.height = previewModel.sheetHeight + 'px';
    refs.grid.style.backgroundSize =
      previewModel.cellWidth + 'px ' + previewModel.cellHeight + 'px';

    refs.columnHeaders.style.width = previewModel.totalWidth + 'px';
    refs.columnHeaders.style.height = previewModel.columnHeaderHeight + 'px';
    refs.rowHeaders.style.width = previewModel.rowHeaderWidth + 'px';
    refs.rowHeaders.style.height = previewModel.totalHeight + 'px';

    refs.columnHeaders.replaceChildren(buildColumnHeaders(previewModel));
    refs.rowHeaders.replaceChildren(buildRowHeaders(previewModel));
    refs.photos.replaceChildren(buildPhotos(previewModel.rects));
  }

  function applyScale(nextScale, focalPoint) {
    if (!refs || !model) return;

    const current = {
      scale: scale,
      scrollLeft: refs.viewport.scrollLeft || 0,
      scrollTop: refs.viewport.scrollTop || 0
    };
    const next = zoomAtPoint(
      current,
      nextScale,
      focalPoint || viewportCenter(),
      { min: model.minScale, max: model.maxScale }
    );

    scale = next.scale;
    refs.stage.style.transform = 'scale(' + scale + ')';
    refs.scrollContent.style.width = model.totalWidth * scale + 'px';
    refs.scrollContent.style.height = model.totalHeight * scale + 'px';
    refs.viewport.scrollLeft = next.scrollLeft;
    refs.viewport.scrollTop = next.scrollTop;

    if (refs.zoomLabel) {
      refs.zoomLabel.textContent = Math.round(scale * 100) + '%';
    }
  }

  function clearRendered() {
    if (refs.photos) {
      Array.prototype.forEach.call(
        refs.photos.querySelectorAll('img'),
        (img) => {
          img.onerror = null;
          img.removeAttribute('src');
        }
      );
      refs.photos.replaceChildren();
    }
    if (refs.columnHeaders) refs.columnHeaders.replaceChildren();
    if (refs.rowHeaders) refs.rowHeaders.replaceChildren();
  }

  /**
   * Open the preview with the EXACT rectangles already stored by runLayout().
   * @param {Array<{x:number,y:number,width:number,height:number,blob?:Blob}>} layout
   * @returns {boolean} true when the modal opened.
   */
  function open(layout) {
    if (!refs || !refs.modal) return false;
    if (openState) close();

    sourceLayout = Array.isArray(layout) ? layout.slice() : [];
    returnFocusEl = document.activeElement || null;
    openState = true;

    refs.modal.hidden = false;
    if (document.body) document.body.classList.add('preview-open');
    refs.viewport.scrollLeft = 0;
    refs.viewport.scrollTop = 0;

    model = createModel(sourceLayout, measureViewport());
    scale = model.fitScale;
    renderSheet(model);
    applyScale(model.fitScale);

    if (refs.closeBtn && typeof refs.closeBtn.focus === 'function') {
      refs.closeBtn.focus();
    }
    return true;
  }

  /** Close the modal, clear its DOM and release every preview-owned URL. */
  function close() {
    if (!openState) return;

    openState = false;
    clearRendered();
    releaseUrls();

    if (refs && refs.modal) refs.modal.hidden = true;
    if (document.body) document.body.classList.remove('preview-open');

    model = null;
    sourceLayout = [];
    scale = 1;
    panState = null;
    pinchState = null;

    if (
      returnFocusEl &&
      returnFocusEl.isConnected &&
      typeof returnFocusEl.focus === 'function'
    ) {
      returnFocusEl.focus();
    }
    returnFocusEl = null;
  }

  function isOpen() {
    return openState;
  }


  function onBackdropClick(event) {
    if (refs && event.target === refs.modal) close();
  }

  function onKeydown(event) {
    if (!openState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  function zoomIn() {
    if (!openState || !model) return;
    applyScale(scale * ZOOM_STEP, viewportCenter());
  }

  function zoomOut() {
    if (!openState || !model) return;
    applyScale(scale / ZOOM_STEP, viewportCenter());
  }

  function fit() {
    if (!openState || !model) return;
    applyScale(model.fitScale, viewportCenter());
  }

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function touchMidpoint(touches) {
    const rect =
      refs && refs.viewport && refs.viewport.getBoundingClientRect
        ? refs.viewport.getBoundingClientRect()
        : { left: 0, top: 0 };
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top
    };
  }

  function onTouchStart(event) {
    if (!openState || !model || !refs.viewport) return;

    if (event.touches.length >= 2) {
      pinchState = {
        distance: touchDistance(event.touches),
        scale: scale
      };
      panState = null;
    } else if (event.touches.length === 1) {
      panState = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        scrollLeft: refs.viewport.scrollLeft || 0,
        scrollTop: refs.viewport.scrollTop || 0
      };
      pinchState = null;
    }

    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  function onTouchMove(event) {
    if (!openState || !model || !refs.viewport) return;

    if (event.touches.length >= 2 && pinchState) {
      const distance = touchDistance(event.touches);
      if (pinchState.distance > 0) {
        const nextScale = pinchState.scale * (distance / pinchState.distance);
        applyScale(nextScale, touchMidpoint(event.touches));
      }
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      return;
    }

    if (panState && event.touches.length === 1) {
      const touch = event.touches[0];
      refs.viewport.scrollLeft =
        panState.scrollLeft - (touch.clientX - panState.x);
      refs.viewport.scrollTop =
        panState.scrollTop - (touch.clientY - panState.y);
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
    }
  }

  function onTouchEnd(event) {
    if (!event.touches || event.touches.length === 0) {
      panState = null;
      pinchState = null;
    } else if (event.touches.length === 1) {
      panState = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
        scrollLeft: refs.viewport.scrollLeft || 0,
        scrollTop: refs.viewport.scrollTop || 0
      };
      pinchState = null;
    }
  }

  function onWheel(event) {
    if (!openState || !model || !refs.viewport) return;
    if (!event.ctrlKey && !event.metaKey) return;

    event.preventDefault();
    const rect = refs.viewport.getBoundingClientRect
      ? refs.viewport.getBoundingClientRect()
      : { left: 0, top: 0 };
    const focal = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    applyScale(scale * factor, focal);
  }

  function onResize() {
    if (!openState || !model) return;
    model = createModel(model.rects, measureViewport());
    applyScale(Math.min(scale, model.maxScale), viewportCenter());
  }


  /**
   * Bind the modal once. app.js owns opening/closing through open()/close().
   * @param {object} elements DOM references cached by app.cacheDom().
   */
  function init(elements) {
    if (!elements || !elements.modal || !elements.viewport) return false;
    refs = elements;

    refs.modal.addEventListener('click', onBackdropClick);
    if (refs.closeBtn) refs.closeBtn.addEventListener('click', close);
    if (refs.zoomInBtn) refs.zoomInBtn.addEventListener('click', zoomIn);
    if (refs.zoomOutBtn) refs.zoomOutBtn.addEventListener('click', zoomOut);
    if (refs.zoomFitBtn) refs.zoomFitBtn.addEventListener('click', fit);

    refs.viewport.addEventListener('touchstart', onTouchStart, {
      passive: false
    });
    refs.viewport.addEventListener('touchmove', onTouchMove, {
      passive: false
    });
    refs.viewport.addEventListener('touchend', onTouchEnd);
    refs.viewport.addEventListener('touchcancel', onTouchEnd);
    refs.viewport.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('keydown', onKeydown);
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('resize', onResize);
    }
    return true;
  }

  global.Preview = {
    VERSION: VERSION,
    CELL_WIDTH_PX: CELL_WIDTH_PX,
    CELL_HEIGHT_PX: CELL_HEIGHT_PX,
    ROW_HEADER_WIDTH: ROW_HEADER_WIDTH,
    COLUMN_HEADER_HEIGHT: COLUMN_HEADER_HEIGHT,
    MIN_COLUMNS: MIN_COLUMNS,
    MIN_ROWS: MIN_ROWS,
    MIN_ZOOM: MIN_ZOOM,
    MAX_ZOOM: MAX_ZOOM,
    getColumnName: getColumnName,
    clampScale: clampScale,
    calculateFitScale: calculateFitScale,
    zoomAtPoint: zoomAtPoint,
    createModel: createModel,
    init: init,
    open: open,
    close: close,
    isOpen: isOpen
  };
})(window);

