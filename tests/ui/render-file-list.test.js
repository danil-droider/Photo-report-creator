/**
 * render-file-list.test.js — the file-list rendering contract:
 *   - empty list at boot (zero <li> children)
 *   - one <li> per selected photo, named from the File object
 *   - size shown as formatted original bytes
 *   - after compression, size flips to "original → compressed"
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
} from '../helpers/app-dom.js';

const IMG = { name: 'a.jpg', type: 'image/jpeg' };
const IMG2 = { name: 'b.png', type: 'image/png' };

describe('file list rendering', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('starts with an empty list', () => {
    expect(dom.document.getElementById('file-list').children).toHaveLength(0);
  });

  it('renders one li per selected photo with the file name', async () => {
    stubCompressor(dom.window);
    selectFiles(dom.window, [IMG, IMG2]);
    await waitFor(() =>
      dom.document.getElementById('file-list').children.length === 2
    );

    const items = dom.document.querySelectorAll('#file-list li');
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.file-name').textContent).toBe('a.jpg');
    expect(items[1].querySelector('.file-name').textContent).toBe('b.png');
  });

  it('shows the original file size before compression completes', () => {
    // selectFiles creates File objects with size 1024 by default.
    stubCompressor(dom.window);
    selectFiles(dom.window, [IMG]);
    // renderFileList runs synchronously in onFilesSelected before compression,
    // so the size shows as original-only.
    const li = dom.document.querySelector('#file-list li');
    expect(li.querySelector('.file-size').textContent).toBe('1.0 KB');
  });

  it('updates the size to "original → compressed" after processing', async () => {
    stubCompressor(dom.window);
    selectFiles(dom.window, [IMG]);
    await waitFor(() =>
      dom.document.querySelector('#file-list li .file-size').textContent.includes(
        '\u2192'
      )
    );
    const sizeEl = dom.document.querySelector('#file-list li .file-size');
    // fakePhoto reports 120*1024 = 122880 bytes = 120.0 KB.
    // The original File was 1024 bytes = 1.0 KB.
    expect(sizeEl.textContent).toContain('\u2192');
    expect(sizeEl.textContent).toContain('120.0 KB');
  });

  it('clearing removes all list items', async () => {
    stubCompressor(dom.window);
    selectFiles(dom.window, [IMG, IMG2]);
    await waitFor(() =>
      dom.document.getElementById('file-list').children.length === 2
    );

    dom.document.getElementById('clear-btn').click();
    expect(dom.document.getElementById('file-list').children).toHaveLength(0);
  });
});
