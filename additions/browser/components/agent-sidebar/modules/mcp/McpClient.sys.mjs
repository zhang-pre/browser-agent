/* Dependency-free MCP handshake-era client. Transport callbacks contain parsed JSON.
 * Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 * No OAuth, legacy HTTP+SSE endpoint discovery, or automatic invocation replay. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const fail = message => new Error(message);
export function sanitizeMcpDiagnostic(value, redact, depth = 0) {
  if (typeof value === "string") return redact(value).slice(0, 8000);
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeMcpDiagnostic(item, redact, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [redact(key), sanitizeMcpDiagnostic(item, redact, depth + 1)]));
  return value;
}

export function createJsonLineParser(onMessage, { onError = error => { throw error; }, maxBufferChars = 8 * 1024 * 1024 } = {}) {
  let buffer = "", failed = false;
  return {
    push(chunk) {
      if (failed) return;
      buffer += String(chunk);
      try {
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          if (index > maxBufferChars) throw fail("MCP message exceeds size limit");
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (line.trim()) {
            let message;
            try { message = JSON.parse(line); } catch { throw fail("Invalid MCP JSON message"); }
            onMessage(message);
          }
        }
        if (buffer.length > maxBufferChars) throw fail("MCP message exceeds size limit");
      } catch (error) { failed = true; buffer = ""; onError(error); }
    },
    end() {
      if (!failed && buffer.trim()) { failed = true; buffer = ""; onError(fail("Incomplete MCP JSON message")); }
    },
  };
}

export class McpClient {
  constructor({ transport, timeoutMs = 120000, clientInfo = { name: "browser-agent", version: "1.0" }, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, onNotification = null, onRequest = null, capabilities = {}, redact = value => value } = {}) {
    this.transport = transport; this.timeoutMs = timeoutMs; this.clientInfo = clientInfo;
    this.setTimeout = setTimeout; this.clearTimeout = clearTimeout; this.onNotification = onNotification;
    this.onRequest = onRequest; this.capabilities = capabilities; this.redact = redact; this.incoming = new Map();
    this.pending = new Map(); this.operations = new Set(); this.nextId = 0; this.connected = false; this.closed = false;
  }
  async connect({ signal } = {}) {
    if (this.connected) return this.server;
    if (this.closed) throw fail("MCP client closed");
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        await this._bounded(() => this.transport.start(message => this._receive(message), () => this.close(fail("MCP connection closed"))), signal);
        const result = await this.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: this.capabilities, clientInfo: this.clientInfo }, { signal });
        if (!MCP_PROTOCOL_VERSIONS.includes(result?.protocolVersion)) throw fail("Unsupported MCP protocol version");
        if (!result.capabilities || typeof result.capabilities !== "object") throw fail("Invalid MCP initialization result");
        this.transport.setProtocolVersion?.(result.protocolVersion);
        await this._bounded(() => this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" }), signal);
        if (this.closed) throw fail("MCP client closed");
        this.server = result; this.connected = true; return result;
      } catch (error) { this.close(); throw error; }
    })();
    return this.connecting;
  }
  _bounded(operation, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error, value) => { if (settled) return; settled = true; this.operations.delete(done); this.clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
      const abort = () => done(fail("MCP request cancelled"));
      const timer = this.setTimeout(() => done(fail("MCP request timed out")), this.timeoutMs);
      this.operations.add(done);
      if (this.closed) { done(fail("MCP client closed")); return; }
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => settled ? undefined : operation()).then(value => done(null, value), error => done(typeof error?.mcpUserMessage === "string" ? error : fail("MCP transport failed")));
    });
  }
  request(method, params, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(fail("MCP client closed"));
    if (signal?.aborted) return Promise.reject(fail("MCP request cancelled"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const done = (error, result) => {
        if (!this.pending.delete(id)) return;
        this.clearTimeout(timer); signal?.removeEventListener("abort", abort);
        error ? reject(error) : resolve(result);
      };
      const cancel = reason => {
        done(fail(reason)); controller.abort();
        if (method !== "initialize" && !this.closed) {
          Promise.resolve().then(() => this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } })).catch(() => {});
        }
      };
      const abort = () => cancel("MCP request cancelled");
      const timer = this.setTimeout(() => cancel("MCP request timed out; remote effects may already have occurred; invocation was not retried"), timeoutMs);
      this.pending.set(id, { done, controller });
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => {
        if (!this.pending.has(id)) return;
        return this.transport.send({ jsonrpc: "2.0", id, method, params }, { signal: controller.signal });
      }).catch(() => done(fail("MCP transport failed; invocation was not retried")));
    });
  }
  _receive(message) {
    if (this.closed) return;
    if (!message || Array.isArray(message) || message.jsonrpc !== "2.0") { this.close(fail("Invalid MCP message")); return; }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        const controller = new AbortController();
        this.incoming.set(message.id, controller);
        Promise.resolve().then(async () => {
          if (message.method === "ping") return {};
          if (!this.onRequest) throw Object.assign(fail("Client method not supported"), { code: -32601 });
          return this.onRequest(message.method, message.params || {}, { signal: controller.signal });
        }).then(result => ({ result }), error => ({ error: {
          code: Number.isInteger(error.code) ? error.code : -32603,
          message: this.redact(String(error.message || "Client request failed")).slice(0, 4000),
        } })).then(response => {
          if (!this.closed && !controller.signal.aborted) return this.transport.send({ jsonrpc: "2.0", id: message.id, ...response });
        }).catch(() => this.close()).finally(() => this.incoming.delete(message.id));
      } else {
        if (message.method === "notifications/cancelled") this.incoming.get(message.params?.requestId)?.abort();
        try { this.onNotification?.(message); } catch { /* consumer isolation */ }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) {
      const error = fail(`MCP server error (${Number.isInteger(message.error.code) ? message.error.code : "unknown"}): ${this.redact(String(message.error.message || "Unknown server error")).slice(0, 4000)}`);
      error.mcpError = { code: message.error.code, ...(message.error.data !== undefined ? { data: JSON.stringify(sanitizeMcpDiagnostic(message.error.data, this.redact)).slice(0, 8000) } : {}) };
      pending.done(error);
    }
    else if (Object.hasOwn(message, "result")) pending.done(null, message.result);
    else pending.done(fail("Invalid MCP response"));
  }
  async listTools(options = {}) {
    if (!this.connected) throw fail("MCP client not connected");
    if (!this.server.capabilities.tools) return [];
    const tools = [], seen = new Set(); let cursor;
    do {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, options);
      if (!Array.isArray(result?.tools)) throw fail("Invalid MCP tools list");
      tools.push(...result.tools);
      if (tools.length > 10000) throw fail("MCP tool count exceeds limit");
      cursor = result.nextCursor;
      if (cursor !== undefined && (typeof cursor !== "string" || seen.has(cursor))) throw fail("Invalid MCP pagination cursor");
      seen.add(cursor);
      if (seen.size > 1000) throw fail("MCP pagination exceeds limit");
    } while (cursor !== undefined);
    return tools;
  }
  async listItems(method, key, options = {}) {
    const items = [], seen = new Set(); let cursor;
    do {
      const result = await this.request(method, cursor === undefined ? {} : { cursor }, options);
      if (!Array.isArray(result?.[key])) throw fail("Invalid MCP catalog");
      items.push(...result[key]);
      cursor = result.nextCursor;
      if (items.length > 10000 || seen.size > 1000 || (cursor !== undefined && (typeof cursor !== "string" || seen.has(cursor)))) throw fail("Invalid MCP pagination cursor or limit");
      seen.add(cursor);
    } while (cursor !== undefined);
    return items;
  }
  async notify(method, params = {}) { return this.transport.send({ jsonrpc: "2.0", method, params }); }
  callTool(name, args = {}, options = {}) {
    if (!this.connected) return Promise.reject(fail("MCP client not connected"));
    return this.request("tools/call", { name, arguments: args }, options);
  }
  close(error = fail("MCP client closed")) {
    if (this.closed) return;
    this.closed = true; this.connected = false;
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
    for (const done of [...this.operations]) done(error);
    for (const item of [...this.pending.values()]) { item.done(error); item.controller.abort(); }
    try { Promise.resolve(this.transport.close()).catch(() => {}); } catch { /* best effort */ }
  }
}

export function createHttpTransport({ url, fetch = globalThis.fetch, headers = {}, timeoutMs = 120000, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout, maxResponseChars = 8 * 1024 * 1024 } = {}) {
  const endpoint = new URL(url);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw fail("Invalid MCP HTTP URL");
  let receive, onClose, session = null, version = null, closed = false;
  const active = new Set();
  const makeHeaders = () => {
    const result = new Headers(headers);
    result.set("Accept", "application/json, text/event-stream"); result.set("Content-Type", "application/json");
    result.delete("MCP-Session-Id"); result.delete("MCP-Protocol-Version");
    if (session) result.set("MCP-Session-Id", session);
    if (version) result.set("MCP-Protocol-Version", version);
    return result;
  };
  return {
    start(onMessage, onDisconnect) { receive = onMessage; onClose = onDisconnect; },
    setProtocolVersion(value) { version = value; },
    async send(message, { signal } = {}) {
      if (closed) throw fail("MCP transport closed");
      const controller = new AbortController(); active.add(controller);
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      let reader;
      try {
        const response = await fetch(endpoint.href, { method: "POST", headers: makeHeaders(), body: JSON.stringify(message), signal: controller.signal, redirect: "error", credentials: "omit" });
        if (!response.ok) {
          if (response.status === 404 && session) { session = null; onClose?.(fail("MCP session expired; reconnect required")); }
          throw fail(`MCP HTTP error (${response.status})`);
        }
        if (message.method === "initialize") {
          const value = response.headers.get("MCP-Session-Id");
          if (value && !/^[\x21-\x7e]+$/.test(value)) throw fail("Invalid MCP session header");
          session = value;
        }
        const isRequest = message.id !== undefined && typeof message.method === "string";
        if (!isRequest) {
          if (response.status !== 202) throw fail("Invalid MCP notification HTTP status");
          return;
        }
        const type = (response.headers.get("Content-Type") || "").split(";")[0].trim();
        if (!["application/json", "text/event-stream"].includes(type)) throw fail("Unsupported MCP HTTP content type");
        reader = response.body?.getReader();
        if (!reader) throw fail("Missing MCP response body");
        const decoder = new TextDecoder(); let buffer = "", data = [], total = 0, matched = false;
        const deliver = value => {
          let parsed; try { parsed = JSON.parse(value); } catch { throw fail("Invalid MCP JSON response"); }
          if (parsed.id === message.id && !parsed.method) matched = true;
          receive(parsed);
        };
        const line = value => {
          if (!value) { if (data.length) { const value = data.join("\n"); data = []; if (value.trim()) deliver(value); } }
          else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
        };
        while (!matched) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          total += value?.byteLength || 0;
          if (total > maxResponseChars) throw fail("MCP response exceeds size limit");
          if (type === "text/event-stream") {
            let pos;
            while ((pos = buffer.search(/[\r\n]/)) >= 0) {
              if (buffer[pos] === "\r" && pos === buffer.length - 1 && !done) break;
              const width = buffer[pos] === "\r" && buffer[pos + 1] === "\n" ? 2 : 1;
              line(buffer.slice(0, pos)); buffer = buffer.slice(pos + width);
            }
          }
          if (done) { if (type === "application/json") deliver(buffer); break; }
        }
        if (!matched) throw fail("MCP response stream ended before result; invocation was not retried");
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); active.delete(controller);
        try { await reader?.cancel(); } catch { /* stream already closed */ }
      }
    },
    close() {
      if (closed) return;
      closed = true; for (const controller of active) controller.abort(); active.clear();
      if (session) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3000));
        Promise.resolve().then(() => fetch(endpoint.href, { method: "DELETE", headers: makeHeaders(), signal: controller.signal, redirect: "error", credentials: "omit" })).catch(() => {}).finally(() => clearTimeout(timer));
      }
    },
  };
}


