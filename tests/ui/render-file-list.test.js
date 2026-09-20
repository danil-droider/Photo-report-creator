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
import {
  jpegWithExif,
  jpegWithoutExif,
} from '../helpers/exif-fixtures.js';

const IMG = { name: 'a.jpg', type: 'image/jpeg' };
const IMG2 = { name: 'b.png', type: 'image/png' };

/** The rendered file names, in grid order. */
function readNames(document) {
  return Array.from(document.querySelectorAll('#file-list .file-name')).map(
    (name) => name.textContent
  );
}

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

  it('shows the original file size before compression completes', async () => {
    // selectFiles creates File objects with size 1024 by default.
    // v9.2 — the selection is sorted (EXIF head reads) before the grid
    // renders, so hold every encode open: the row must appear carrying its
    // original size only.
    vi.spyOn(dom.window.Compressor, 'compressToTarget').mockReturnValue(
      new Promise(() => {})
    );
    selectFiles(dom.window, [IMG]);
    await waitFor(() => dom.document.querySelector('#file-list li') !== null);

    const li = dom.document.querySelector('#file-list li');
    expect(li.querySelector('.file-size').textContent).toBe('1.0 KB');
  });

  it('updates the size to "original → compressed" after processing', async () => {
    stubCompressor(dom.window);
    selectFiles(dom.window, [IMG]);
    await waitFor(() => {
      const el = dom.document.querySelector('#file-list li .file-size');
      return el !== null && el.textContent.includes('\u2192');
    });
    const sizeEl = dom.document.querySelector('#file-list li .file-size');
    // fakePhoto reports 120*1024 = 122880 bytes = 120.0 KB.
    // The original File was 1024 bytes = 1.0 KB.
    expect(sizeEl.textContent).toContain('\u2192');
    expect(sizeEl.textContent).toContain('120.0 KB');
  });

  it('renders the grid in chronological order for an out-of-order selection (v9.2)', async () => {
    stubCompressor(dom.window);
    // Selected newest-first, but the grid must show oldest-first.
    selectFiles(dom.window, [
      {
        name: 'late.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:09:19 14:30:21' }),
      },
      {
        name: 'middle.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2024:05:07 08:09:10' }),
      },
      {
        name: 'early.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2020:01:01 08:00:00' }),
      },
    ]);
    await waitFor(
      () => dom.document.getElementById('file-list').children.length === 3
    );

    expect(readNames(dom.document)).toEqual([
      'early.jpg',
      'middle.jpg',
      'late.jpg',
    ]);
  });

  it('breaks an EXIF timestamp tie by natural filename order (v9.2)', async () => {
    stubCompressor(dom.window);
    const sameStamp = { dateTimeOriginal: '2024:05:07 12:00:00' };
    selectFiles(dom.window, [
      {
        name: 'IMG_4501.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif(sameStamp),
      },
      {
        name: 'IMG_4490.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif(sameStamp),
      },
    ]);
    await waitFor(
      () => dom.document.getElementById('file-list').children.length === 2
    );

    expect(readNames(dom.document)).toEqual(['IMG_4490.jpg', 'IMG_4501.jpg']);
  });

  it('falls back to natural filename order when no photo has EXIF (v9.2)', async () => {
    stubCompressor(dom.window);
    // Same lastModified on purpose: with no EXIF and an identical timestamp the
    // only remaining criterion is the natural filename comparison.
    const stamp = new Date(2024, 4, 7, 12, 0, 0).getTime();
    selectFiles(dom.window, [
      {
        name: 'photo_10.jpg',
        type: 'image/jpeg',
        bytes: jpegWithoutExif(),
        lastModified: stamp,
      },
      {
        name: 'photo_2.jpg',
        type: 'image/jpeg',
        bytes: jpegWithoutExif(),
        lastModified: stamp,
      },
    ]);
    await waitFor(
      () => dom.document.getElementById('file-list').children.length === 2
    );

    // photo_2.jpg < photo_10.jpg numerically, not lexicographically.
    expect(readNames(dom.document)).toEqual(['photo_2.jpg', 'photo_10.jpg']);
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
