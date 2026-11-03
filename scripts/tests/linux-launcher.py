#!/usr/bin/env python3
"""Run the packaged launcher's real shell code against isolated profile fixtures."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[1] / "package-linux-deb.py"
spec = importlib.util.spec_from_file_location("linux_package", script)
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

with tempfile.TemporaryDirectory(prefix="web-reverse-launcher-") as work:
    root = Path(work)
    binary = root / "app with spaces/firefox"
    binary.parent.mkdir()
    binary.write_text(
        "#!/usr/bin/python3\nimport os,sys,json\n"
        "print(json.dumps({'args':sys.argv[1:], 'remoting':os.environ.get('MOZ_APP_REMOTINGNAME')}))\n"
    )
    binary.chmod(0o755)
    legacy = root / "browser-agent-mcp"
    legacy.write_text(package.launcher_script(binary))
    legacy.chmod(0o755)
    alias = root / "web-reverse"
    alias.symlink_to(legacy.name)
    home = root / "home"
    profile = home / ".config/browser-agent-mcp/profile"
    profile.mkdir(parents=True)
    marker = profile / "existing-data.json"
    marker.write_text('{"preserved":true}\n')
    env = {"HOME": str(home), "PATH": "/usr/bin:/bin"}

    def launch(command, args=(), extra_env=None):
        result = subprocess.run(
            [command, *args], env={**env, **(extra_env or {})},
            check=True, capture_output=True, text=True,
        )
        payload = json.loads(result.stdout)
        assert payload["remoting"] == "browser-agent-mcp"
        return payload["args"]

    for command in [legacy, alias]:
        assert launch(command, ["https://example.com"]) == [
            "-profile", str(profile), "https://example.com"
        ]
    xdg = root / "xdg config"
    assert launch(alias, extra_env={"XDG_CONFIG_HOME": str(xdg)}) == [
        "-profile", str(xdg / "browser-agent-mcp/profile")
    ]
    override = root / "custom profile"
    assert launch(alias, extra_env={"BROWSER_AGENT_PROFILE": str(override)}) == [
        "-profile", str(override)
    ]
    for args in [
        ["-profile", "/chosen/profile"], ["--profile", "/chosen/profile"],
        ["-P", "existing"], ["-ProfileManager"], ["--ProfileManager"],
    ]:
        assert launch(alias, args) == args
    assert marker.read_text() == '{"preserved":true}\n'
    assert not (home / ".config/web-reverse").exists()

print("Linux launcher: both commands preserve existing profiles and overrides")
