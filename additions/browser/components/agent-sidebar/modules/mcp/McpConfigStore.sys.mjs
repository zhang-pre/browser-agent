/* Profile-scoped MCP configuration. Storage and credential encryption are host ports. */
const POLICIES = new Set(["allow", "ask", "deny"]);
const OWN = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const copy = value => JSON.parse(JSON.stringify(value));
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value;
}
function stringMap(value, label) {
  record(value, label);
  for (const [key, val] of Object.entries(value)) {
    if (!key || typeof val !== "string" || /[\0\r\n]/.test(key) || val.includes("\0")) throw new Error(`${label} 必须包含有效的字符串键和值`);
    if (label === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("环境变量名无效");
    if (label === "headers" && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(val))) throw new Error("请求头格式无效");
    if (label === "headers" && /^(host|content-length|content-type|accept|mcp-session-id|mcp-protocol-version)$/i.test(key)) throw new Error(`请求头 ${key} 由 MCP 连接管理`);
  }
  return copy(value);
}
export function normalizeMcpConfig(input) {
  record(input, "服务配置");
  const transport = input.transport || input.type || (input.url ? "http" : "stdio");
  if (!["stdio", "http"].includes(transport)) throw new Error("只支持 stdio 和 Streamable HTTP；不支持旧版 SSE 地址");
  const name = String(input.name || "").trim();
  if (!name || name.length > 160) throw new Error("请填写不超过 160 字符的服务名称");
  const result = { name, transport, enabled: input.enabled === true };
  if (transport === "stdio") {
    if (typeof input.command !== "string" || !input.command.trim() || /[\0\r\n]/.test(input.command)) throw new Error("请填写有效的启动命令，参数单独填写");
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(x => typeof x !== "string" || x.includes("\0")))) throw new Error("args 必须是字符串数组");
    result.command = input.command.trim();
    result.args = input.args || [];
    result.cwd = input.cwd || "";
    if (typeof result.cwd !== "string" || /[\0\r\n]/.test(result.cwd)) throw new Error("工作目录无效");
  } else {
    let url;
    try { url = new URL(input.url); } catch { throw new Error("请填写有效的 MCP URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("MCP URL 必须为 HTTP(S)，不得含用户名、密码或片段；凭证请放入请求头");
    result.url = url.href;
  }
  if (OWN(input, "env")) result.env = stringMap(input.env, "env");
  if (OWN(input, "headers")) result.headers = stringMap(input.headers, "headers");
  return result;
}
export function previewMcpImport(text) {
  let input;
  try { input = JSON.parse(text); } catch { throw new Error("配置不是有效的 JSON"); }
  record(input, "配置");
  const entries = Object.entries(record(input.mcpServers, "mcpServers"));
  if (!entries.length) throw new Error("mcpServers 不能为空");
  if (entries.length > 64) throw new Error("每次最多导入 64 个服务");
  const warnings = Object.keys(input).filter(k => k !== "mcpServers").map(k => `忽略顶层字段：${k}`);
  const known = new Set(["name", "transport", "type", "command", "args", "cwd", "url", "env", "headers", "enabled", "disabled"]);
  const servers = entries.map(([name, value]) => {
    record(value, `服务 ${name}`);
    for (const key of Object.keys(value)) if (!known.has(key)) warnings.push(`${name}：不支持字段 ${key}`);
    return normalizeMcpConfig({ ...value, name, enabled: false });
  });
  return { servers, warnings };
}
export class McpConfigStore {
  constructor({ read, write, readSecret, writeSecret, deleteSecret, newId }) {
    Object.assign(this, { read, write, readSecret, writeSecret, deleteSecret, newId });
    this._data = null;
    this._tail = Promise.resolve();
  }
  async init() {
    if (!this._loading) this._loading = (async () => {
      const data = await this.read();
      if (data === null) { this._data = { version: 1, servers: [] }; return; }
      if (data?.version !== 1 || !Array.isArray(data.servers)) throw new Error("MCP 配置格式无效，请检查 profile 中的 mcp.json");
      const ids = new Set();
      for (const server of data.servers) {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(server.id) || ids.has(server.id)) throw new Error("MCP 配置包含无效或重复服务 ID");
        ids.add(server.id);
        if (OWN(server, "env") || OWN(server, "headers")) throw new Error("MCP 凭证必须存入加密凭证库，不能保存在配置文件中");
        normalizeMcpConfig(server);
        for (const policy of Object.values(server.policies || {})) if (!POLICIES.has(policy)) throw new Error("MCP 工具策略无效");
      }
      this._data = { version: 1, servers: data.servers.map(server => ({ ...normalizeMcpConfig(server), id: server.id, policies: { ...(server.policies || {}) }, envKeys: Array.isArray(server.envKeys) ? server.envKeys.filter(k => typeof k === "string") : [], headerKeys: Array.isArray(server.headerKeys) ? server.headerKeys.filter(k => typeof k === "string") : [], toolSchemas: server.toolSchemas && typeof server.toolSchemas === "object" && !Array.isArray(server.toolSchemas) ? Object.fromEntries(Object.entries(server.toolSchemas).filter(([, value]) => typeof value === "string")) : {} })) };
    })();
    try { await this._loading; } catch (error) { this._loading = null; throw error; }
  }
  _mutate(fn) {
    const task = this._tail.then(async () => { await this.init(); return fn(); });
    this._tail = task.catch(() => {});
    return task;
  }
  cached(id) { return this._data?.servers.find(s => s.id === id); }
  async list() { await this.init(); return copy(this._data.servers); }
  async credentials(id) { await this.init(); return (await this.readSecret(id)) || { env: {}, headers: {} }; }
  async save(input) {
    return this._mutate(async () => {
      const normalized = normalizeMcpConfig(input);
      const previous = input.id ? this.cached(input.id) : null;
      if (input.id && !previous) throw new Error("服务已删除，请重新添加");
      if (this._data.servers.some(s => s.name === normalized.name && s.id !== previous?.id)) throw new Error("服务名称已存在");
      const id = previous?.id || this.newId();
      const oldSecret = previous ? await this.credentials(id) : { env: {}, headers: {} };
      const secret = { env: normalized.env ?? oldSecret.env, headers: normalized.headers ?? oldSecret.headers };
      delete normalized.env;
      delete normalized.headers;
      const identity = s => JSON.stringify([s.transport, s.command, s.args, s.cwd, s.url]);
      const changed = previous && (identity(previous) !== identity(normalized) || JSON.stringify(oldSecret) !== JSON.stringify(secret));
      const policies = changed ? Object.fromEntries(Object.entries(previous.policies || {}).filter(([, p]) => p === "deny")) : (previous?.policies || {});
      const server = { ...normalized, id, policies, toolSchemas: changed ? {} : previous?.toolSchemas || {}, envKeys: Object.keys(secret.env), headerKeys: Object.keys(secret.headers) };
      const next = { version: 1, servers: [...this._data.servers.filter(s => s.id !== id), server] };
      await this.writeSecret(id, secret);
      try { await this.write(next); } catch (error) {
        if (previous) await this.writeSecret(id, oldSecret); else await this.deleteSecret(id);
        throw error;
      }
      this._data = next;
      return copy(server);
    });
  }
  async setEnabled(id, enabled) {
    return this._mutate(async () => {
      if (!this.cached(id)) throw new Error("服务不存在");
      const next = copy(this._data);
      next.servers.find(s => s.id === id).enabled = !!enabled;
      await this.write(next); this._data = next;
    });
  }
  async setPolicy(id, name, policy) {
    return this._mutate(async () => {
      if (!this.cached(id) || !POLICIES.has(policy) || typeof name !== "string" || !name) throw new Error("工具策略无效");
      const next = copy(this._data);
      const server = next.servers.find(s => s.id === id);
      server.policies = { ...server.policies, [name]: policy };
      await this.write(next); this._data = next;
    });
  }
  async reconcileTools(id, tools) {
    return this._mutate(async () => {
      const current = this.cached(id);
      if (!current) throw new Error("服务不存在");
      const schemas = Object.fromEntries(tools.map(tool => [tool.name, JSON.stringify([tool.inputSchema || {}, tool.description || ""])]));
      const previous = current.toolSchemas || {};
      const policies = Object.fromEntries(Object.entries(current.policies || {}).map(([name, policy]) => [name,
        policy === "allow" && previous[name] !== schemas[name] ? "ask" : policy]));
      if (JSON.stringify(schemas) === JSON.stringify(previous) && JSON.stringify(policies) === JSON.stringify(current.policies || {})) return;
      const next = copy(this._data);
      Object.assign(next.servers.find(s => s.id === id), { toolSchemas: schemas, policies });
      await this.write(next); this._data = next;
    });
  }
  async remove(id) {
    return this._mutate(async () => {
      const next = { version: 1, servers: this._data.servers.filter(s => s.id !== id) };
      await this.write(next); this._data = next;
      try { await this.deleteSecret(id); } catch { throw new Error("服务配置已删除，但加密凭证清理失败，请检查浏览器凭证存储"); }
    });
  }
  async exportConfig() {
    const servers = await this.list();
    return { mcpServers: Object.fromEntries(servers.map(s => [s.name, s.transport === "stdio" ?
      { command: s.command, args: s.args, ...(s.cwd ? { cwd: s.cwd } : {}) } : { type: "http", url: s.url }])) };
  }
}


