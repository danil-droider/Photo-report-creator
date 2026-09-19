/* End-to-end UI harness for index.html + app.js (v7.6).
 *
 * Evaluated on the real index.html page by _selftest/run_selftest.py, so the
 * production DOM, app.js, compressor.js, layout.js and excel.js run exactly as
 * they do for a user. Defines window.__runAppE2E().
 */
(function () {
  'use strict';

  var KB = 1024;
  var LOG_RE = /^\[(.+?)\] Target: ([\d.]+) KB -> Final: ([\d.]+) KB @ Quality: ([\d.]+)$/;
  var RANGE_RE = /^\[app\] Target size range: (\d+)\u2013(\d+) KB per photo\.$/;

  var logs = [];
  var nativeLog = console.log;
  console.log = function () {
    logs.push(Array.prototype.map.call(arguments, String).join(' '));
    nativeLog.apply(console, arguments);
  };

  var results = [];

  function check(name, pass, detail) {
    results.push({
      name: name,
      pass: !!pass,
      detail: String(detail === undefined || detail === null ? '' : detail)
    });
  }

  function waitFor(condition, timeoutMs, label) {
    var deadline = Date.now() + (timeoutMs || 30000);
    return new Promise(function (resolve) {
      (function poll() {
        if (condition()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 150);
      })();
    }).then(function (ok) {
      if (!ok) check('timed out waiting for ' + label, false, 'timeout');
      return ok;
    });
  }

  // Synthetic source photos: solid (cannot reach the minimum), gradient
  // (simple), noise (high entropy, reliably spans the KB range).
  function makePhoto(kind, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');

    if (kind === 'solid') {
      ctx.fillStyle = '#3a7bd5';
      ctx.fillRect(0, 0, w, h);
    } else if (kind === 'gradient') {
      var gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#101820');
      gradient.addColorStop(1, '#ffffff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
      for (var i = 0; i < 40; i++) {
        ctx.fillStyle = 'hsl(' + ((i * 11) % 360) + ', 70%, 50%)';
        ctx.beginPath();
        ctx.arc(Math.random() * w, Math.random() * h, 20 + Math.random() * 70, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      var data = ctx.createImageData(w, h);
      for (var p = 0; p < data.data.length; p += 4) {
        data.data[p] = (Math.random() * 256) | 0;
        data.data[p + 1] = (Math.random() * 256) | 0;
        data.data[p + 2] = (Math.random() * 256) | 0;
        data.data[p + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
    }

    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        resolve(new File([blob], kind + '.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.95);
    });
  }

  function selectFiles(files) {
    var input = document.getElementById('photo-input');
    var transfer = new DataTransfer();
    files.forEach(function (file) { transfer.items.add(file); });
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function photoLogs(from) {
    return logs.slice(from).filter(function (line) { return LOG_RE.test(line); });
  }

  function rangeLogs(from) {
    return logs.slice(from).filter(function (line) { return RANGE_RE.test(line); });
  }

  function checkServiceWorker() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.ready) {
      check('service worker available', false, 'not supported in this context');
      return Promise.resolve();
    }

    return navigator.serviceWorker.ready.then(function () {
      return caches.keys();
    }).then(function (keys) {
      check('service worker cache renamed to photo2excel-v7.6',
        keys.indexOf('photo2excel-v7.6') !== -1, keys.join(', ') || 'no caches');
      return caches.open('photo2excel-v7.6').then(function (cache) {
        return cache.keys();
      }).then(function (requests) {
        var urls = requests.map(function (request) { return request.url; });
        check('compressor.js is precached in the v7.6 app shell',
          urls.some(function (url) { return url.indexOf('/compressor.js') !== -1; }),
          urls.length + ' precached entries');
        check('pica.min.js is precached in the v7.6 app shell',
          urls.some(function (url) { return url.indexOf('/pica.min.js') !== -1; }),
          urls.length + ' precached entries');
      });
    }).catch(function (err) {
      check('service worker cache inspection', false, String((err && err.message) || err));
    });
  }

  function blobToBase64(blob) {
    if (!blob) return Promise.resolve('');
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result);
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = function () { resolve(''); };
      reader.readAsDataURL(blob);
    });
  }

  function report(kind, start) {
    var failed = results.filter(function (c) { return !c.pass; });
    return {
      kind: kind,
      passed: results.length - failed.length,
      failed: failed.length,
      checks: results,
      finalLogs: logs.slice(start)
    };
  }

  /**
   * v7.4 — Quality preset segmented control.
   *
   * Runs LAST in the chain: tapping a preset with photos loaded legitimately
   * restarts the encode, so no earlier log-count assertion may share its
   * timeline. Every check below only reads the DOM or the range log, so a
   * superseded encode can never produce a false failure.
   */
  function checkPresetControl(presetAtLoad) {
    var minInput = document.getElementById('min-kb-input');
    var maxInput = document.getElementById('max-kb-input');
    var label = document.getElementById('quality-preset-label');
    var group = document.getElementById('quality-preset');
    var buttons = Array.prototype.slice.call(
      group.querySelectorAll('[data-preset-index]'));

    function activeIndex() {
      var active = group.querySelector('.segmented-btn.is-active');
      return active ? Number(active.dataset.presetIndex) : -1;
    }

    function checkedStops() {
      return group.querySelectorAll('[aria-checked="true"]').length;
    }

    function tap(index) {
      buttons[index].click();
    }

    function inputsEditable() {
      return minInput.disabled === false && maxInput.disabled === false &&
        minInput.readOnly === false && maxInput.readOnly === false;
    }

    check('preset control renders four stops', buttons.length === 4,
      buttons.length + ' stops');
    check('preset control loaded on Custom with 80 / 220 KB untouched',
      presetAtLoad.index === 3 && presetAtLoad.label === 'Custom' &&
        presetAtLoad.min === '80' && presetAtLoad.max === '220' &&
        presetAtLoad.checked === 1,
      'at load: active=' + presetAtLoad.index + ' label=' + presetAtLoad.label +
        ' values=' + presetAtLoad.min + '/' + presetAtLoad.max);
    check('preset control is still on Custom before any preset tap',
      activeIndex() === 3 && label.textContent === 'Custom' && inputsEditable(),
      'active=' + activeIndex() + ' label=' + label.textContent +
        ' values=' + minInput.value + '/' + maxInput.value);

    // --- Low: the only preset that is awaited end-to-end --------------------
    var lowStart = logs.length;
    tap(0);

    return waitFor(function () {
      return rangeLogs(lowStart).length === 1 && photoLogs(lowStart).length === 3;
    }, 90000, 'Low preset re-encode').then(function () {
      var lowRange = RANGE_RE.exec(rangeLogs(lowStart)[0] || '');

      check('Low preset populates 20 / 60 KB and re-encodes in that range',
        minInput.value === '20' && maxInput.value === '60' &&
          !!lowRange && lowRange[1] === '20' && lowRange[2] === '60',
        minInput.value + '/' + maxInput.value + ' log=' +
          (rangeLogs(lowStart)[0] || 'none'));
      check('Low preset hides nothing: KB inputs stay editable',
        inputsEditable(),
        'disabled=' + minInput.disabled + ' readonly=' + minInput.readOnly);
      check('all three targets land inside the Low preset range (20-60 KB)',
        photoLogs(lowStart).every(function (line) {
          var target = parseFloat(LOG_RE.exec(line)[2]) * KB;
          return target >= 20 * KB && target <= 60 * KB;
        }),
        photoLogs(lowStart).map(function (l) { return LOG_RE.exec(l)[2]; }).join(', '));
      check('Low is the only active stop and is announced once',
        activeIndex() === 0 && label.textContent === 'Low' && checkedStops() === 1,
        'active=' + activeIndex() + ' label=' + label.textContent +
          ' checked=' + checkedStops());

      // --- Medium / High: values are written synchronously -----------------
      tap(1);
      var mediumOk = minInput.value === '70' && maxInput.value === '140' &&
        activeIndex() === 1 && label.textContent === 'Medium';
      tap(2);
      var highOk = minInput.value === '140' && maxInput.value === '400' &&
        activeIndex() === 2 && label.textContent === 'High';

      check('Medium preset populates 70 / 140 KB', mediumOk, 'medium tap');
      check('High preset populates 140 / 400 KB', highOk, 'high tap');

      // --- Manual typing overrides the preset (input, not change) ----------
      minInput.value = '99';
      minInput.dispatchEvent(new Event('input', { bubbles: true }));
      var minSnapped = activeIndex() === 3 && label.textContent === 'Custom' &&
        checkedStops() === 1;

      // --- Custom keeps whatever the user typed (never resets it) ----------
      var customStart = logs.length;
      tap(3);
      var customKept = minInput.value === '99' && maxInput.value === '400' &&
        activeIndex() === 3;

      maxInput.value = '250';
      maxInput.dispatchEvent(new Event('input', { bubbles: true }));
      var maxSnapped = activeIndex() === 3 && label.textContent === 'Custom';

      check('typing in Min target KB snaps the control to Custom', minSnapped,
        'active=' + activeIndex() + ' label=' + label.textContent);
      check('Custom leaves the typed values untouched',
        customKept, minInput.value + '/' + maxInput.value);
      check('re-selecting Custom does not restart encoding',
        rangeLogs(customStart).length === 0,
        rangeLogs(customStart).length + ' new range log(s)');
      check('typing in Max target KB also snaps the control to Custom',
        maxSnapped, 'active=' + activeIndex() + ' label=' + label.textContent);
      check('KB inputs remain enabled and manually editable at the end',
        inputsEditable(),
        'disabled=' + minInput.disabled + ' readonly=' + minInput.readOnly);

      // Let the in-flight High encode finish so teardown is not mid-run.
      return waitFor(function () {
        return document.getElementById('status').textContent ===
          'Processed 3/3 photos.';
      }, 90000, 'preset re-encode settle');
    });
  }

  /**
   * v7.5 — localStorage persistence (write-through).
   *
   * Runs after checkPresetControl(): it deliberately mutates the stored payload
   * and asserts the JSON on every committed change. Restore-after-reload lives in
   * run_selftest.py (phase 2b), which is the real "app restart" proof.
   */
  function checkSettingsPersistence() {
    var KEY = 'photo2excel.settings';
    var heightSelect = document.getElementById('height-select');
    var columnsSelect = document.getElementById('columns-select');
    var minInput = document.getElementById('min-kb-input');
    var maxInput = document.getElementById('max-kb-input');
    var group = document.getElementById('quality-preset');

    function stored() {
      var raw = null;
      try {
        raw = window.localStorage.getItem(KEY);
      } catch (err) {
        return { __error: String((err && err.message) || err) };
      }
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        return { __corrupt: raw };
      }
    }

    function commit(input) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 1. Every interaction earlier in this run must have written the key.
    var atStart = stored();
    check('settings are persisted after user interactions',
      !!atStart && atStart.version === 1 && !!atStart.layout &&
        !!atStart.compression,
      JSON.stringify(atStart));

    // 2. Layout selects persist on `change`, and each write keeps the rest.
    heightSelect.value = '12';
    commit(heightSelect);
    var afterHeight = stored();
    check('photo height selection is persisted',
      !!afterHeight && !!afterHeight.layout && afterHeight.layout.heightCm === 12,
      JSON.stringify(afterHeight && afterHeight.layout));

    columnsSelect.value = '3';
    commit(columnsSelect);
    var afterColumns = stored();
    check('column count is persisted without losing the stored height',
      !!afterColumns && !!afterColumns.layout &&
        afterColumns.layout.columns === 3 &&
        afterColumns.layout.heightCm === 12,
      JSON.stringify(afterColumns && afterColumns.layout));

    // 3. A committed KB pair persists sanitized, with the stop snapped to Custom.
    minInput.value = '90';
    maxInput.value = '210';
    commit(minInput);
    var afterKb = stored();
    check('committed KB range is persisted with the Custom stop',
      !!afterKb && !!afterKb.compression &&
        afterKb.compression.minKB === 90 &&
        afterKb.compression.maxKB === 210 &&
        afterKb.compression.presetIndex === 3,
      JSON.stringify(afterKb && afterKb.compression));

    // 4. An inverted range is stored already swapped (min <= max).
    minInput.value = '300';
    maxInput.value = '100';
    commit(minInput);
    var swapped = stored();
    check('an inverted KB range is stored sanitized (min <= max)',
      !!swapped && !!swapped.compression &&
        swapped.compression.minKB === 100 && swapped.compression.maxKB === 300,
      JSON.stringify(swapped && swapped.compression));

    // 5. A preset tap persists the chosen stop and its pair, no typing needed.
    group.querySelector('[data-preset-index="0"]').click();
    var afterPreset = stored();
    check('preset stop and KB pair are persisted on tap',
      !!afterPreset && !!afterPreset.compression &&
        afterPreset.compression.presetIndex === 0 &&
        afterPreset.compression.minKB === 20 &&
        afterPreset.compression.maxKB === 60,
      JSON.stringify(afterPreset && afterPreset.compression));
  }

  // --- end-to-end run -----------------------------------------------------
  window.__runAppE2E = function () {
    var start = logs.length;
    var generateBtn = document.getElementById('generate-btn');

    // v7.4 — snapshot of the preset control BEFORE any interaction: it must load
    // on Custom so the default 80 / 220 KB pair (and its pre-v7.4 behaviour) is
    // preserved. Captured here because later steps legitimately change the values.
    var presetAtLoad = {
      index: -1,
      label: document.getElementById('quality-preset-label').textContent,
      min: document.getElementById('min-kb-input').value,
      max: document.getElementById('max-kb-input').value,
      checked: document.querySelectorAll('#quality-preset [aria-checked="true"]').length
    };
    var activeAtLoad = document.querySelector('#quality-preset .segmented-btn.is-active');
    presetAtLoad.index = activeAtLoad ? Number(activeAtLoad.dataset.presetIndex) : -1;

    // v7.3 — the empty selection must be reported exactly ONCE. These run before
    // any photo is selected, while the page is still in its idle/empty state.
    var idleSummary = document.getElementById('file-summary');
    var idleStatus = document.getElementById('status');
    var idleMsgNodes = Array.prototype.filter.call(
      document.querySelectorAll('#controls p'),
      function (p) { return p.textContent.trim() === 'No photos selected.'; });

    check('empty selection message rendered exactly once',
      idleMsgNodes.length === 1 && idleSummary.textContent === 'No photos selected.',
      idleMsgNodes.length + ' element(s) say it');
    check('activity status line is blank and hidden while idle',
      idleStatus.hidden === true && idleStatus.textContent === '',
      'hidden=' + idleStatus.hidden + ' text=' + JSON.stringify(idleStatus.textContent));

    // Spy on pica so we can prove end-to-end that app.js photos were downscaled
    // by pica (Lanczos3) and not by the native fallback.
    var picaCalls = [];
    var engine = window.Compressor.getPica();

    if (engine && typeof engine.resize === 'function') {
      var realResize = engine.resize.bind(engine);
      engine.resize = function (from, to, opts) {
        picaCalls.push({
          fromW: from.width || from.naturalWidth,
          toW: to.width,
          filter: opts && opts.filter
        });
        return realResize(from, to, opts);
      };
    }

    return Promise.all([
      makePhoto('noise', 1600, 1200),
      makePhoto('gradient', 1600, 1200),
      makePhoto('solid', 1200, 900)
    ]).then(function (files) {
      selectFiles(files);
      // Wait for all three photos to finish encoding (one log line each).
      return waitFor(function () {
        return photoLogs(start).length === 3 && !generateBtn.disabled;
      }, 90000, 'photo processing');
    }).then(function () {
      var badge = document.getElementById('version-badge').textContent;
      var minInput = document.getElementById('min-kb-input');
      var maxInput = document.getElementById('max-kb-input');
      var items = document.querySelectorAll('#file-list li');
      var sizes = Array.prototype.map.call(items, function (li) {
        return li.querySelector('.file-size').textContent;
      });

      check('version badge shows v7.6', badge === 'v7.6', badge);

      // v7.2 — iOS safe-area wiring. Browser mode must keep the base 16px (so the
      // Safari appearance is untouched), and the header padding must follow the
      // --safe-top variable (headless Chrome resolves real env() to 0px, so the
      // calc() math is verified by overriding the variable instead).
      var header = document.querySelector('.app-header');
      var root = document.documentElement;
      // Captured at load time: proves the inline <head> script did not mark a
      // regular browser tab as standalone.
      var classListAtLoad = root.className;
      var basePad = getComputedStyle(header).paddingTop;

      check('browser mode header padding stays at the base 16px',
        basePad === '16px', basePad);

      root.style.setProperty('--safe-top', '30px');
      var liftedPad = getComputedStyle(header).paddingTop;
      root.style.removeProperty('--safe-top');

      check('header top padding = 16px + --safe-top inset',
        liftedPad === '46px', liftedPad);

      var browserBand = getComputedStyle(header).backgroundImage;
      check('no status-bar band outside standalone mode',
        browserBand === 'none', browserBand);

      root.classList.add('pwa-standalone');
      var standaloneBand = getComputedStyle(header).backgroundImage;
      root.classList.remove('pwa-standalone');

      check('inline detection script leaves browser mode unmarked',
        classListAtLoad.indexOf('pwa-standalone') === -1,
        'class list at load=' + (classListAtLoad || '(none)'));

      var headScripts = Array.prototype.filter.call(
        document.querySelectorAll('head script'),
        function (script) {
          return script.textContent.indexOf('pwa-standalone') !== -1;
        });

      check('inline standalone-detection script is present in <head>',
        headScripts.length === 1,
        headScripts.length + ' matching inline scripts');

      check('standalone-only status-bar band is applied',
        standaloneBand.indexOf('linear-gradient') !== -1, standaloneBand);
      check('KB inputs default to 80 / 220',
        minInput.value === '80' && maxInput.value === '220',
        minInput.value + ' / ' + maxInput.value);
      check('all three photos processed (generate enabled)', !generateBtn.disabled,
        'disabled=' + generateBtn.disabled);

      // v7.3 — with photos selected the two channels diverge: the count line is
      // rendered exactly once and the activity line comes back into view.
      var countNodes = Array.prototype.filter.call(
        document.querySelectorAll('#controls p'),
        function (p) { return p.textContent.trim() === '3 photos selected.'; });

      check('selected-count line rendered exactly once', countNodes.length === 1,
        countNodes.length + ' element(s) say it');
      check('activity line visible again once photos are processed',
        idleStatus.hidden === false && /^Processed \d+\/\d+ photos\.$/.test(idleStatus.textContent),
        'hidden=' + idleStatus.hidden + ' text=' + JSON.stringify(idleStatus.textContent));
      check('file list shows original -> compressed size',
        sizes.length === 3 && sizes.every(function (s) { return s.indexOf('\u2192') !== -1; }),
        sizes.join(' | '));

      var entries = photoLogs(start);
      check('one formatted log line per photo', entries.length === 3, entries.length + ' lines');
      check('range log line present', rangeLogs(start).length === 1, rangeLogs(start)[0] || 'none');

      check('app downscaled every photo through pica lanczos3',
        picaCalls.length === 3 && picaCalls.every(function (call) {
          return call.filter === 'lanczos3' && call.toW === 800;
        }),
        picaCalls.map(function (call) {
          return call.fromW + '->' + call.toW + '@' + call.filter;
        }).join(' | ') || 'no pica calls');
      check('<=4MP sources were baked at full resolution',
        picaCalls.length === 3 && picaCalls[0].fromW === 1600 && picaCalls[1].fromW === 1600,
        picaCalls.map(function (call) { return String(call.fromW); }).join(', ') || 'none');

      check('targets, sizes and qualities all valid', entries.every(function (line) {
        var match = LOG_RE.exec(line);
        var target = parseFloat(match[2]) * KB;
        var final = parseFloat(match[3]) * KB;
        var quality = parseFloat(match[4]);
        return target >= 80 * KB && target <= 220 * KB &&
          quality >= 0.15 && quality <= 0.95 &&
          (final >= 80 * KB && final <= 220 * KB || quality === 0.95 || quality === 0.15);
      }), entries.join(' || '));

      // --- KB inputs drive a re-encode (change listeners) -------------------
      var beforeChange = logs.length;
      minInput.value = '150';
      maxInput.value = '200';
      minInput.dispatchEvent(new Event('change', { bubbles: true }));

      return waitFor(function () {
        return rangeLogs(beforeChange).length === 1 &&
          photoLogs(beforeChange).length === 3 && !generateBtn.disabled;
      }, 90000, 'KB-range re-encode').then(function () {
        var range = RANGE_RE.exec(rangeLogs(beforeChange)[0] || '');
        check('KB range change triggers a re-encode',
          !!range && range[1] === '150' && range[2] === '200',
          rangeLogs(beforeChange)[0] || 'none');

        var reEntries = photoLogs(beforeChange);
        check('re-encode logs one line per photo', reEntries.length === 3,
          reEntries.length + ' lines');
        check('all re-encoded targets inside 150-200 KB', reEntries.every(function (line) {
          var target = parseFloat(LOG_RE.exec(line)[2]) * KB;
          return target >= 150 * KB && target <= 200 * KB;
        }), reEntries.map(function (l) { return LOG_RE.exec(l)[2]; }).join(', '));

        // --- Excel generation (download intercepted: nothing is written) ---
        var swCheck = checkServiceWorker();
        var downloadName = null;
        var workbookBlob = null;
        var nativeClick = HTMLAnchorElement.prototype.click;
        var nativeCreateObjectURL = URL.createObjectURL;
        HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
        URL.createObjectURL = function (blob) {
          if (blob && blob.type && blob.type.indexOf('spreadsheetml') !== -1) {
            workbookBlob = blob;
          }
          return nativeCreateObjectURL.call(URL, blob);
        };

        generateBtn.click();

        return waitFor(function () {
          return downloadName !== null && !generateBtn.disabled &&
            document.getElementById('status').textContent === 'Download started.';
        }, 90000, 'Excel download').then(function (ok) {
          HTMLAnchorElement.prototype.click = nativeClick;
          URL.createObjectURL = nativeCreateObjectURL;

          check('Excel generated and download triggered', ok,
            'name=' + String(downloadName));
          check('downloaded file is Photo_Report.xlsx',
            downloadName === 'Photo_Report.xlsx', String(downloadName));
          check('workbook contains the compressed photos',
            !!workbookBlob && workbookBlob.size > 0,
            workbookBlob ? workbookBlob.size + ' bytes' : 'no blob captured');

          return swCheck.then(function () {
            return blobToBase64(workbookBlob);
          }).then(function (base64) {
            // v7.4 — preset UI checks run last: they restart the encode on
            // purpose, after the workbook has already been captured.
            return checkPresetControl(presetAtLoad).then(function () {
              // v7.5 — persistence checks run after that: they mutate the store.
              checkSettingsPersistence();
              var out = report('app-e2e', start);
              out.workbookBytes = workbookBlob ? workbookBlob.size : 0;
              out.workbookBase64 = base64;
              return out;
            });
          });
        });
      });
    }).catch(function (err) {
      var failure = report('app-e2e', start);
      failure.error = String((err && err.stack) || err);
      return failure;
    });
  };
})();
