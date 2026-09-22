"""Headless validation driver for the v7.0 target-size compression module.

Serves the project over HTTP, launches headless Chrome with remote debugging,
and evaluates _selftest/selftest.html's window.__runSelfTest() over a minimal
CDP WebSocket client (no Node.js required on this machine).
"""

import base64
import io
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTTP_PORT = 8123
CDP_PORT = 9333
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def start_server():
    handler = lambda *a, **kw: QuietHandler(*a, directory=ROOT, **kw)
    httpd = ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


class WSClient:
    """Just enough RFC-6455 to talk to the Chrome DevTools Protocol."""

    def __init__(self, url):
        rest = url[len("ws://"):]
        host_port, _, path = rest.partition("/")
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=180)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (
            "GET /%s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host_port, key)
        )
        self.sock.sendall(request.encode())
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("websocket handshake failed")
            buffer += chunk
        status_line = buffer.split(b"\r\n", 1)[0].decode("utf-8", "replace")
        if "101" not in status_line:
            raise RuntimeError("websocket handshake rejected: " + status_line)
        self.buffer = buffer.split(b"\r\n\r\n", 1)[1]

    def _read(self, count):
        while len(self.buffer) < count:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise RuntimeError("websocket closed")
            self.buffer += chunk
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def _frame(self, opcode, payload):
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def send(self, text):
        self._frame(0x1, text.encode("utf-8"))

    def recv(self):
        while True:
            first, second = self._read(2)
            opcode = first & 0x0F
            length = second & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if second & 0x80 else b""
            data = self._read(length)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x9:
                self._frame(0xA, data)
                continue
            if opcode == 0x8:
                raise RuntimeError("websocket closed by peer")
            if opcode == 0x1:
                return data.decode("utf-8", "replace")

    def call(self, message_id, method, params=None):
        self.send(json.dumps({"id": message_id, "method": method,
                              "params": params or {}}))
        while True:
            message = json.loads(self.recv())
            if message.get("id") == message_id:
                return message


def evaluate(ws, message_id, expression, await_promise=False):
    response = ws.call(message_id, "Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": await_promise,
        "returnByValue": True
    })
    result = response.get("result", {})
    if "exceptionDetails" in result:
        raise RuntimeError(json.dumps(result["exceptionDetails"])[:2000])
    return result.get("result", {}).get("value")


def as_report(payload):
    """Runtime.evaluate(returnByValue) yields a dict for object results and a
    string for string results - accept both."""
    if isinstance(payload, str):
        return json.loads(payload)
    if isinstance(payload, dict):
        return payload
    raise RuntimeError("unexpected self-test payload: %r" % (payload,))


def wait_ready(ws, message_id, condition, attempts=240):
    for _ in range(attempts):
        try:
            if evaluate(ws, message_id, condition) is True:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def print_report(report, title):
    print("=" * 72)
    print(title)
    print("=" * 72)

    if "version" in report:
        print("module version: %s" % report["version"])
    if "error" in report:
        print("FAIL: harness threw\n%s" % report["error"])

    for entry in report.get("checks", []):
        detail = entry.get("detail") or ""
        if not detail:
            suffix = ""
        elif entry["pass"]:
            suffix = "  :: " + detail
        else:
            suffix = "  <-- " + detail
        print("[%s] %s%s" % ("PASS" if entry["pass"] else "FAIL",
                             entry["name"], suffix))

    print("\n--- captured log lines ---")
    for line in report.get("finalLogs", []):
        print(line)

    passed = report.get("passed", 0)
    failed = report.get("failed", len(report.get("checks", [])) or 1)
    print("\n%s: %d passed, %d failed\n" % (report.get("kind", "test"), passed, failed))
    return passed, failed


def inspect_workbook(base64_data, expected_bytes):
    """Unzip the real .xlsx built by the browser and verify the Stage 2
    contract: absolute floating images, one media part per photo, and an
    untouched (native) worksheet grid."""
    print("=" * 72)
    print("PHASE 3 - generated .xlsx inspection (%.1f KB)"
          % (expected_bytes / 1024.0))
    print("=" * 72)

    if not base64_data:
        print("[FAIL] no workbook was returned by the page")
        print("\nphase3: 0 passed, 1 failed\n")
        return 0, 1

    data = base64.b64decode(base64_data)
    passed = 0
    failed = 0

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        media = sorted(n for n in names
                       if n.startswith("xl/media/") and not n.endswith("/"))
        drawings = sorted(n for n in names if n.startswith("xl/drawings/drawing"))
        sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8", "replace")
        drawing = (archive.read(drawings[0]).decode("utf-8", "replace")
                   if drawings else "")

    native_grid = "<col " not in sheet and "customHeight" not in sheet
    columns_modified = "<col " in sheet
    anchor_tags = re.findall(r"<xdr:(\w*CellAnchor)", drawing)

    for label, ok, detail in [
        ("workbook opens as a zip", True, "%d entries" % len(names)),
        ("one embedded JPEG per photo", len(media) == 3, ", ".join(media) or "none"),
        ("drawing part present", bool(drawings), ", ".join(drawings) or "none"),
        ("images are absolute floating shapes",
         drawing.count('editAs="absolute"') == 3,
         '%d editAs="absolute"' % drawing.count('editAs="absolute"')),
        ("images anchored to cells (one per photo)",
         len(anchor_tags) == 3, ", ".join(anchor_tags) or "none"),
        ("worksheet grid left at native defaults", native_grid,
         "columns modified" if columns_modified else "no <col>/customHeight"),
    ]:
        if ok:
            passed += 1
        else:
            failed += 1
        print("[%s] %s%s" % ("PASS" if ok else "FAIL", label,
                             "" if ok else "  <-- " + detail))

    print("\nphase3: %d passed, %d failed\n" % (passed, failed))
    return passed, failed


def check_settings_restart(ws, app_url):
    """PHASE 2b - prove stored preferences survive an app restart.

    Equivalent of closing and reopening the installed standalone PWA: a payload
    is written into localStorage, the real index.html is navigated to again, and
    the controls must come back hydrated. A corrupt payload must fall back to the
    defaults without throwing, so init() can never be broken by storage.

    Runs after phase 2 (the harness left the page in a well-defined state) and
    before phase 3 (which only inspects the already-captured workbook bytes).
    """
    print("=" * 72)
    print("PHASE 2b - settings restore after restart (localStorage)")
    print("=" * 72)

    passed = 0
    failed = 0

    def record(label, ok, detail=""):
        nonlocal passed, failed
        if ok:
            passed += 1
        else:
            failed += 1
        suffix = "" if ok else "  <-- " + str(detail)
        print("[%s] %s%s" % ("PASS" if ok else "FAIL", label, suffix))

    # Collected for every document from now on, so a corrupt payload can be
    # proven to degrade gracefully rather than break initialization. Page.enable
    # is required before the script hook is accepted.
    ws.call(19, "Page.enable")
    ws.call(20, "Page.addScriptToEvaluateOnNewDocument", {
        "source": (
            "window.__pageErrors = [];"
            "window.addEventListener('error', function (e) {"
            "  if (e && e.message) window.__pageErrors.push(String(e.message));"
            "});"
        )
    })

    def reload_and_read():
        """Navigate to index.html again (= restart) and report control state."""
        ws.call(21, "Page.navigate", {"url": app_url})
        if not wait_ready(
                ws, 22,
                "document.readyState === 'complete' && "
                "!!document.getElementById('version-badge')"):
            return None
        time.sleep(1.2)  # let app.js init() finish hydrating the controls
        raw = evaluate(ws, 23, (
            "JSON.stringify({"
            "badge: document.getElementById('version-badge').textContent,"
            "height: document.getElementById('height-stepper').dataset.value,"
            "columns: document.getElementById('columns-stepper').dataset.value,"
            "min: document.getElementById('min-kb-input').value,"
            "max: document.getElementById('max-kb-input').value,"
            "preset: document.getElementById('quality-preset-label').textContent,"
            "active: (function () { var a = document.querySelector("
            "'#quality-preset .segmented-btn.is-active');"
            "return a ? Number(a.dataset.presetIndex) : -1; })(),"
            "errors: window.__pageErrors"
            "})"))
        return json.loads(raw) if raw else None

    def restart_with(stored_string):
        """Store an exact string payload, then restart the app and read state."""
        evaluate(ws, 24,
                 "window.localStorage.setItem('photo2excel.settings', %s)"
                 % json.dumps(stored_string))
        return reload_and_read()

    # ---------- 1. a real session is restored -------------------------------
    # v18.0 — 15 cm left the 2 cm stepper grid, so the payload uses 14 cm.
    restored = restart_with(json.dumps({
        "version": 1,
        "layout": {"heightCm": 14, "columns": 3},
        "compression": {"minKB": 70, "maxKB": 140, "presetIndex": 1}
    }))

    if restored is None:
        record("index.html reloads with stored settings", False, "timeout")
        print("\nphase2b: %d passed, %d failed\n" % (passed, failed))
        return passed, failed

    record("restored photo height is applied (14 cm)",
           restored.get("height") == "14", restored.get("height"))
    record("restored column count is applied (3)",
           restored.get("columns") == "3", restored.get("columns"))
    record("restored KB range is applied (70 / 140)",
           restored.get("min") == "70" and restored.get("max") == "140",
           "%s / %s" % (restored.get("min"), restored.get("max")))
    record("restored preset stop is applied (Medium, not Custom)",
           restored.get("active") == 1 and restored.get("preset") == "Medium",
           "active=%s label=%s" % (restored.get("active"), restored.get("preset")))
    record("restoring settings does not restart the app or throw",
           restored.get("errors") == [] and restored.get("badge") == "v22.0",
           "badge=%s errors=%s" % (restored.get("badge"), restored.get("errors")))

    # ---------- 2. corrupt JSON falls back to the defaults ------------------
    corrupt = restart_with("{ not valid json")
    record("corrupt settings fall back to the layout defaults (10 cm / 4 columns)",
           bool(corrupt) and corrupt.get("height") == "10" and
           corrupt.get("columns") == "4",
           corrupt and "%s / %s" % (corrupt.get("height"), corrupt.get("columns")))
    record("corrupt settings fall back to the default KB pair (80 / 220)",
           bool(corrupt) and corrupt.get("min") == "80" and
           corrupt.get("max") == "220",
           corrupt and "%s / %s" % (corrupt.get("min"), corrupt.get("max")))
    record("corrupt settings fall back to the Custom stop",
           bool(corrupt) and corrupt.get("active") == 3 and
           corrupt.get("preset") == "Custom",
           corrupt and "active=%s label=%s" % (corrupt.get("active"),
                                               corrupt.get("preset")))
    record("corrupt settings never break initialization",
           bool(corrupt) and corrupt.get("errors") == [] and
           corrupt.get("badge") == "v22.0",
           corrupt and "badge=%s errors=%s" % (corrupt.get("badge"),
                                               corrupt.get("errors")))

    # ---------- 3. stale / out-of-range values are sanitized ----------------
    # v18.0 — 9 is now a VALID column stop, so the stale payload uses 99.
    stale = restart_with(json.dumps({
        "version": 1,
        "layout": {"heightCm": 99, "columns": 99},
        "compression": {"minKB": 4000, "maxKB": 10, "presetIndex": 7}
    }))
    record("a height no longer offered by the markup is rejected (10 cm)",
           bool(stale) and stale.get("height") == "10",
           stale and stale.get("height"))
    record("an out-of-range column count is rejected (4)",
           bool(stale) and stale.get("columns") == "4",
           stale and stale.get("columns"))
    record("an inverted KB pair is swapped on restore (10 / 4000)",
           bool(stale) and stale.get("min") == "10" and
           stale.get("max") == "4000",
           stale and "%s / %s" % (stale.get("min"), stale.get("max")))
    record("an out-of-range preset stop is rejected (Custom)",
           bool(stale) and stale.get("active") == 3 and
           stale.get("preset") == "Custom",
           stale and "active=%s label=%s" % (stale.get("active"),
                                             stale.get("preset")))
    record("sanitizing stale values throws nothing",
           bool(stale) and stale.get("errors") == [],
           stale and stale.get("errors"))

    print("\nphase2b: %d passed, %d failed\n" % (passed, failed))
    return passed, failed


def main():
    httpd = start_server()
    profile = tempfile.mkdtemp(prefix="prc-selftest-")
    page_url = "http://127.0.0.1:%d/_selftest/selftest.html" % HTTP_PORT
    app_url = "http://127.0.0.1:%d/index.html" % HTTP_PORT
    nopica_url = "http://127.0.0.1:%d/_selftest/selftest.html?nopica=1" % HTTP_PORT

    chrome = subprocess.Popen([
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--remote-allow-origins=*",
        "--user-data-dir=" + profile,
        "--remote-debugging-port=%d" % CDP_PORT,
        page_url
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    exit_code = 1
    try:
        ws_url = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(
                        "http://127.0.0.1:%d/json/list" % CDP_PORT,
                        timeout=2) as response:
                    targets = json.load(response)
                for target in targets:
                    if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                        ws_url = target["webSocketDebuggerUrl"]
                        break
                if ws_url:
                    break
            except Exception:
                pass
            time.sleep(0.5)

        if not ws_url:
            print("FAIL: no CDP page target available")
            return 1

        ws = WSClient(ws_url)

        ready = False
        for _ in range(120):
            state = evaluate(
                ws, 1, "document.readyState + '|' + (typeof window.__runSelfTest)")
            if state == "complete|function":
                ready = True
                break
            time.sleep(0.5)

        if not ready:
            print("FAIL: self-test page never became ready")
            return 1

        payload = evaluate(ws, 2, "window.__runSelfTest()", await_promise=True)
        total_passed, total_failed = print_report(
            as_report(payload), "PHASE 1 - compressor.js module self-test")

        # ---------- phase 1b: pica.min.js absent (graceful degradation) ----------
        ws.call(7, "Page.navigate", {"url": nopica_url})
        if not wait_ready(
                ws, 8,
                "document.readyState === 'complete' && "
                "typeof window.__runNoPicaTest === 'function'"):
            print("FAIL: ?nopica page did not become ready")
            return 1

        payload = evaluate(ws, 9, "window.__runNoPicaTest()", await_promise=True)
        passed, failed = print_report(
            as_report(payload), "PHASE 1b - pica.min.js absent (offline degradation)")
        total_passed += passed
        total_failed += failed

        # ---------- phase 2: real index.html end-to-end ----------
        ws.call(10, "Page.navigate", {"url": app_url})
        if not wait_ready(
                ws, 11,
                "document.readyState === 'complete' && "
                "!!document.getElementById('version-badge')"):
            print("FAIL: index.html did not load")
            return 1

        time.sleep(1.5)  # let app.js init() wire the DOM + listeners

        with open(os.path.join(ROOT, "_selftest", "app-e2e.js"),
                  "r", encoding="utf-8") as handle:
            harness_source = handle.read()

        evaluate(ws, 12,
                 "(() => { %s ; return typeof window.__runAppE2E; })()"
                 % harness_source)

        payload = evaluate(ws, 13, "window.__runAppE2E()", await_promise=True)
        e2e_report = as_report(payload)
        passed, failed = print_report(
            e2e_report, "PHASE 2 - index.html + app.js end-to-end")
        total_passed += passed
        total_failed += failed

        # ---------- phase 2b: v7.5 persisted settings survive a restart ----------
        passed, failed = check_settings_restart(ws, app_url)
        total_passed += passed
        total_failed += failed

        # ---------- phase 3: inspect the real .xlsx written by Stage 2 ----------
        inspected_passed, inspected_failed = inspect_workbook(
            e2e_report.get("workbookBase64", ""), e2e_report.get("workbookBytes", 0))
        total_passed += inspected_passed
        total_failed += inspected_failed

        print("TOTAL: %d passed, %d failed" % (total_passed, total_failed))
        exit_code = 1 if total_failed else 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except Exception:
            chrome.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())