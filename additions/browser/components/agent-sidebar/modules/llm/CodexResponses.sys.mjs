/* Codex Responses wire format; keeps Runtime messages/results unchanged. */
function textOf(content) {
  if (typeof content === "string") return content;
  return (content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
}

export function buildCodexRequest(config, messages, opts = {}) {
  const model = String(opts.model || config.model || "").replace(/\s*\[\d+[a-z]?\]\s*$/i, "");
  if (!model) throw new Error("buildRequest: model is required");
  const instructions = [];
  const input = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      instructions.push(textOf(message.content));
    } else if (message.role === "tool") {
      input.push({
        type: "function_call_output", call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""),
      });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of message.tool_calls || []) {
        input.push({
          type: "function_call", call_id: call.id, name: call.function.name,
          arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments || {}),
        });
      }
    } else {
      const content = typeof message.content === "string"
        ? [{ type: "input_text", text: message.content }]
        : (message.content || []).map(part => {
          if (part.type === "text") return { type: "input_text", text: part.text };
          if (part.type === "image_url") return {
            type: "input_image", image_url: part.image_url.url,
            detail: part.image_url.detail || "auto",
          };
          throw new Error("Codex 不支持此消息内容类型");
        });
      input.push({ role: "user", content });
    }
  }
  const body = {
    model, instructions: instructions.join("\n\n") || "You are a helpful assistant.",
    input, stream: true, store: false, parallel_tool_calls: true,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map(tool => {
      const fn = tool.function || tool;
      return { type: "function", name: fn.name, description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} }, strict: false };
    });
    body.tool_choice = "auto";
  }
  const effort = opts.reasoningEffort ?? config.request?.reasoning_effort;
  if (effort && effort !== "auto") {
    body.reasoning = { effort: effort === "minimal" ? "low" : effort, summary: "auto" };
  }
  if (config.promptCacheMode === "auto" && opts.cacheKey && !opts.disablePromptCache) {
    body.prompt_cache_key = String(opts.cacheKey).slice(0, 64);
  }
  return {
    url: config.baseUrl + config.chatPath, cacheApplied: false,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    },
  };
}

export function parseCodexResponse(response) {
  if (response?.status === "failed" || response?.error) throw new Error("Codex 响应失败，请检查模型权限或稍后重试");
  if (response?.status === "incomplete") throw new Error("Codex 响应未完成，请重试或缩短上下文");
  let content = "";
  let reasoningContent = "";
  const toolCalls = [];
  for (const item of response?.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) content += part.text || part.refusal || "";
    } else if (item.type === "reasoning") {
      for (const part of item.summary || []) reasoningContent += part.text || "";
    } else if (item.type === "function_call") {
      if (!item.call_id || !item.name) throw new Error("Codex 工具调用缺少标识或名称");
      toolCalls.push({ id: item.call_id, type: "function",
        function: { name: item.name, arguments: item.arguments || "{}" } });
    }
  }
  return { content, reasoningContent, toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop", usage: response?.usage || null, raw: response };
}

// Terminal responses may omit items already delivered by output_item.done.
// Merge by identity (or slot for anonymous items) instead of replacing the stream.
function completedOutput(items, output = []) {
  const merged = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  for (const [index, item] of output.entries()) {
    const existing = merged.findIndex(previous =>
      (item.id && previous.id === item.id) ||
      (item.type === "function_call" && previous.type === item.type && item.call_id === previous.call_id)
    );
    if (existing >= 0) merged[existing] = item;
    else if (!item.id && !merged[index]?.id && merged[index]?.type === item.type &&
             item.type !== "function_call") merged[index] = item;
    else merged.push(item);
  }
  return merged;
}

export class CodexStreamInterruptedError extends Error {
  constructor({ cause, partial = false } = {}) {
    super("ChatGPT 响应流在完成前中断，请在当前会话发送“继续”；若反复发生，请检查代理连接。", { cause });
    this.name = "CodexStreamInterruptedError";
    this.partial = partial;
  }
}

export async function readCodexStream(response, { onDelta, onReasoning, onActivity } = {}) {
  if (!response.body?.getReader) throw new Error("Codex 未返回 Responses 事件流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const items = new Map();
  let buffer = "";
  let terminal = null;
  let partial = false;
  const notify = (fn, text) => { try { fn?.(text); } catch {} };
  function frame(value) {
    const data = value.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let event;
    try { event = JSON.parse(data); } catch { throw new Error("Codex 事件流包含无效 JSON"); }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error("Codex 请求失败，请检查账号/模型权限或稍后重试");
    }
    if (event.type === "response.incomplete") throw new Error("Codex 响应未完成");
    if ((event.type?.endsWith(".delta") && event.delta) || event.type === "response.output_item.done") partial = true;
    if (event.type === "response.output_text.delta") notify(onDelta, event.delta || "");
    if (event.type === "response.reasoning_summary_text.delta") notify(onReasoning, event.delta || "");
    if (event.type === "response.output_item.done") items.set(event.output_index, event.item);
    if (event.type === "response.completed" || event.type === "response.done") {
      terminal = { ...event.response,
        output: completedOutput(items, event.response?.output) };
    }
  }
  try {
    while (!terminal) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (cause) { throw new CodexStreamInterruptedError({ cause, partial }); }
      const { value, done } = chunk;
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) frame(buffer);
        break;
      }
      onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        frame(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (terminal) break;
      }
    }
    if (!terminal) throw new CodexStreamInterruptedError({ partial });
    return parseCodexResponse(terminal);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
