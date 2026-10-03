// Actual OS-process integration through a Node implementation of the Firefox
// Subprocess port. This does not claim to test native Firefox Subprocess itself.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, createHttpTransport } from "../modules/mcp/McpClient.sys.mjs";
import { createFirefoxStdioTransport, resolveMcpCommand } from "../modules/host/FirefoxMcpTransport.sys.mjs";

// Resolver contracts are platform simulations, independent of installed Python.
const win = path.win32;
const nodeExe = "C:/Program Files/Node/node.exe";
const cli = win.join("C:/Program Files/Node", "node_modules", "npm", "bin", "npx-cli.js");
const searches = [];
const deps = { windows: true,
  workspace: { _resolveExe: async () => nodeExe, _mergedPath: () => "C:/merged" },
  Subprocess: { getEnvironment: () => ({ Path: "C:/original", HOME: "home" }),
    pathSearch: async (command, env) => { searches.push({ command, env }); return `C:/tools/${command}.exe`; } },
  PathUtils: { ...win, parent: win.dirname }, IOUtils: { exists: async value => value === cli }, getEnv: () => "" };
const literalArgs = ["--yes", "package name", "& echo not-a-command", "$(not-a-command)", "a^b|c"];
const resolvedNpx = await resolveMcpCommand({ command: "npx.cmd", args: literalArgs }, {}, deps);
assert.equal(resolvedNpx.command, nodeExe);
assert.deepEqual(resolvedNpx.args, [cli, ...literalArgs]);
assert.equal(resolvedNpx.env.PATH, "C:/merged");
assert.equal(resolvedNpx.env.Path, undefined, "Windows environment has only one PATH spelling");
await assert.rejects(resolveMcpCommand({ command: "C:/tools/script.cmd" }, {}, deps));
await assert.rejects(resolveMcpCommand({ command: "C:/tools/script.bat" }, {}, deps));
await assert.rejects(resolveMcpCommand({ command: "tool", cwd: "relative" }, {}, deps));
const ordinary = await resolveMcpCommand({ command: "tool", cwd: "C:/work" }, { pAtH: "C:/override" }, deps);
assert.equal(ordinary.command, "C:/tools/tool.exe");
assert.equal(searches.at(-1).env.PATH, "C:/override");
assert.equal(ordinary.env.Path, undefined);
assert.equal(ordinary.env.pAtH, undefined);
assert.equal(ordinary.env.PATH, "C:/override");
const customNode = "D:/Custom Node/node.exe";
const customCli = win.join("D:/Custom Node", "node_modules", "npm", "bin", "npx-cli.js");
const overrideDeps = { ...deps, Subprocess: { ...deps.Subprocess,
  pathSearch: async (command, env) => { assert.equal(command, "node.exe"); assert.equal(env.PATH, "D:/Custom Node"); return customNode; } },
  IOUtils: { exists: async value => value === customCli } };
const customNpx = await resolveMcpCommand({ command: "npx", args: literalArgs }, { Path: "D:/Custom Node" }, overrideDeps);
assert.equal(customNpx.command, customNode);
assert.deepEqual(customNpx.args, [customCli, ...literalArgs]);
await assert.rejects(resolveMcpCommand({ command: "npx" }, { PATH: "missing" }, {
  ...deps, Subprocess: { ...deps.Subprocess, pathSearch: async () => { throw Error("missing"); } } }), /Configured PATH/);
// Only explicitly tagged local diagnostics survive transport-error redaction.
const localFailure = Object.assign(Error("Local executable unavailable"), { mcpUserMessage: "Local executable unavailable" });
for (const error of [localFailure, Error("secret-bearing transport exception")]) {
  const failing = new McpClient({ transport: { start: async () => { throw error; }, close() {} } });
  await assert.rejects(failing.connect(), rejected => error === localFailure
    ? rejected === localFailure : rejected.message === "MCP transport failed");
}
const unix = await resolveMcpCommand({ command: "/usr/bin/python3" }, { path: "not-PATH" }, {
  ...deps, windows: false, PathUtils: { ...path.posix, parent: path.posix.dirname },
  Subprocess: { ...deps.Subprocess, getEnvironment: () => ({ PATH: "/usr/bin" }) } });
assert.equal(unix.env.PATH, "C:/merged", "Unix lowercase path does not override PATH");

const candidates = process.env.MCP_TEST_PYTHON ? [process.env.MCP_TEST_PYTHON]
  : process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
const python = candidates.find(command => spawnSync(command, ["--version"], { windowsHide: true }).status === 0);
if (!python) {
  if (process.env.MCP_TEST_PYTHON) throw new Error("MCP_TEST_PYTHON is not executable");
  console.log("SKIP MCP process integration: Python is not available");
  process.exit(0);
}
const fixture = fileURLToPath(new URL("./mcp-fixture.py", import.meta.url));
function readable(stream) {
  stream.setEncoding("utf8");
  const iterator = stream[Symbol.asyncIterator]();
  return { async readString() { const { value, done } = await iterator.next(); return done ? "" : value; } };
}
const children = [];
function launch(args, options = {}) {
  const child = spawn(python, ["-u", fixture, ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, ...options });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  children.push({ child, exited });
  return { child, exited };
}
const Subprocess = { async call(options) {
  assert.equal(options.command, python);
  assert.equal(options.stderr, "pipe");
  assert.deepEqual(options.arguments.slice(0, 2), ["-u", fixture]);
  const { child, exited } = launch(options.arguments.slice(2), { cwd: options.workdir, env: { ...process.env, ...options.environment } });
  return { stdout: readable(child.stdout), stderr: readable(child.stderr),
    stdin: { write: value => new Promise((resolve, reject) => child.stdin.write(value, "utf8", error => error ? reject(error) : resolve())) },
    wait: () => exited, kill: () => child.kill() };
} };
const deadline = (promise, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("integration timeout")), ms); })]).finally(() => clearTimeout(timer));
};
let stderr = "";
function stdioClient() {
  return new McpClient({ timeoutMs: 5000, transport: createFirefoxStdioTransport({ Subprocess,
    config: { command: python, args: ["-u", fixture] },
    resolveCommand: async config => ({ command: config.command, args: config.args, env: {} }),
    onStderr: chunk => { stderr += chunk; } }) });
}
const unicode = "\u4f60\u597d MCP \ud83c\udf0d";
const clients = [];
try {
  const local = stdioClient(); clients.push(local);
  await local.connect();
  assert.equal((await local.listTools())[0].name, "echo");
  assert.equal((await local.callTool("echo", { value: unicode })).content[0].text, unicode);
  const cancel = new AbortController();
  const cancelled = local.callTool("echo", { value: "cancel me", delayMs: 150 }, { signal: cancel.signal });
  setTimeout(() => cancel.abort(), 30);
  await assert.rejects(cancelled, /cancelled/);
  assert.equal((await local.callTool("echo", { value: "after cancellation" })).content[0].text, "after cancellation");
  assert.equal(local.pending.size, 0);
  assert.match(stderr, /fixture diagnostics/);
  const pending = local.callTool("echo", { value: "close me", delayMs: 500 });
  const closed = assert.rejects(pending, /closed/);
  setTimeout(() => local.close(), 30);
  await closed;
  await deadline(children[0].exited);

  const remoteProcess = launch(["--http"]);
  const output = readable(remoteProcess.child.stdout);
  let portText = "";
  while (!portText.includes("\n")) portText += await deadline(output.readString());
  const port = Number(portText.trim());
  assert(port > 0);
  const requests = [];
  const remote = new McpClient({ transport: createHttpTransport({ url: `http://127.0.0.1:${port}/mcp`,
    fetch: (url, options) => { requests.push(options); return fetch(url, options); } }), timeoutMs: 5000 });
  clients.push(remote);
  await remote.connect();
  assert.equal((await remote.listTools())[0].name, "echo");
  assert.equal((await remote.callTool("echo", { value: unicode })).content[0].text, unicode);
  assert.equal(requests.at(-1).headers.get("Mcp-Session-Id"), "native-test-session");
  assert.equal(requests.at(-1).headers.get("Mcp-Protocol-Version"), "2025-11-25");
  const httpCancel = new AbortController();
  const httpPending = remote.callTool("echo", { value: "http cancel", delayMs: 150 }, { signal: httpCancel.signal });
  setTimeout(() => httpCancel.abort(), 30);
  await assert.rejects(httpPending, /cancelled/);
  assert.equal((await remote.callTool("echo", { value: "still connected" })).content[0].text, "still connected");
  remote.close();
  await new Promise(resolve => setImmediate(resolve));
  assert(requests.some(request => request.method === "DELETE"));
  console.log(`MCP real process + HTTP integration passed (${process.platform}; Node Subprocess port adapter)`);
} finally {
  for (const client of clients) client.close();
  for (const { child } of children) child.kill();
  await Promise.all(children.map(({ exited }) => deadline(exited)));
}
