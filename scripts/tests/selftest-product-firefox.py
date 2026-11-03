"""Offline native product smoke test using disposable profiles and localhost only."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import platform
import runpy
import shutil
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
Wire = runpy.run_path(str(ROOT / "scripts/verify-windows-package.py"))["Wire"]


class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api":
            body = b'{"answer":42}'
            mime = "application/json"
        else:
            body = b'<title>Native product fixture</title><button id="probe" onclick="window.probeValue=42">Test</button>'
            mime = "text/html"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def run(binary, artifacts=None, node=None, python=None):
    artifacts = Path(artifacts or ROOT / ".tmp").resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    reports = []
    with tempfile.TemporaryDirectory(prefix="product-native-", dir=artifacts) as folder:
        root = Path(folder)
        profile = root / "profile"
        legacy = profile / "firefox-reverse-agent"
        legacy.mkdir(parents=True)
        (legacy / "conversations.json").write_text(json.dumps({
            "schemaVersion": 4,
            "threads": [{"id": "legacy-brand-sentinel", "title": "Legacy fixture",
                         "createdAt": 1, "updatedAt": 1, "lastTurnStatus": "completed",
                         "messages": [{"role": "user", "content": "legacy message"}]}],
        }))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        prefs = {
            "marionette.port": port, "remote.prefs.recommended": False,
            "browser.shell.checkDefaultBrowser": False,
            "browser.aboutwelcome.enabled": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "services.settings.server": "data:,#remote-settings-dummy/v1",
            "extensions.firefox-reverse.agent.confirmTools": "1",
            "extensions.firefox-reverse.agent.activeModelProfileId": "legacy-model",
            "extensions.firefox-reverse.agent.modelProfiles.v1": json.dumps([{
                "id": "legacy-model", "name": "legacy model", "provider": "custom",
                "apiKey": "offline-fixture", "model": "offline-fixture",
                "baseUrl": "http://127.0.0.1:1/v1", "protocol": "openai",
            }]),
        }
        (profile / "user.js").write_text("\n".join(
            "user_pref(" + json.dumps(key) + ", " + json.dumps(value) + ");"
            for key, value in prefs.items()
        ))
        environment = dict(os.environ)
        environment.update(MOZ_FRX_ENVS_ROOT=str(root / "environments"),
                           FRX_WORKSPACE_ROOT=str(root / "workspace"),
                           FRX_DATA_DIR=str(root / "data"))
        fixture = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        threading.Thread(target=fixture.serve_forever, daemon=True).start()
        try:
            for phase in ["initial", "restart"]:
                options = {"phase": phase, "profile": str(profile),
                           "workspace": str(root / "workspace"),
                           "environments": str(root / "environments"),
                           "url": f"http://127.0.0.1:{fixture.server_port}/",
                           "node": str(node or shutil.which("node")),
                           "python": str(python or shutil.which("python3"))}
                with (artifacts / f"product-native-{phase}.log").open("w") as log:
                    command = [str(binary), "--headless", "--no-remote"]
                    if platform.system() == "Windows":
                        command += ["--no-deelevate", "--wait-for-browser"]
                    process = subprocess.Popen(command + ["--profile", str(profile),
                        "-marionette", "-remote-allow-system-access", "about:blank",
                    ], env=environment, stdout=log, stderr=log)
                    connection = None
                    try:
                        deadline = time.monotonic() + 45
                        while connection is None:
                            assert process.poll() is None, "Firefox exited during startup"
                            try:
                                connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                            except OSError:
                                if time.monotonic() > deadline:
                                    raise
                                time.sleep(0.1)
                        connection.settimeout(90)
                        wire = Wire(connection)
                        wire.read()
                        wire.command("WebDriver:NewSession", {})
                        wire.command("Marionette:SetContext", {"value": "chrome"})
                        value = wire.command("WebDriver:ExecuteAsyncScript", {
                            "script": Path(__file__).with_suffix(".js").read_text(),
                            "args": [options], "newSandbox": False, "scriptTimeout": 75000,
                        })
                        value = value.get("value", value)
                        print(phase, json.dumps(value), flush=True)
                        reports.append(value)
                        assert value.get("passed") is True, value
                        wire.command("Marionette:Quit", {})
                        assert process.wait(timeout=25) == 0
                    finally:
                        if connection:
                            connection.close()
                        if process.poll() is None:
                            if platform.system() == "Windows":
                                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                            else:
                                process.terminate()
                            process.wait(timeout=25)
        finally:
            fixture.shutdown()
            fixture.server_close()
            (artifacts / "product-native-report.json").write_text(json.dumps(reports, indent=2) + "\n")
    return reports


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=ROOT / "upstream/obj-x86_64-pc-linux-gnu/dist/bin/firefox")
    run(parser.parse_args().binary)
