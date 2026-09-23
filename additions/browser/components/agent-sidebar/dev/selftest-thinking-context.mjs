import assert from "node:assert/strict";
import { buildLlmRequest } from "../modules/llm/LlmProtocol.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { createUnifiedTurnContext } from "../modules/state/UnifiedTurnContext.sys.mjs";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";

const config = { protocol: "openai", providerId: "custom", model: "deepseek-v4-pro", request: {} };
const wire = messages => JSON.parse(buildLlmRequest(config, messages, { tools: [] }).init.body).messages;
function strict(messages) {
  for (const m of messages) {
    if (m.role === "assistant") assert.equal(typeof m.reasoning_content, "string", "thinking assistant must carry original reasoning");
  }
}
const reasoning = "BEGIN:" + "reasoning ".repeat(800) + ":END";
const call = id => ({ id, type: "function", function: { name: "probe", arguments: "{}" } });
const store = new ConversationStore({ memoryOnly: true });
const thread = await store.createThread();
await store.appendMessage(thread.id, { role: "user", content: "original goal" });
let n = 0;
const requests = [];
const result = await runAgentTurn({
  client: {
    model: config.model,
    async chat(messages) {
      strict(messages); // Validate before protocol compatibility can mask a regression.
      requests.push(structuredClone(messages));
      n++;
      if (n === 1) return { content: "plan", reasoningContent: "text reasoning", toolCalls: [] };
      if (n === 2) return { content: "", reasoningContent: reasoning, toolCalls: [call("a"), call("b")] };
      return { content: "## 结论：完成", reasoningContent: "final reasoning", toolCalls: [] };
    },
  },
  router: { listSpecs: () => [], needsConfirm: () => false, dispatch: async () => ({ ok: true, data: "evidence" }) },
  messages: await store.getModelMessages(thread.id),
  journal: await store.getUnifiedContext(thread.id),
  onContextAppend: events => store.appendContextEvents(thread.id, events),
  contextStrategy: "projected", maxRounds: 4, autoApprove: true,
});
assert.equal(requests[1].find(m => m.role === "assistant").reasoning_content, "text reasoning");
assert.equal(requests[2].find(m => m.tool_calls).reasoning_content, reasoning);
assert.equal(result.reasoningContent, "final reasoning");
await store.appendMessage(thread.id, { role: "assistant", content: result.content, reasoning_content: result.reasoningContent });
const reopened = await store.getModelMessages(thread.id);
assert.equal(reopened.at(-1).reasoning_content, "final reasoning");
assert.equal((await store.getModelMessages(thread.id, { strategy: "legacy" })).at(-1).reasoning_content, "final reasoning");
const ctx = await createUnifiedTurnContext({
  client: { model: config.model, chat: async () => ({ content: "verified evidence", reasoningContent: "summarizer reasoning" }) },
  journal: await store.getUnifiedContext(thread.id), messages: reopened,
});
const compressed = await ctx.forceCompact(1, ctx.initialMessages);
strict(compressed);
assert.ok(compressed.some(m => m._contextSynthetic && m.role === "user" && m.content.includes("累计执行状态")));
assert.equal(compressed.find(m => m.tool_calls)?.reasoning_content, reasoning);
assert.ok(compressed.some(m => m.role === "tool" && m.tool_call_id === "b"));
strict(wire(compressed));
console.log("OK text, tool, final, reload and compressed requests preserve complete thinking fields");

const old = [
  { role: "user", content: "goal" },
  { role: "assistant", content: "old summary" },
  { role: "assistant", content: "", tool_calls: [call("old")] },
  { role: "tool", tool_call_id: "old", content: "old result" },
  { role: "assistant", content: "new", reasoning_content: reasoning, tool_calls: [call("new")] },
  { role: "tool", tool_call_id: "new", content: "new result" },
];
const original = structuredClone(old);
const repaired = wire(old);
strict(repaired);
assert.deepEqual(old, original);
assert.ok(repaired.some(m => m.role === "user" && m.content.includes("old result")));
assert.deepEqual(repaired.filter(m => m.role === "tool").map(m => m.tool_call_id), ["new"]);
assert.equal(repaired.find(m => m.role === "assistant").reasoning_content, reasoning);
const other = JSON.parse(buildLlmRequest({ ...config, model: "other-model" }, old, { tools: [] }).init.body);
assert.deepEqual(other.messages, old);
console.log("OK historical missing reasoning is quoted as a complete group without fake reasoning or orphan tool results");

