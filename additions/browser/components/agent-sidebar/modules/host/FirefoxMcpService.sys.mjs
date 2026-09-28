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
  manager = new McpManager({ store, router, async createClient(config, credentials, hooks) {
    const transport = config.transport === "stdio" ? createFirefoxStdioTransport({
      Subprocess, config, env: credentials.env, onStderr: hooks.onStderr,
      resolveCommand: (config, env) => resolveMcpCommand(config, env, {
        windows: Services.appinfo.OS === "WINNT", workspace: getBackends().workspace,
        Subprocess, PathUtils, IOUtils, getEnv: key => Services.env.get(key),
      }),
    }) : createHttpTransport({ url: config.url, headers: credentials.headers, fetch: (...args) => globalThis.fetch(...args), setTimeout, clearTimeout });
    return new McpClient({ transport, setTimeout, clearTimeout, onNotification: hooks.onNotification });
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
