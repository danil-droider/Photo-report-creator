/**
 * remove-photo.test.js — the v16.0 per-row delete button contract:
 *   - clicking a row's cross removes exactly that photo from state.files
 *   - the remaining processed photos are re-keyed, so runLayout() rebuilds
 *     state.layout with contiguous ids and Generate stays armed
 *   - removing the oldest photo advances the save-modal date to the new
 *     earliest EXIF capture date (state.sortKeys filtering, no re-EXIF)
 *   - removing the last photo leaves the app in the clean idle state:
 *     empty list, Generate disabled, "No photos selected.", Clear disabled
 *   - a removal while compression is in flight does not corrupt state
 *
 * Runs the REAL index.html + app.js in jsdom with the canvas stages stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createAppDom,
  selectFiles,
  waitFor,
  stubCompressor,
  stubDownloads,
  readSaveModal,
  readFileTotal,
} from '../helpers/app-dom.js';
import { jpegWithExif } from '../helpers/exif-fixtures.js';

const KB = 1024;

/** The rendered file names, in display order. */
function readNames(document) {
  return Array.from(document.querySelectorAll('#file-list .file-name')).map(
    (name) => name.textContent
  );
}

describe('individual photo removal (v16.0)', () => {
  let dom;
  beforeEach(() => {
    dom = createAppDom();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.restoreAllMocks();
    dom.dom.window.close();
  });

  it('removes one photo and re-keys the layout to the survivors', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window); // neutralizes export paths, records thumbnail URLs

    selectFiles(window, [
      { name: 'early.jpg', type: 'image/jpeg', size: KB },
      { name: 'middle.jpg', type: 'image/jpeg', size: KB },
      { name: 'late.jpg', type: 'image/jpeg', size: KB },
    ]);
    await waitFor(
      () => document.getElementById('file-list').children.length === 3
    );
    await waitFor(() => !document.getElementById('generate-btn').disabled);

    // Remove the row carrying late.jpg (found by name — with no EXIF the
    // natural-name order is early/late/middle, so don't hardcode an index).
    const target = readNames(document).indexOf('late.jpg');
    document.querySelectorAll('#file-list .file-remove-btn')[target].click();

    expect(readNames(document)).toEqual(['early.jpg', 'middle.jpg']);
    await waitFor(() => !document.getElementById('generate-btn').disabled);

    // Generate is still armed and the save dialog still sees every SURVIVOR.
    document.getElementById('generate-btn').click();
    const modal = readSaveModal(document);
    expect(modal.hidden).toBe(false);
    expect(modal.files).toBe('Photos quantity: 2');
  });

  it('advances the report date when the oldest photo is removed', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window);

    selectFiles(window, [
      {
        name: 'old.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2020:01:01 08:00:00' }),
      },
      {
        name: 'new.jpg',
        type: 'image/jpeg',
        bytes: jpegWithExif({ dateTimeOriginal: '2026:03:15 10:00:00' }),
      },
    ]);
    await waitFor(
      () => document.getElementById('file-list').children.length === 2
    );

    document.getElementById('generate-btn').click();
    expect(readSaveModal(document).date).toBe('01.01.2020');

    // Back out, remove the oldest photo, reopen: the dialog must now default
    // to the remaining earliest capture date — from state.sortKeys alone.
    document.getElementById('save-cancel-btn').click();
    document.querySelector('#file-list .file-remove-btn').click();
    await waitFor(
      () => document.getElementById('file-list').children.length === 1
    );
    expect(readNames(document)).toEqual(['new.jpg']);

    document.getElementById('generate-btn').click();
    expect(readSaveModal(document).date).toBe('15.03.2026');
  });

  it('returns to the clean idle state after the last photo is removed', async () => {
    const { window, document } = dom;
    stubCompressor(window);
    stubDownloads(window);

    selectFiles(window, [
      { name: 'only.jpg', type: 'image/jpeg', size: KB },
      { name: 'last.jpg', type: 'image/jpeg', size: KB },
    ]);
    await waitFor(
      () => document.getElementById('file-list').children.length === 2
    );

    // Re-query each time: every removal re-renders the list, so a pre-collected
    // NodeList would hold detached buttons the delegated listener can't see.
    document.querySelector('#file-list .file-remove-btn').click();
    document.querySelector('#file-list .file-remove-btn').click();

    expect(document.getElementById('file-list').children).toHaveLength(0);
    expect(document.getElementById('generate-btn').disabled).toBe(true);
    expect(document.getElementById('clear-btn').disabled).toBe(true);
    expect(readFileTotal(document).size).toBe('No photos selected.');
  });

  it('does not corrupt state when a photo is removed mid-compression', async () => {
    const { window, document } = dom;
    let release;
    vi.spyOn(window.Compressor, 'compressToTarget').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              blob: new window.Blob(['x'], { type: 'image/jpeg' }),
              width: 800,
              height: 600,
              bytes: 120 * KB,
              quality: 0.8,
              targetBytes: 130 * KB,
              encoding: 'target',
              engine: 'stub',
            });
        })
    );
    stubDownloads(window);

    selectFiles(window, [
      { name: 'a.jpg', type: 'image/jpeg', size: KB },
      { name: 'b.jpg', type: 'image/jpeg', size: KB },
    ]);
    await waitFor(
      () => document.getElementById('file-list').children.length === 2
    );

    // Remove while the first encode is still gated open.
    document.querySelector('#file-list .file-remove-btn').click();

    expect(readNames(document)).toEqual(['b.jpg']);
    // The stale loop must NOT resurrect the removed photo.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readNames(document)).toEqual(['b.jpg']);
    expect(document.getElementById('file-list').children).toHaveLength(1);

    // The surviving selection still processes to completion.
    release();
    await waitFor(() => readFileTotal(document).size.includes('\u2192'));
  });
});
