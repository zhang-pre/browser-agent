/* MCP lifecycle and ToolRouter adapter; all platform operations are injected. */
import { previewMcpImport } from "./McpConfigStore.sys.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function catalogKey(tools) {
  return JSON.stringify(stable(tools.slice().sort((a, b) => String(a?.name).localeCompare(String(b?.name)))));
}
function hash(text) {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return (n >>> 0).toString(16).padStart(8, "0");
}
export function mcpToolAlias(serverId, name) {
  return `mcp_${serverId.slice(0, 32)}_${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 16)}_${hash(name)}`;
}
export function adaptMcpResult(result) {
  if (!result || typeof result !== "object") throw new Error("MCP 工具返回值无效");
  const content = [], media = [];
  for (const item of result.content || []) {
    if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
    else if (item.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(item.mimeType) && typeof item.data === "string" && item.data.length <= 12_000_000 && /^[A-Za-z0-9+/=\r\n]*$/.test(item.data)) {
      media.push({ type: "image", dataUrl: `data:${item.mimeType};base64,${item.data}` });
    } else content.push({ type: "text", text: `[暂不支持此 MCP 内容类型：${String(item.type || "unknown").slice(0, 60)}]` });
  }
  if (result.isError) throw new Error(content.filter(c => c.type === "text").map(c => c.text).join("\n").slice(0, 20000) || "MCP 服务报告工具执行失败");
  return { content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), ...(media.length ? { _media: media } : {}) };
}
export class McpManager {
  constructor({ store, router, createClient, createAbortController = () => new AbortController(), now = () => Date.now() }) {
    Object.assign(this, { store, router, createClient, createAbortController, now });
    this.entries = new Map();
    this.closed = false;
    this._edits = Promise.resolve();
    router.setPrepareHook(ctx => this.prepare(ctx));
  }
  _edit(fn) {
    const task = this._edits.then(() => { if (this.closed) throw new Error("MCP 管理器已关闭"); return fn(); });
    this._edits = task.catch(() => {});
    return task;
  }
  _log(entry, message) {
    // Do not retain raw server stderr / protocol errors: they can contain credentials.
    entry.logs.push({ time: this.now(), message });
    if (entry.logs.length > 40) entry.logs.shift();
  }
  _invalidate(id) {
    const entry = this.entries.get(id);
    if (entry) {
      entry.invalid = true;
      for (const { controller } of entry.calls.values()) controller.abort();
      entry.client?.close();
      this.entries.delete(id);
    }
    this.router.removeSource(id);
  }
  async list() {
    return (await this.store.list()).map(config => {
      const entry = this.entries.get(config.id);
      if (entry?.status === "connected" && entry.client?.closed) { entry.status = "error"; entry.error = "MCP 连接已断开，请重连"; this.router.removeSource(config.id); }
      return { ...config, status: entry?.status || (config.enabled ? "disconnected" : "disabled"), error: entry?.error || "",
        tools: (entry?.tools || []).map(t => ({ name: t.name, description: t.description || "", policy: ["allow", "deny"].includes(config.policies?.[t.name]) ? config.policies[t.name] : "ask" })),
        logs: entry?.logs.slice() || [] };
    });
  }
  async save(config) {
    return this._edit(async () => {
      const saved = await this.store.save(config);
      this._invalidate(saved.id);
      return saved;
    });
  }
  async remove(id) { return this._edit(async () => { try { await this.store.remove(id); } finally { this._invalidate(id); } }); }
  async setEnabled(id, enabled) { return this._edit(async () => { await this.store.setEnabled(id, enabled); this._invalidate(id); }); }
  async setPolicy(id, name, policy) {
    return this._edit(async () => {
      await this.store.setPolicy(id, name, policy);
      if (policy === "deny") for (const call of this.entries.get(id)?.calls.values() || []) if (call.name === name) call.controller.abort();
    });
  }
  async previewImport(text) {
    const preview = previewMcpImport(text);
    // The UI preview intentionally excludes secret values.
    return { warnings: preview.warnings, servers: preview.servers.map(({ env, headers, ...s }) => ({ ...s, envKeys: Object.keys(env || {}), headerKeys: Object.keys(headers || {}) })) };
  }
  async importConfig(text) {
    const { servers, warnings } = previewMcpImport(text);
    return this._edit(async () => {
      const current = await this.store.list();
      for (const config of servers) if (current.some(s => s.name === config.name)) throw new Error(`服务 ${config.name} 已存在，请先重命名或删除`);
      const saved = [];
      try { for (const config of servers) saved.push(await this.store.save(config)); }
      catch (error) { for (const config of saved) await this.store.remove(config.id); throw error; }
      return { servers: saved, warnings };
    });
  }
  async exportConfig() { return this.store.exportConfig(); }
  async prepare({ signal } = {}) {
    await this._edits;
    if (this.closed || signal?.aborted) return;
    const enabled = (await this.store.list()).filter(s => s.enabled);
    const operation = Promise.allSettled(enabled.map(s => this._connect(s)));
    if (!signal) { await operation; return; }
    // Cancelling one Agent must not tear down another Agent's shared connection.
    await new Promise(resolve => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      signal.addEventListener("abort", done, { once: true });
      operation.then(done);
      if (signal.aborted) done();
    });
  }
  async test(id) {
    await this._edits;
    const config = (await this.store.list()).find(s => s.id === id);
    if (!config) throw new Error("服务不存在");
    // Explicit test may launch a disabled service, but never publishes its tools.
    await this._connect(config, true);
    return (await this.list()).find(s => s.id === id);
  }
  async reconnect(id) { await this._edits; this._invalidate(id); return this.test(id); }
  async _connect(config, explicit = false) {
    if (this.closed) throw new Error("MCP 管理器已关闭");
    let entry = this.entries.get(config.id);
    if (entry?.promise) return entry.promise;
    if (entry?.status === "connected" && !entry.client?.closed) return entry.refreshNeeded || config.transport === "http" || explicit ? this._refresh(entry) : entry;
    if (entry) this._invalidate(config.id);
    entry = { config, status: "connecting", error: "", logs: [], tools: [], calls: new Map(), invalid: false, client: null, promise: null };
    this.entries.set(config.id, entry);
    this._log(entry, explicit ? "用户请求测试或重连" : "连接已启用服务");
    entry.promise = (async () => {
      try {
        const credentials = await this.store.credentials(config.id);
        if (entry.invalid || this.closed) throw new Error("配置已变更");
        entry.client = await this.createClient(config, credentials, {
          onStderr: () => { if (!entry.stderrSeen) { entry.stderrSeen = true; this._log(entry, "服务写入了 stderr（原文不记录，以免泄露凭证）"); } },
          onNotification: message => { const current = this.entries.get(config.id); if (current?.client === entry.client && message.method === "notifications/tools/list_changed") { current.refreshNeeded = true; this._log(current, "工具清单已变化，将在下一轮刷新"); } },
        });
        if (entry.invalid || this.closed) { entry.client.close(); throw new Error("连接已取消"); }
        await entry.client.connect();
        entry.tools = await entry.client.listTools();
        if (entry.invalid || this.closed) throw new Error("连接已取消");
        await this.store.reconcileTools(config.id, entry.tools);
        if (entry.invalid || this.closed) throw new Error("连接已取消");
        this._publish(entry);
        entry.status = "connected";
        this._log(entry, `连接成功，发现 ${entry.tools.length} 个工具`);
        return entry;
      } catch (error) {
        entry.client?.close();
        entry.status = "error";
        // Keep a helpful category, never raw server errors (which may echo headers).
        entry.error = error?.mcpUserMessage || "MCP 连接失败：请检查命令、运行环境、地址、凭证和协议版本后重连";
        this._log(entry, entry.error);
        throw new Error(entry.error);
      } finally { entry.promise = null; }
    })();
    return entry.promise;
  }
  _refresh(entry) {
    entry.refreshNeeded = false;
    entry.promise = (async () => {
      let replacement;
      try {
        const tools = await entry.client.listTools();
        if (entry.invalid || this.closed) throw new Error("连接已取消");
        // Polling / duplicate notifications must not interrupt another active Agent.
        if (catalogKey(tools) === catalogKey(entry.tools)) return entry;
        await this.store.reconcileTools(entry.config.id, tools);
        if (entry.invalid || this.closed) throw new Error("连接已取消");
        replacement = { ...entry, tools, calls: new Map(), promise: entry.promise, invalid: false };
        this._publish(replacement);
        // Existing snapshots keep their old closures: invalidate, never retarget them.
        entry.invalid = true;
        for (const { controller } of entry.calls.values()) controller.abort();
        this.entries.set(entry.config.id, replacement);
        this._log(replacement, `工具清单已刷新，共 ${tools.length} 个工具`);
        return replacement;
      } catch (error) {
        if (this.entries.get(entry.config.id) === entry) {
          this._invalidate(entry.config.id);
          entry.status = "error"; entry.error = "MCP 工具清单刷新失败，请重连";
          this.entries.set(entry.config.id, entry);
          this._log(entry, entry.error);
        }
        throw error;
      } finally { entry.promise = null; if (replacement) replacement.promise = null; }
    })();
    return entry.promise;
  }
  _policy(entry, name) {
    const config = this.store.cached(entry.config.id);
    if (this.closed || entry.invalid || entry.client?.closed || !config?.enabled) return "deny";
    return ["allow", "deny"].includes(config.policies?.[name]) ? config.policies[name] : "ask";
  }
  _publish(entry) {
    const id = entry.config.id;
    if (!this.store.cached(id)?.enabled) return;
    const names = new Set();
    const specs = entry.tools.map(tool => {
      if (!tool || typeof tool.name !== "string" || !tool.name || names.has(tool.name)) throw new Error("MCP 工具名无效或重复");
      names.add(tool.name);
      const alias = mcpToolAlias(id, tool.name);
      return { name: alias, description: `[MCP: ${entry.config.name} / ${tool.name}] ${tool.description || ""}`,
        parameters: tool.inputSchema || { type: "object", properties: {} },
        needsConfirm: true, mcp: { serverId: id, toolName: tool.name },
        getPolicy: () => this._policy(entry, tool.name),
        approveAlways: () => this._edit(async () => {
          // Recheck inside the edit queue: a preceding save may invalidate this snapshot.
          if (this._policy(entry, tool.name) === "deny") throw new Error("服务已停用、变更或工具被禁止，请重新发起调用");
          await this.store.setPolicy(id, tool.name, "allow");
        }),
        handler: async (args, ctx = {}) => {
          const policy = this._policy(entry, tool.name);
          if (policy === "deny") throw new Error("MCP 服务不可用、配置已变更或工具被禁止；请在下一轮重试");
          if (policy === "ask" && ctx.mcpApproved !== alias) throw new Error("MCP 工具等待授权");
          if (ctx.signal?.aborted) throw new Error("MCP 调用已取消");
          const controller = this.createAbortController();
          const key = {};
          const abort = () => controller.abort();
          ctx.signal?.addEventListener("abort", abort, { once: true });
          entry.calls.set(key, { name: tool.name, controller });
          try {
            const result = await entry.client.callTool(tool.name, args, { signal: controller.signal });
            return adaptMcpResult(result);
          } finally {
            entry.calls.delete(key);
            ctx.signal?.removeEventListener("abort", abort);
          }
        } };
    });
    this.router.replaceSource(id, specs);
  }
  close() {
    this.closed = true;
    for (const id of this.entries.keys()) this._invalidate(id);
  }
}



