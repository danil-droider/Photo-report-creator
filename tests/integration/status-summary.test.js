/**
 * status-summary.test.js — the v7.3 "exactly once" contract for the idle
 * message, the selection/clear lifecycle, and the activity/status channel.
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  countIdleText,
  fakePhoto,
  stubCompressor,
} from '../helpers/app-dom.js';

const IMG = { name: 'a.jpg', type: 'image/jpeg' };

describe('idle status — the "exactly once" contract', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    // Let any in-flight async chain settle before the window is torn down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('renders "No photos selected." exactly once at boot', () => {
    const { document } = dom;
    expect(countIdleText(document)).toBe(1);
    const status = document.getElementById('status');
    expect(status.textContent).toBe('');
    expect(status.hidden).toBe(true);
    expect(document.getElementById('file-summary').textContent).toBe(
      'No photos selected.'
    );
  });

  it('keeps the idle sentence at exactly one occurrence in index.html source', () => {
    const { window } = dom;
    const html = window.document.documentElement.outerHTML;
    const occurrences = html.split('No photos selected.').length - 1;
    expect(occurrences).toBe(1);
  });

  it('never duplicates the idle sentence across the whole lifecycle', async () => {
    const { window, document } = dom;
    stubCompressor(window);

    selectFiles(window, [IMG, IMG, IMG]);
    await waitFor(() =>
      document.getElementById('status').textContent.startsWith('Processed 3/3')
    );
    expect(countIdleText(document)).toBe(0);

    document.getElementById('clear-btn').click();
    await waitFor(() =>
      document.getElementById('file-summary').textContent.includes('No photos')
    );
    expect(countIdleText(document)).toBe(1);
  });
});

describe('selection lifecycle', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('announces one photo, enables Clear and reports the final count', async () => {
    const { window, document } = dom;
    const compress = stubCompressor(window);

    selectFiles(window, [IMG]);
    await waitFor(() => compress.mock.calls.length >= 1);
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 1/1')
    );

    expect(document.getElementById('file-summary').textContent).toBe(
      '1 photo selected.'
    );
    expect(document.getElementById('clear-btn').disabled).toBe(false);
    // The activity line ends visible, showing the final Processed count.
    expect(document.getElementById('status').hidden).toBe(false);
    expect(document.getElementById('status').textContent).toBe(
      'Processed 1/1 photos.'
    );
    expect(document.getElementById('file-list').children).toHaveLength(1);
  });

  it('pluralizes the count for three photos and encodes each one', async () => {
    const { window, document } = dom;
    const compress = stubCompressor(window);

    selectFiles(window, [IMG, IMG, IMG]);
    await waitFor(() => compress.mock.calls.length >= 3);
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 3/3')
    );

    expect(document.getElementById('file-summary').textContent).toBe(
      '3 photos selected.'
    );
    expect(compress).toHaveBeenCalledTimes(3);
    expect(document.getElementById('file-list').children).toHaveLength(3);
  });

  it('shows "Processing N/M photos…" while the stub is pending', async () => {
    const { window, document } = dom;
    let release;
    vi.spyOn(window.Compressor, 'compressToTarget').mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve(fakePhoto(window));
      })
    );

    selectFiles(window, [IMG, IMG]);
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processing')
    );
    expect(document.getElementById('status').textContent).toBe(
      'Processing 1/2 photos…'
    );
    expect(document.getElementById('status').hidden).toBe(false);

    release();
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 2/2')
    );
    expect(document.getElementById('status').textContent).toBe(
      'Processed 2/2 photos.'
    );
  });

  it('clear returns to the idle state and empties the input', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    selectFiles(window, [IMG]);
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 1/1')
    );

    document.getElementById('clear-btn').click();

    expect(document.getElementById('file-summary').textContent).toBe(
      'No photos selected.'
    );
    expect(document.getElementById('clear-btn').disabled).toBe(true);
    expect(document.getElementById('file-list').children).toHaveLength(0);
    expect(countIdleText(document)).toBe(1);
  });

  it('filters non-image files and warns once', async () => {
    const { window, document } = dom;
    const compress = stubCompressor(window);
    const warns = [];
    vi.spyOn(window.console, 'warn').mockImplementation((...args) =>
      warns.push(args.join(' '))
    );

    selectFiles(window, [IMG, { name: 'notes.txt', type: 'text/plain' }]);
    await waitFor(() => compress.mock.calls.length >= 1);

    expect(
      warns.some((line) => line.includes('[app] Ignored 1 non-image file(s).'))
    ).toBe(true);
    expect(document.getElementById('file-summary').textContent).toBe(
      '1 photo selected.'
    );
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it('skips a failing photo but keeps the rest of the pipeline alive', async () => {
    const { window, document } = dom;
    const compress = vi
      .spyOn(window.Compressor, 'compressToTarget')
      .mockImplementation((file) =>
        file.name === 'bad.jpg'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(fakePhoto(window))
      );

    selectFiles(window, [IMG, { name: 'bad.jpg', type: 'image/jpeg' }, IMG]);
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 2/3')
    );

    expect(document.getElementById('status').textContent).toBe(
      'Processed 2/3 photos.'
    );
    expect(compress).toHaveBeenCalledTimes(3);
    expect(document.getElementById('generate-btn').disabled).toBe(false); // 2 laid out
  });

  it('cancels a superseded selection via the processing token', async () => {
    const { window, document } = dom;
    const pending = [];
    vi.spyOn(window.Compressor, 'compressToTarget').mockImplementation(() => {
      const gate = new Promise((resolve) => pending.push(resolve));
      return gate.then(() => fakePhoto(window));
    });

    selectFiles(window, [IMG, IMG]); // slow run A
    selectFiles(window, [IMG]); // fast run B supersedes A

    pending.splice(0).forEach((resolve) => resolve()); // release everything

    await waitFor(() =>
      document.getElementById('status').textContent.includes('Processed 1/1')
    );

    expect(document.getElementById('file-summary').textContent).toBe(
      '1 photo selected.'
    );
    expect(document.getElementById('file-list').children).toHaveLength(1);
    expect(document.getElementById('status').textContent).toBe(
      'Processed 1/1 photos.'
    );
  });
});

describe('Excel generation state machine', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  function stubBrowserBits(window) {
    window.URL.createObjectURL = () => 'blob:fake';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function () {};
  }

  it('runs Generating -> Download started and toggles the UI', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubBrowserBits(window);
    let release;
    const excel = vi
      .spyOn(window.ExcelWriter, 'buildExcelWorkbook')
      .mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve(new window.Uint8Array([0x50, 0x4b]));
        })
      );

    selectFiles(window, [IMG, IMG]);
    await waitFor(() => !document.getElementById('generate-btn').disabled);

    document.getElementById('generate-btn').click();
    expect(document.getElementById('status').textContent).toBe(
      'Generating Excel…'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(true);
    expect(document.getElementById('loader').hidden).toBe(false);

    release();
    await waitFor(() =>
      document.getElementById('status').textContent.includes('Download started')
    );

    expect(document.getElementById('status').textContent).toBe(
      'Download started.'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(false);
    expect(document.getElementById('loader').hidden).toBe(true);
    expect(excel).toHaveBeenCalledTimes(1);
  });

  it('reports the failure path when Stage 2 throws', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubBrowserBits(window);
    vi.spyOn(window.ExcelWriter, 'buildExcelWorkbook').mockRejectedValue(
      new Error('no workbook for you')
    );

    selectFiles(window, [IMG]);
    await waitFor(() => !document.getElementById('generate-btn').disabled);
    document.getElementById('generate-btn').click();

    await waitFor(() =>
      document.getElementById('status').textContent.includes('Failed')
    );
    expect(document.getElementById('status').textContent).toBe(
      'Failed to generate Excel — see console.'
    );
    expect(document.getElementById('generate-btn').disabled).toBe(false);
  });

  it('disables Generate until a layout exists and passes Stage 1 output through unchanged', async () => {
    const { window, document } = dom;
    const compress = stubCompressor(window);
    stubBrowserBits(window);
    const excel = vi
      .spyOn(window.ExcelWriter, 'buildExcelWorkbook')
      .mockResolvedValue(new window.Uint8Array([0x50, 0x4b]));

    expect(document.getElementById('generate-btn').disabled).toBe(true);

    selectFiles(window, [IMG]);
    await waitFor(() => !document.getElementById('generate-btn').disabled);
    document.getElementById('generate-btn').click();
    await waitFor(() => excel.mock.calls.length === 1);

    // The layout array handed to Stage 2 must be exactly Stage 1's output.
    const passed = excel.mock.calls[0][0];
    expect(passed).toHaveLength(1);
    expect(passed[0].width).toBeGreaterThan(0);
    expect(passed[0].height).toBe(378);
    expect(compress).toHaveBeenCalledTimes(1);
  });

  it('renders the version badge in the vX.Y format', () => {
    const { document } = dom;
    const badge = document.getElementById('version-badge').textContent;
    expect(badge).toMatch(/^v\d+\.\d+$/);
  });
});


