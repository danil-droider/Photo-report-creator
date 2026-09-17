/* End-to-end UI harness for index.html + app.js (v7.0).
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
      check('service worker cache renamed to photo2excel-v7.1',
        keys.indexOf('photo2excel-v7.1') !== -1, keys.join(', ') || 'no caches');
      return caches.open('photo2excel-v7.1').then(function (cache) {
        return cache.keys();
      }).then(function (requests) {
        var urls = requests.map(function (request) { return request.url; });
        check('compressor.js is precached in the v7.1 app shell',
          urls.some(function (url) { return url.indexOf('/compressor.js') !== -1; }),
          urls.length + ' precached entries');
        check('pica.min.js is precached in the v7.1 app shell',
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

  // --- end-to-end run -----------------------------------------------------
  window.__runAppE2E = function () {
    var start = logs.length;
    var generateBtn = document.getElementById('generate-btn');

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

      check('version badge shows v7.1', badge === 'v7.1', badge);
      check('KB inputs default to 80 / 220',
        minInput.value === '80' && maxInput.value === '220',
        minInput.value + ' / ' + maxInput.value);
      check('all three photos processed (generate enabled)', !generateBtn.disabled,
        'disabled=' + generateBtn.disabled);
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
            var out = report('app-e2e', start);
            out.workbookBytes = workbookBlob ? workbookBlob.size : 0;
            out.workbookBase64 = base64;
            return out;
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
