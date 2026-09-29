"""Offline native Firefox OAuth/storage smoke test. No real OpenAI login or model calls."""
import argparse
import json
from pathlib import Path
import runpy
import socket
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
Wire = runpy.run_path(str(ROOT / "scripts/verify-windows-package.py"))["Wire"]


def run(binary):
    artifacts = ROOT / ".tmp"
    artifacts.mkdir(exist_ok=True)
    script = Path(__file__).with_suffix(".js").read_text()
    with tempfile.TemporaryDirectory(prefix="subscription-native-", dir=artifacts) as folder:
        profile = Path(folder)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        prefs = {
            "marionette.port": port, "remote.prefs.recommended": False,
            "browser.shell.checkDefaultBrowser": False,
            "browser.aboutwelcome.enabled": False,
            "browser.startup.homepage_override.mstone": "ignore",
            "services.settings.server": "data:,#remote-settings-dummy/v1",
        }
        (profile / "user.js").write_text("\n".join(
            "user_pref(" + json.dumps(key) + ", " + json.dumps(value) + ");"
            for key, value in prefs.items()
        ))
        for phase in ["login", "restart"]:
            with (artifacts / ("subscription-native-" + phase + ".log")).open("w") as log:
                process = subprocess.Popen([
                    str(binary), "--headless", "--no-remote", "--profile", str(profile),
                    "-marionette", "-remote-allow-system-access", "about:blank",
                ], stdout=log, stderr=log)
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
                    connection.settimeout(40)
                    wire = Wire(connection)
                    wire.read()
                    wire.command("WebDriver:NewSession", {})
                    wire.command("Marionette:SetContext", {"value": "chrome"})
                    value = wire.command("WebDriver:ExecuteAsyncScript", {
                        "script": script, "args": [phase], "newSandbox": False, "scriptTimeout": 30000,
                    })
                    value = value.get("value", value)
                    assert "error" not in value, value
                    print(phase, json.dumps(value), flush=True)
                    wire.command("Marionette:Quit", {})
                    assert process.wait(timeout=20) == 0
                finally:
                    if connection:
                        connection.close()
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=20)
            if phase == "login":
                saved = (profile / "logins.json").read_text()
                assert "native-refresh-secret" not in saved
                assert "access_token" not in saved
                print("LoginManager credentials encrypted on disk", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=ROOT / "upstream/obj-x86_64-pc-linux-gnu/dist/bin/firefox")
    run(parser.parse_args().binary)
