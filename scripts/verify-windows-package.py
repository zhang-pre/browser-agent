"""Validate the exact candidate ZIP on a native Windows CI runner."""
import configparser
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import zipfile


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stop(process):
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        process.wait(timeout=15)


@contextmanager
def temporary_workspace():
    work = Path(tempfile.mkdtemp(prefix="frx-native-中文 path-")).resolve()
    temporary_root = Path(tempfile.gettempdir()).resolve()
    assert work.is_relative_to(temporary_root) and work.name.startswith("frx-native-")
    try:
        yield work
    finally:
        # Windows may briefly retain file locks after the browser exits.
        for attempt in range(20):
            try:
                shutil.rmtree(work)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(1)


class Wire:
    def __init__(self, connection):
        self.connection = connection
        self.counter = 0

    def read(self):
        header = bytearray()
        while True:
            char = self.connection.recv(1)
            if not char:
                raise RuntimeError("Marionette disconnected")
            if char == b":":
                break
            header.extend(char)
            if len(header) > 12:
                raise RuntimeError("Invalid Marionette frame")
        count = int(header)
        assert 0 <= count <= 10_000_000
        body = bytearray()
        while len(body) < count:
            part = self.connection.recv(count - len(body))
            if not part:
                raise RuntimeError("Truncated Marionette frame")
            body.extend(part)
        return json.loads(body)

    def command(self, name, params):
        self.counter += 1
        data = json.dumps([0, self.counter, name, params]).encode()
        self.connection.sendall(str(len(data)).encode() + b":" + data)
        while True:
            response = self.read()
            if isinstance(response, list) and response[:2] == [1, self.counter]:
                if response[2]:
                    raise RuntimeError(response[2])
                return response[3]


def validate(report, output):
    assert platform.system() == "Windows", "Native Windows is required"
    tag = os.environ["RELEASE_TAG"]
    commit = os.environ["SOURCE_COMMIT"]
    build_id = os.environ["EXPECTED_BUILD_ID"]
    locale = os.environ.get("EXPECTED_UI_LOCALE", "zh-CN")
    package_sha = os.environ["PACKAGE_SHA256"].lower()
    assert re.fullmatch(r"v[0-9][0-9A-Za-z.-]*", tag)
    assert re.fullmatch(r"[0-9a-f]{40}", commit)
    assert re.fullmatch(r"[0-9]{14}", build_id)
    assert re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*", locale)
    assert re.fullmatch(r"[0-9a-f]{64}", package_sha)
    package = Path("candidate") / f"web-reverse-{tag}-windows-x86_64.zip"
    assert sha(package) == package_sha
    report.update(platform="Windows", source_commit=commit, package_sha256=package_sha)
    with temporary_workspace() as work:
        work = Path(work)
        with zipfile.ZipFile(package) as archive:
            for name in archive.namelist():
                target = (work / name).resolve()
                assert target.is_relative_to(work.resolve()), "Unsafe ZIP path"
            assert archive.testzip() is None
            archive.extractall(work)
        root = work / "firefox"
        executable = root / "firefox.exe"
        for name in ["msvcp140.dll", "msvcp140_atomic_wait.dll", "vcruntime140.dll", "vcruntime140_1.dll"]:
            assert (root / name).stat().st_size > 0, f"Missing browser runtime: {name}"
        report["binary_sha256"] = sha(executable)
        ini = configparser.ConfigParser()
        ini.read(root / "application.ini", encoding="utf-8")
        assert ini["App"]["BuildID"] == build_id
        assert ini["App"]["SourceStamp"] == commit
        assert ini["App"]["CodeName"] == "Web Reverse"
        expected_ledger = subprocess.check_output([
            "git", "show", f"{commit}:additions/browser/components/agent-sidebar/modules/backends/LedgerBackend.sys.mjs"
        ])
        with zipfile.ZipFile(root / "browser/omni.ja") as archive:
            assert archive.read("modules/agentsidebar/backends/LedgerBackend.sys.mjs") == expected_ledger
            context_menu = archive.read(f"localization/{locale}/browser/browserContext.ftl").decode()
            assert "main-context-menu-back" in context_menu
            if locale == "zh-CN":
                assert "右击或下拉显示历史" in context_menu
        expected_runtimes = json.loads((root / "runtimes/MANIFEST.json").read_text(encoding="utf-8"))

        profile = work / "screenshot-profile"
        profile.mkdir()
        screenshot = output / "windows-native.png"
        process = None
        try:
            with (output / "screenshot.log").open("wb") as log:
                process = subprocess.Popen([
                    str(executable), "--headless", "--no-remote", "--no-deelevate", "--wait-for-browser", "--profile", str(profile),
                    "--screenshot", str(screenshot),
                    "data:text/html,%3Cbody%3EWeb%20Reverse%20native%20validation%3C/body%3E"
                ], stdout=log, stderr=log)
                report["screenshot_exit_code"] = process.wait(timeout=90)
            assert report["screenshot_exit_code"] == 0
            image = screenshot.read_bytes()
            assert image[:8] == b"\x89PNG\r\n\x1a\n"
            width, height = struct.unpack(">II", image[16:24])
            assert width > 0 and height > 0
            report.update(screenshot_sha256=sha(screenshot), screenshot_size=len(image))
        finally:
            stop(process)

        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        profile = work / "ledger-profile"
        profile.mkdir()
        env = dict(os.environ, MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS=json.dumps({"marionette.port": port}))
        process = None
        connection = None
        try:
            with (output / "ledger.log").open("wb") as log:
                process = subprocess.Popen([str(executable), "-headless", "-no-remote", "-no-deelevate", "-wait-for-browser", "-profile", str(profile),
                    "-marionette", "-remote-allow-system-access", "about:blank"], env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 60
                while connection is None:
                    assert process.poll() is None, "Browser exited before Marionette"
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=2)
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.25)
                connection.settimeout(60)
                wire = Wire(connection)
                wire.read()
                wire.command("WebDriver:NewSession", {})
                wire.command("Marionette:SetContext", {"value": "chrome"})
                result = wire.command("WebDriver:ExecuteAsyncScript", {
                    "script": r"""
                    const done=arguments[arguments.length-1];
                    const expectedRuntimes=arguments[0];
                    (async()=>{
                      const brand=Services.strings.createBundle('chrome://branding/locale/brand.properties');
                      if(brand.GetStringFromName('brandFullName')!=='Web Reverse')throw new Error('stale Windows brand');
                      const {LedgerBackend}=ChromeUtils.importESModule('resource:///modules/agentsidebar/backends/LedgerBackend.sys.mjs');
                      const ledger=new LedgerBackend();
                      const workspace=PathUtils.join(PathUtils.profileDir,'native-ledger');
                      await IOUtils.makeDirectory(workspace);
                      const ctx={workspaceRoot:workspace};
                      const text="native payload '); DROP TABLE mem;--";
                      await ledger.append({text},ctx);
                      const recall=await ledger.recall({query:'payload'},ctx);
                      if(recall.count!==1 || recall.results[0].text!==text)throw new Error('roundtrip failed');
                      const duplicate=await ledger.append({text},ctx);
                      if(duplicate.dedup!==1||duplicate.added!==0)throw new Error('dedup failed');
                      if((await ledger.recall({},{workspaceRoot:workspace+'-other'})).count!==0)throw new Error('scope leak');
                      await ledger._addMany(Array.from({length:125},(_,i)=>({kind:'observation',text:'uniq'+i})),ctx);
                      const count=(await ledger._contextRows(ctx)).filter(row=>row.kind==='observation').length;
                      if(count!==125)throw new Error('retention failed');
                      let rejected=false;try{await ledger.recall({scope:'site OR 1=1'},ctx);}catch(e){rejected=/invalid recall scope/.test(String(e));}
                      if(!rejected)throw new Error('allowlist failed');
                      await ledger.close();
                      const {runAgentTurn}=ChromeUtils.importESModule('resource:///modules/agentsidebar/runtime/AgentLoop.sys.mjs');
                      const {ToolRouter}=ChromeUtils.importESModule('resource:///modules/agentsidebar/tools/ToolRouter.sys.mjs');
                      let rounds=0,actions=0;
                      const router=new ToolRouter().register({name:'fs_read',handler:()=>{actions++;return {value:42};}});
                      const loop=await runAgentTurn({router,maxRounds:6,
                        messages:[{role:'user',content:'Inspect the target file and verify the result.'}],
                        client:{chat:async()=>{
                          rounds++;
                          if(rounds===1)return {content:'I will inspect the target file.',toolCalls:[],finishReason:'stop'};
                          if(rounds===2)return {content:'',toolCalls:[{id:'smoke',type:'function',function:{name:'fs_read',arguments:'{}'}}],finishReason:'tool_calls'};
                          return {content:'The verified result is 42.',toolCalls:[],finishReason:'stop'};
                        }}
                      });
                      if(rounds!==3||actions!==1||loop.stopReason!=='final')throw new Error('automatic continuation failed');
                      const {setupBundledRuntimePath}=ChromeUtils.importESModule('resource:///modules/agentsidebar/host/BundledRuntimes.sys.mjs');
                      Services.env.set('PATH',Services.env.get('SystemRoot')+'\\System32');
                      setupBundledRuntimePath();
                      const {getBackends}=ChromeUtils.importESModule('resource:///modules/agentsidebar/backends/Backends.sys.mjs');
                      const runner=getBackends().workspace;
                      const runtimeRoot=PathUtils.join(Services.dirsvc.get('GreD',Ci.nsIFile).path,'runtimes');
                      for(const kind of ['node','python']){
                        const executable=await runner._resolveExe(kind);
                        if(PathUtils.parent(executable).toLowerCase()!==PathUtils.join(runtimeRoot,kind).toLowerCase())throw new Error('system runtime selected instead of bundled '+kind);
                      }
                      await IOUtils.writeUTF8(PathUtils.join(workspace,'bundled_local.py'),'value=42\n');
                      const nr=await runner.runNode({code:'console.log(process.version)'},ctx);
                      const pr=await runner.runPython({code:"import sys,json,ssl,sqlite3,pip,bundled_local; print(json.dumps({'python':sys.version.split()[0],'pip':pip.__version__,'local':bundled_local.value}))"},ctx);
                      const np=await runner._spawn(PathUtils.join(runtimeRoot,'node','node.exe'),[PathUtils.join(runtimeRoot,'node','node_modules','npm','bin','npm-cli.js'),'--version'],{root:workspace});
                      if(!nr.ok||!pr.ok||np.exitCode!==0)throw new Error('bundled runtime execution failed');
                      const python=JSON.parse(pr.output.trim());
                      if(nr.output.trim()!=='v'+expectedRuntimes.node.version||python.python!==expectedRuntimes.python.version||python.pip!==expectedRuntimes.pip.version||python.local!==42)throw new Error('bundled runtime version/import mismatch');
                      const scripts=PathUtils.join(workspace,'子目录 scripts');
                      await IOUtils.makeDirectory(scripts);
                      await IOUtils.writeUTF8(PathUtils.join(scripts,'sibling_helper.py'),'value=43\n');
                      await IOUtils.writeUTF8(PathUtils.join(scripts,'check.py'),'import sibling_helper; print(sibling_helper.value)\n');
                      const sibling=await runner.runPython({file:'子目录 scripts/check.py'},ctx);
                      if(!sibling.ok||sibling.output.trim()!=='43')throw new Error('script sibling import failed');
                      const win=Services.wm.getMostRecentWindow('navigator:browser');
                      await win.SidebarController.show('viewAgentSidebar');
                      let sidebarTitle='';
                      for(let i=0;i<100;i++){
                        const sidebar=win.SidebarController.browser||win.document.getElementById('sidebar');
                        sidebarTitle=sidebar?.contentDocument?.querySelector('.agent-panel__title')?.textContent?.trim()||'';
                        if(sidebarTitle==='Web Reverse')break;
                        await new Promise(resolve=>win.setTimeout(resolve,100));
                      }
                      if(sidebarTitle!=='Web Reverse')throw new Error('stale Windows sidebar title: '+sidebarTitle);
                      return {passed:true,build:Services.appinfo.appBuildID,version:Services.prefs.getStringPref('extensions.browser-agent.version'),runtimes:{node:nr.output.trim(),npm:np.output.trim(),...python},checks:['Web Reverse brand','rendered sidebar title','roundtrip','dedup','scope','retention','allowlist','auto-continue','bundled-node','bundled-npm','bundled-python','bundled-pip','workspace-import','script-sibling-import']};
                    })().then(done,e=>done({error:String(e),stack:e?.stack}));
                    """, "args": [expected_runtimes], "newSandbox": False, "scriptTimeout": 60000,
                })
                result = result.get("value", result)
                assert result.get("passed") is True, result
                assert result["build"] == build_id and result["version"] == tag[1:]
                report.update(runtime_build_id=result["build"], ledger_passed=True, ledger_checks=result["checks"])
                report["bundled_runtimes"] = result["runtimes"]
                wire.command("Marionette:Quit", {})
                report["ledger_exit_code"] = process.wait(timeout=30)
                assert report["ledger_exit_code"] == 0
        finally:
            if connection:
                connection.close()
            stop(process)
    report["status"] = "passed"


if __name__ == "__main__":
    output = Path("native-report").resolve()
    output.mkdir(exist_ok=True)
    report = {"status": "failed", "run_id": os.environ.get("GITHUB_RUN_ID")}
    try:
        validate(report, output)
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (output / "WINDOWS-NATIVE-REPORT.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
