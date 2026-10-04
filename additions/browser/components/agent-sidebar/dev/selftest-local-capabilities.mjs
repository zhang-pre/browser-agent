import assert from "node:assert/strict";
import { ToolRouter } from "../modules/tools/ToolRouter.sys.mjs";
import { createBuiltinTools, declaredToolNames } from "../modules/tools/Tools.sys.mjs";
import { DEEP_LOCAL_TOOLS, SUPPORT_LOCAL_TOOLS, mcpOnlyPrompt } from "../modules/tools/LocalCapabilityPolicy.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { assertAgentRouterPort } from "../modules/runtime/AgentRuntimePorts.sys.mjs";
import { AgentTurnOrchestrator } from "../modules/runtime/AgentTurnOrchestrator.sys.mjs";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { ConfigStore } from "../modules/providers/ConfigStore.sys.mjs";

let executed = 0;
const backend = new Proxy({}, { get: () => async () => { executed++; return { ok: true }; } });
const backends = new Proxy({}, { get: () => backend });
const router = new ToolRouter().registerAll(createBuiltinTools(backends));
assert.equal(router.names().length, declaredToolNames().length);
const mcpName = "remote_browser"; // Metadata, not a name prefix, identifies MCP.
router.replaceSource("reverse", [{ name: mcpName, description: "MCP description",
  mcp: { serverId: "reverse", toolName: "inspect" }, getPolicy: () => "allow",
  handler: async () => ({ ok: true }) }]);
router.setSourceContext("reverse", "REMOTE_INSTRUCTIONS toolNames: remote_browser");
const filtered = router.snapshot({ localToolsEnabled: false });
for (const name of [...DEEP_LOCAL_TOOLS, ...SUPPORT_LOCAL_TOOLS, mcpName]) assert(filtered.has(name), name);
for (const name of ["page_eval", "net_get", "scripts_save", "skill_get", "skill_list", "skill_read_resource",
  "remember", "recall", "signer_trace", "env_list", "cookies"]) {
  assert(!filtered.has(name), name);
  assert.equal((await filtered.dispatch(name, {})).ok, false);
}
assert.equal(executed, 0, "hidden tools cannot execute through the filtered router");
assert(router.has("page_eval"), "shared registry is not mutated");
assert(router.snapshot().has("skill_get"), "normal conversations retain all tools");
assert(filtered.sourceContext().includes("REMOTE_INSTRUCTIONS"));
assert(!JSON.stringify(filtered.listSpecs()).match(/skill_get|page_eval|scripts_save|signer_trace|P0|P6/));
for (const name of ["deep_target", "deep_run", "deep_health", "jsvmp_trace", "webapi_trace"]) assert(mcpOnlyPrompt().includes(name));
assert(!mcpOnlyPrompt().match(/skill_get|P0|P6|补环境|不靠浏览器/));

assert(mcpOnlyPrompt().includes("按缺失证据选择工具"));
assert(mcpOnlyPrompt().includes("黑盒目标先验证最短"));
assert(!mcpOnlyPrompt().includes("优先评估 jsvmp_trace"));
let prepared = 0, ledgerReads = 0, chats = 0;
router.setPrepareHook(() => { prepared++; });
const result = await runAgentTurn({
  router: assertAgentRouterPort(router), messages: [{ role: "user", content: "inspect" }],
  localToolsEnabled: false, systemPrompt: "P0 OLD_LOCAL_POLICY skill_get",
  dynamicContext: "CURRENT_WORKSPACE", assist: true, maxRounds: 3,
  getLedger: () => { ledgerReads++; return "OLD_LEDGER"; },
  client: { chat: async (messages, options) => {
    assert(!options.tools.some(t => t.function.name === "skill_get"));
    assert(options.tools.some(t => t.function.name === mcpName));
    assert(options.tools.some(t => t.function.name === "wasm_probe"));
    const text = JSON.stringify(messages);
    assert(!text.includes("OLD_LOCAL_POLICY"));
    assert(!text.includes("OLD_LEDGER"));
    assert(text.includes("REMOTE_INSTRUCTIONS"));
    if (chats++ === 0) return { toolCalls: [{ id: "hidden", type: "function",
      function: { name: "page_eval", arguments: JSON.stringify({ expression: "1" }) } }] };
    return { content: "done" };
  } },
});
assert.equal(result.toolCalls[0].env.ok, false, "hallucinated hidden tool is rejected");
assert.equal(executed, 0);
assert.equal(ledgerReads, 0);
assert.equal(prepared, 1);
let normal = false;
await runAgentTurn({ router, messages: [], assist: true, client: { chat: async (_m, options) => {
  normal = options.tools.some(t => t.function.name === "skill_get");
  return { content: "done" };
} } });
assert(normal);

const store = new ConversationStore({ memoryOnly: true });
const old = await store.createThread("old", "/workspace");
await store.appendMessage(old.id, { role: "assistant", content: "OLD_SKILL_TEXT P0" });
const fresh = await store.createThread("MCP", "/workspace", null, false);
assert.equal((await store.getThread(fresh.id)).localToolsEnabled, false);
assert.equal((await store.getThread(old.id)).localToolsEnabled, true);
assert.equal((await store.getModelMessages(fresh.id)).length, 0, "fresh conversation has no prior skill context");
assert.equal((await store.getThread(old.id)).messages.length, 1, "history preserved");
const imported = await store.importThread(JSON.stringify(await store.exportThread(fresh.id)));
assert.equal(imported.localToolsEnabled, false);
const config = new ConfigStore();
assert(config.getLocalToolsEnabled());
config.setLocalToolsEnabled(false);
assert.equal(config.getLocalToolsEnabled(), false);
config.setLocalToolsEnabled(true);
assert(config.getLocalToolsEnabled());

// Host preparation reads the persisted conversation profile, not a global toggle.
const orchestrator = Object.create(AgentTurnOrchestrator.prototype);
Object.assign(orchestrator, {
  conversationStore: store, getBackends: () => ({}),
  _consumeCancellationBoundary: async ctx => { ctx.dynamicContext += " CANCEL_BOUNDARY"; },
  _createToolContext: x => x, createClient: () => ({}), _cacheKey: () => "",
  _detectVision: () => false, _loadTurnMessages: async () => [],
  _syncMemory: async () => {}, _completionMemory: async () => {},
});
const context = { threadId: fresh.id, systemPrompt: "OLD_POLICY", dynamicContext: "OLD_CATALOG",
  workspaceRoot: "/workspace", abortController: new AbortController(), state: {} };
await orchestrator._prepare(context);
assert.equal(context.localToolsEnabled, false);
assert(!context.systemPrompt.includes("OLD_POLICY"));
assert(!context.dynamicContext.includes("OLD_CATALOG"));
assert(context.dynamicContext.includes("CANCEL_BOUNDARY"));
const hintRouter = new ToolRouter().register({ name: "wasm_probe", handler: () => ({
  note: "page_eval 获取真值", stdout: "page_eval must remain raw evidence",
}) });
const hint = await hintRouter.snapshot({ localToolsEnabled: false }).dispatch("wasm_probe", {});
assert(!hint.data.note.includes("page_eval"));
assert(hint.data.stdout.includes("page_eval"), "raw evidence is never rewritten");
// Exercise generic runtime guidance: invalid/truncated arguments and artifact folding.
for (const scenario of ["truncated-args", "large-result"]) {
  const guidanceRouter = new ToolRouter().register({ name: "fs_read",
    handler: async () => ({ content: "evidence".repeat(4000) }) });
  let rounds = 0;
  await runAgentTurn({ router: guidanceRouter, messages: [], localToolsEnabled: false,
    assist: true, maxRounds: 2,
    persistToolArtifact: async () => ({ path: ".frx-context/tool-results/evidence.json" }),
    client: { async chat(messages) {
      if (rounds++ === 0) return { finishReason: scenario === "truncated-args" ? "length" : "stop",
        toolCalls: [{ id: scenario, type: "function", function: {
          name: "fs_read", arguments: scenario === "truncated-args" ? '{"path":"' : "{}",
        } }] };
      const reply = messages.findLast(m => m.role === "tool").content;
      assert(!/\b(?:scripts_save|code_search|skill_get|page_eval|page_navigate)\b/.test(reply));
      assert(reply.includes(scenario === "truncated-args" ? "工具参数被输出长度限制截断" : "折叠前结果已保存"));
      return { content: "done" };
    } },
  });
}
console.log("Local capability isolation selftest: all passed");
