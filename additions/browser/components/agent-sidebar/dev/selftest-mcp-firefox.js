/* Run with xpcshell and MCP_TEST_ROOT set to this checkout's absolute path.
 * Linux: set LD_LIBRARY_PATH to dist/bin and MOZ_DISABLE_SOCKET_PROCESS=1,
 * matching the upstream xpcshell harness. No user profile is required.
 */
const root = Services.env.get("MCP_TEST_ROOT");
if (!root) throw new Error("MCP_TEST_ROOT is required");
const moduleRoot = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
moduleRoot.initWithPath(root + "/additions/browser/components/agent-sidebar/");
Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler)
  .setSubstitution("mcp-native-test", Services.io.newFileURI(moduleRoot));
function moduleUrl(relative) { return "resource://mcp-native-test/" + relative; }
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { McpClient, createHttpTransport } = ChromeUtils.importESModule(moduleUrl("modules/mcp/McpClient.sys.mjs"));
const { createFirefoxStdioTransport } = ChromeUtils.importESModule(moduleUrl("modules/host/FirefoxMcpTransport.sys.mjs"));
const fixture = root + "/additions/browser/components/agent-sidebar/dev/mcp-fixture.py";
const python = Services.env.get("MCP_TEST_PYTHON") || "/usr/bin/python3";
function check(value, description) { if (!value) throw new Error(description); print("PASS " + description); }
async function testProfileStorage() {
  const requested = Services.env.get("MCP_TEST_PROFILE");
  if (!requested) { print("SKIP profile storage (MCP_TEST_PROFILE not set)"); return; }
  const sandbox = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  sandbox.initWithPath(root + "/.tmp");
  sandbox.normalize();
  const profile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  profile.initWithPath(requested);
  const parent = profile.parent;
  parent.normalize();
  if (!parent.equals(sandbox) || !/^mcp-[a-zA-Z0-9_-]+$/.test(profile.leafName) || profile.exists()) {
    throw new Error("MCP_TEST_PROFILE must be a NEW dedicated directory under checkout/.tmp");
  }
  await IOUtils.makeDirectory(profile.path, { createAncestors: true });
  Services.dirsvc.QueryInterface(Ci.nsIDirectoryService).registerProvider({
    getFile(prop, persistent) {
      persistent.value = true;
      return ["ProfD", "ProfLD", "ProfDS", "ProfLDS"].includes(prop) ? profile.clone() : null;
    },
    QueryInterface: ChromeUtils.generateQI(["nsIDirectoryServiceProvider"]),
  });
  Services.obs.notifyObservers(null, "profile-do-change", "mcp-native-test");
  check(PathUtils.profileDir === profile.path, "dedicated test profile selected");
  const { ToolRouter } = ChromeUtils.importESModule(moduleUrl("modules/tools/ToolRouter.sys.mjs"));
  const { initializeMcp } = ChromeUtils.importESModule(moduleUrl("modules/host/FirefoxMcpService.sys.mjs"));
  const manager = initializeMcp(new ToolRouter());
  try {
    check((await manager.list()).length === 0, "fresh profile has no MCP configuration");
    const token = "native-storage-test-token-" + Date.now();
    const saved = await manager.save({ name: "native-storage-fixture", transport: "http", url: "http://127.0.0.1:1/mcp", enabled: false, headers: { Authorization: "Bearer " + token } });
    check(!(JSON.stringify(await manager.list()).includes(token)), "list excludes encrypted credential");
    check(!(JSON.stringify(await manager.exportConfig()).includes(token)), "export excludes encrypted credential");
    const credentials = await manager.store.credentials(saved.id);
    check(credentials.headers.Authorization === "Bearer " + token, "Firefox Login Manager round trips credential");
    const persisted = await IOUtils.readUTF8(PathUtils.join(profile.path, "firefox-reverse-agent", "mcp.json"));
    check(!persisted.includes(token), "profile JSON contains no credential value");
    await manager.save({ ...saved, headers: { Authorization: "Bearer updated-native-token" } });
    check((await manager.store.credentials(saved.id)).headers.Authorization === "Bearer updated-native-token", "native encrypted credential update");
    await manager.remove(saved.id);
    check((await manager.list()).length === 0, "native configuration removal");
    const remaining = await manager.store.credentials(saved.id);
    check(!remaining.headers?.Authorization, "native credential removal");
  } finally { manager.close(); }
}
async function main() {
  await testProfileStorage();
  let child, stderr = false;
  const subprocess = { async call(options) { child = await Subprocess.call(options); return child; } };
  const stdio = createFirefoxStdioTransport({ Subprocess: subprocess, config: { cwd: root },
    resolveCommand: async () => ({ command: python, args: [fixture], env: {} }), onStderr: () => { stderr = true; } });
  const client = new McpClient({ transport: stdio, setTimeout, clearTimeout });
  let server;
  try {
    await client.connect();
    check((await client.listTools())[0].name === "echo", "native stdio discovery");
    check((await client.callTool("echo", { value: "原生管道" })).content[0].text === "原生管道", "native UTF-8 stdio call");
    check(stderr, "stderr is separate from protocol stdout");
    client.close();
    await child.wait();
    check(client.closed, "native child terminates on close");
    server = await Subprocess.call({ command: python, arguments: [fixture, "--http"], stderr: "pipe" });
    const port = parseInt(await server.stdout.readString(), 10);
    check(port > 0, "local HTTP fixture started");
    const remote = new McpClient({ transport: createHttpTransport({ url: `http://127.0.0.1:${port}/mcp`, setTimeout, clearTimeout }), setTimeout, clearTimeout });
    try {
      await remote.connect();
      check((await remote.listTools())[0].name === "echo", "Firefox fetch HTTP discovery");
      check((await remote.callTool("echo", { value: "remote" })).content[0].text === "remote", "Firefox fetch HTTP call");
    } finally { remote.close(); }
  } finally {
    client.close();
    if (server) { server.kill(); await server.wait(); }
    if (child) { child.kill(); await child.wait(); }
  }
}
let done = false, status = 0;
main().then(() => { done = true; }, error => { print(String(error) + "\n" + (error.stack || "")); status = 1; done = true; });
Services.tm.spinEventLoopUntil("mcp-native-test", () => done);
if (Services.env.get("MCP_TEST_PROFILE")) {
  for (const phase of ["SHUTDOWN_PHASE_APPSHUTDOWNNETTEARDOWN", "SHUTDOWN_PHASE_APPSHUTDOWNTEARDOWN", "SHUTDOWN_PHASE_APPSHUTDOWN", "SHUTDOWN_PHASE_APPSHUTDOWNQM"]) {
    Services.startup.advanceShutdownPhase(Services.startup[phase]);
  }
}
quit(status);
