/* Profile-scoped Firefox MCP composition root. No credentials enter normal prefs. */
import { McpConfigStore } from "../mcp/McpConfigStore.sys.mjs";
import { McpManager } from "../mcp/McpManager.sys.mjs";
import { McpClient, createHttpTransport } from "../mcp/McpClient.sys.mjs";
import { createFirefoxStdioTransport, resolveMcpCommand } from "./FirefoxMcpTransport.sys.mjs";
import { getBackends } from "../backends/Backends.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", "nsILoginInfo", "init");
const ORIGIN = "chrome://browser-agent";
const REALM = "MCP service credentials";
let manager = null;
export async function resolveFirefoxMcpWorkspace(root) {
  if (typeof root !== "string" || !PathUtils.isAbsolute(root)) throw new Error("MCP 工作目录必须是本机绝对路径");
  // IOUtils has no realPath in the supported Firefox build. nsIFile.normalize
  // is the native path canonicalizer (realpath on Unix); the server also checks
  // real paths when enforcing its allowedRoots policy.
  const directory = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  directory.initWithPath(root);
  directory.normalize();
  if ((await IOUtils.stat(directory.path)).type !== "directory") throw new Error("MCP 工作目录不存在或不是目录");
  return directory.path;
}
async function findLogin(id) {
  await Services.logins.initializationPromise;
  return Services.logins.findLogins(ORIGIN, null, REALM).find(login => login.username === id);
}
export function initializeMcp(router) {
  if (manager) return manager;
  const path = PathUtils.join(PathUtils.profileDir, "firefox-reverse-agent", "mcp.json");
  const store = new McpConfigStore({
    async read() { return await IOUtils.exists(path) ? IOUtils.readJSON(path) : null; },
    async write(data) {
      await IOUtils.makeDirectory(PathUtils.parent(path), { createAncestors: true, ignoreExisting: true });
      await IOUtils.writeJSON(path, data, { tmpPath: path + ".tmp" });
      await IOUtils.setPermissions(path, 0o600);
    },
    async readSecret(id) {
      const login = await findLogin(id);
      if (!login) return null;
      try { return JSON.parse(login.password); } catch { throw new Error("MCP 凭证损坏，请重新保存该服务的凭证"); }
    },
    async writeSecret(id, secret) {
      const existing = await findLogin(id);
      const login = new LoginInfo(ORIGIN, null, REALM, id, JSON.stringify(secret), "", "");
      if (existing) await Services.logins.modifyLoginAsync(existing, login); else await Services.logins.addLoginAsync(login);
    },
    async deleteSecret(id) { const login = await findLogin(id); if (login) await Services.logins.removeLoginAsync(login); },
    newId: () => Services.uuid.generateUUID().toString().replace(/[{}-]/g, ""),
  });
  manager = new McpManager({ store, router, resolveWorkspace: resolveFirefoxMcpWorkspace, async createClient(config, credentials, hooks) {
    const transport = config.transport === "stdio" ? createFirefoxStdioTransport({
      Subprocess, config, env: credentials.env, onStderr: hooks.onStderr,
      resolveCommand: (config, env) => resolveMcpCommand(config, env, {
        windows: Services.appinfo.OS === "WINNT", workspace: getBackends().workspace,
        Subprocess, PathUtils, IOUtils, getEnv: key => Services.env.get(key),
      }),
    }) : createHttpTransport({ timeoutMs: config.timeoutMs || 120000, url: config.url, headers: credentials.headers, fetch: (...args) => globalThis.fetch(...args), setTimeout, clearTimeout });
    const secretValues = [...Object.values(credentials.env || {}), ...Object.values(credentials.headers || {}).flatMap(value => [value, ...(/^(?:Bearer|Basic)\s+(.+)$/i.exec(value)?.slice(1) || [])])].filter(Boolean).sort((a, b) => b.length - a.length);
    const redact = value => secretValues.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
    return new McpClient({ transport, timeoutMs: config.timeoutMs || 120000, setTimeout, clearTimeout,
      onNotification: hooks.onNotification, onRequest: hooks.onRequest, capabilities: hooks.capabilities, redact });
  } });
  Services.obs.addObserver(() => manager.close(), "quit-application-granted");
  return manager;
}
function service() {
  if (!manager) {
    const { firefoxAgentRuntimeHost } = ChromeUtils.importESModule("resource:///modules/agentsidebar/host/FirefoxAgentRuntimeHost.sys.mjs");
    firefoxAgentRuntimeHost.router();
  }
  return manager;
}
// UI receives only this administration facade, never a raw credential store.
export const mcpService = Object.freeze(Object.fromEntries([
  "list", "save", "remove", "setEnabled", "setPolicy", "test", "reconnect", "previewImport", "importConfig", "exportConfig",
].map(name => [name, (...args) => service()[name](...args)])));
