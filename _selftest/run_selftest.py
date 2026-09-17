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
        suffix = "" if entry["pass"] else "  <-- " + entry["detail"]
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


def main():
    httpd = start_server()
    profile = tempfile.mkdtemp(prefix="prc-selftest-")
    page_url = "http://127.0.0.1:%d/_selftest/selftest.html" % HTTP_PORT
    app_url = "http://127.0.0.1:%d/index.html" % HTTP_PORT

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

        # ---------- phase 2: real index.html end-to-end ----------
        ws.call(3, "Page.navigate", {"url": app_url})
        if not wait_ready(
                ws, 4,
                "document.readyState === 'complete' && "
                "!!document.getElementById('version-badge')"):
            print("FAIL: index.html did not load")
            return 1

        time.sleep(1.5)  # let app.js init() wire the DOM + listeners

        with open(os.path.join(ROOT, "_selftest", "app-e2e.js"),
                  "r", encoding="utf-8") as handle:
            harness_source = handle.read()

        evaluate(ws, 5,
                 "(() => { %s ; return typeof window.__runAppE2E; })()"
                 % harness_source)

        payload = evaluate(ws, 6, "window.__runAppE2E()", await_promise=True)
        e2e_report = as_report(payload)
        passed, failed = print_report(
            e2e_report, "PHASE 2 - index.html + app.js end-to-end")
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