/* Session-scoped server callbacks. No ambient conversation or credentials are sent. */
const invalid = message => Object.assign(new Error(message), { code: -32602 });
export function validateElicitation(schema, content) {
  if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object") throw invalid("Invalid elicitation schema");
  if (Object.keys(schema.properties).length > 40) throw invalid("Too many elicitation fields");
  if (content !== undefined && (!content || Array.isArray(content) || typeof content !== "object")) throw invalid("Invalid elicitation content");
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!field || !["string", "number", "integer", "boolean", "array"].includes(field.type) || (field.type === "array" && field.items?.type !== "string")) throw invalid(`Unsupported elicitation field: ${key}`);
    if (content === undefined) continue;
    const value = content[key];
    if (value === undefined) { if (schema.required?.includes(key)) throw invalid(`Required field: ${key}`); continue; }
    const valid = field.type === "integer" ? Number.isInteger(value) : field.type === "array" ? Array.isArray(value) && value.every(x => typeof x === "string") : typeof value === field.type;
    if (!valid) throw invalid(`Invalid field type: ${key}`);
    if (typeof value === "number" && (!Number.isFinite(value) || (field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum))) throw invalid(`Number out of range: ${key}`);
    if (typeof value === "string" && ((field.minLength !== undefined && value.length < field.minLength) || value.length > (field.maxLength ?? 10000))) throw invalid(`Invalid field length: ${key}`);
    if (typeof value === "string" && field.format) {
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw invalid(`Invalid email: ${key}`);
      if (field.format === "uri") { try { new URL(value); } catch { throw invalid(`Invalid URI: ${key}`); } }
      if (["date", "date-time"].includes(field.format) && (!/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(Date.parse(value)))) throw invalid(`Invalid date: ${key}`);
    }
    const choices = field.enum || field.oneOf?.map(x => x.const);
    if (choices && !choices.includes(value)) throw invalid(`Invalid choice: ${key}`);
    if (Array.isArray(value)) {
      const choices = field.items.enum || field.items.anyOf?.map(x => x.const);
      if ((choices && value.some(x => !choices.includes(x))) || value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 100) || (field.uniqueItems && new Set(value).size !== value.length)) throw invalid(`Invalid choices: ${key}`);
    }
  }
  if (content !== undefined && (!content || Array.isArray(content) || typeof content !== "object" || Object.keys(content).some(key => !Object.hasOwn(schema.properties, key)))) throw invalid("Invalid elicitation content");
}

export function createMcpSessionRequestHandler({ client, confirm, onUsage }) {
  let sequence = 0;
  return async (method, params, { serverId, serverName, signal }) => {
    const check = () => { if (signal?.aborted) throw new Error("MCP client request cancelled"); };
    const ask = async (phase, payload) => {
      check();
      if (typeof confirm !== "function") return false;
      const result = await confirm({ name: `${serverName}: ${phase}`, id: `mcp-callback-${serverId}-${++sequence}`,
        mcp: { serverId, callback: true }, args: { mcpRequest: phase, ...payload }, signal });
      check();
      return result;
    };
    if (method === "elicitation/create") {
      if (JSON.stringify(params).length > 100000) throw invalid("Elicitation request exceeds size limit");
      if (params.mode && params.mode !== "form") throw invalid("Only form elicitation is supported; URL mode is not advertised");
      validateElicitation(params.requestedSchema);
      const result = await ask("elicitation", { message: String(params.message || ""), schema: params.requestedSchema });
      if (!result || result.approved !== true) return { action: result?.action === "cancel" ? "cancel" : "decline" };
      validateElicitation(params.requestedSchema, result.content);
      if (!result.content) throw invalid("Missing elicitation content");
      return { action: "accept", content: result.content };
    }
    if (method !== "sampling/createMessage") throw Object.assign(new Error("Client method not supported"), { code: -32601 });
    if (params.tools || params.toolChoice || (params.includeContext && params.includeContext !== "none")) throw invalid("Sampling tools and ambient context are not supported");
    if (!Number.isInteger(params.maxTokens) || params.maxTokens < 1 || !Array.isArray(params.messages) || !params.messages.length || params.messages.length > 100) throw invalid("Invalid sampling request");
    const messages = params.messages.map(message => {
      const blocks = Array.isArray(message.content) ? message.content : [message.content];
      if (!["user", "assistant"].includes(message.role) || !blocks.length || blocks.some(b => b?.type !== "text" || typeof b.text !== "string")) throw invalid("Only text sampling messages are supported");
      return { role: message.role, content: blocks.map(b => b.text).join("\n") };
    });
    if (params.systemPrompt) messages.unshift({ role: "system", content: String(params.systemPrompt) });
    if (JSON.stringify(messages).length > 100000) throw invalid("Sampling request exceeds size limit");
    const maxTokens = Math.min(params.maxTokens, 8192);
    const decision = await ask("sampling", { messages, maxTokens });
    if (!(decision === true || decision?.approved)) throw new Error("User declined MCP sampling");
    const result = await client.chat(messages, { signal, tools: [], maxTokens, ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}) });
    check();
    if (result.usage) onUsage?.(result.usage, { phase: "mcp-sampling" });
    if (result.toolCalls?.length) throw new Error("Unexpected tool call in text sampling");
    const text = String(result.content || "");
    const approval = await ask("sampling-result", { text });
    if (!(approval === true || approval?.approved)) throw new Error("User declined sending sampling result to MCP server");
    return { role: "assistant", content: { type: "text", text }, model: String(client.model || client.config?.model || "configured-model"), stopReason: result.finishReason === "length" ? "maxTokens" : "endTurn" };
  };
}
