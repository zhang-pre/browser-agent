import assert from "node:assert/strict";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { createUnifiedTurnContext } from "../modules/state/UnifiedTurnContext.sys.mjs";
import {
  completeGroups, planUnifiedCompaction, projectUnifiedMessages,
} from "../modules/state/UnifiedContext.sys.mjs";

const store = new ConversationStore({ memoryOnly: true });
const thread = await store.createThread();
await store.appendMessage(thread.id, {
  role: "user", content: "逆向 example.test 的 sign 接口，做出可运行调用",
});
let summaries = 0;
const client = {
  model: "test",
  async chat(messages) {
    summaries++;
    const input = JSON.stringify(messages);
    const early = input.includes("FACT_EARLY") ? "FACT_EARLY 来自实验 #2；" : "";
    const conflict = input.includes("CONFLICT_A") || input.includes("CONFLICT_B")
      ? "CONFLICT_A 与 CONFLICT_B 环境不同，待验证；" : "";
    return { content: early + conflict + "当前阶段：验证浏览器调用；下一步：比对签名。", usage: null };
  },
};
const ctx = await createUnifiedTurnContext({
  client,
  messages: await store.getModelMessages(thread.id),
  journal: await store.getUnifiedContext(thread.id),
  contextWindowTokens: 8192,
  reserveOutputTokens: 1024,
  toolSpecs: [{ type: "function", function: { name: "probe" } }],
  onAppend: events => store.appendContextEvents(thread.id, events),
  onCommit: (plan, summary, meta) => store.commitUnifiedCompaction(thread.id, plan, summary, meta),
  onRewrite: (snapshot, summary, meta) => store.commitUnifiedRewrite(thread.id, snapshot, summary, meta),
});
let messages = ctx.initialMessages;
for (let i = 0; i < 100; i++) {
  const id = "c" + i;
  messages.push({
    role: "assistant", content: "",
    tool_calls: [{ id, type: "function", function: { name: "probe", arguments: "{}" } }],
  });
  messages.push({
    role: "tool", tool_call_id: id,
    content: (i === 0 ? "FACT_EARLY " : i === 20 ? "CONFLICT_A " : i === 21 ? "CONFLICT_B " : "") + "x".repeat(480),
  });
  if (i === 50 || i === 75) {
    const text = i === 50 ? "先别做纯算法，先跑通浏览器调用" : "继续";
    const saved = await store.appendMessage(thread.id, { role: "user", content: text });
    messages.push({ role: "user", content: text, _contextEventId: saved.unifiedContext.lastId });
  }
  messages = await ctx.compact(i + 1, messages);
}
const journal = await store.getUnifiedContext(thread.id);
assert.equal(journal.events.filter(e => e.role === "tool").length, 100);
assert.ok(journal.compaction.version >= 2);
assert.ok(summaries >= 2);
assert.match(journal.compaction.summary, /FACT_EARLY/);
assert.match(journal.compaction.summary, /待验证/);
assert.equal(journal.taskCard.amendments.length, 1);
assert.match(journal.taskCard.amendments[0].text, /先别做纯算法/);
assert.match(JSON.stringify(projectUnifiedMessages(journal)), /先别做纯算法/);
assert.ok(journal.events.some(e => e.id === 3 && e.content.includes("FACT_EARLY")));
assert.ok(completeGroups(journal.events.filter(e => e.id > journal.compaction.coveredThrough)).every(g => g.complete));
console.log("OK 100 tool calls, correction, conflict, and early evidence survive rolling compactions");

const failed = await store.createThread();
await store.appendMessage(failed.id, { role: "user", content: "task" });
const appendGroup = async id => store.appendContextEvents(failed.id, [
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "probe", arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content: "result" },
]);
await appendGroup("a");
await appendGroup("b");
const before = await store.getUnifiedContext(failed.id);
const plan = planUnifiedCompaction(before, { triggerTokens: 1, targetTokens: 1, recentTokens: 1 });
assert.ok(plan);
const originalSave = store._save.bind(store);
store._save = async () => { throw new Error("disk failed"); };
await assert.rejects(store.commitUnifiedCompaction(failed.id, plan, "summary"), /disk failed/);
store._save = originalSave;
assert.equal((await store.getUnifiedContext(failed.id)).compaction, null);
assert.equal((await store.getUnifiedContext(failed.id)).events.length, before.events.length);
console.log("OK failed save keeps old view and raw log");

let changed = false;
const steerThread = await store.createThread();
await store.appendMessage(steerThread.id, { role: "user", content: "original task" });
await store.appendContextEvents(steerThread.id, [{ role: "assistant", content: "first" }, { role: "assistant", content: "second" }]);
const snapshot = await store.getUnifiedContext(steerThread.id);
const steerPlan = planUnifiedCompaction(snapshot, { triggerTokens: 1, targetTokens: 1, recentTokens: 1 });
await store.appendMessage(steerThread.id, { role: "user", content: "改成浏览器调用" });
await assert.rejects(store.commitUnifiedCompaction(steerThread.id, steerPlan, "stale"), /context changed/);
const afterSteer = await store.getUnifiedContext(steerThread.id);
changed = afterSteer.events.at(-1).content === "改成浏览器调用" && afterSteer.compaction === null;
assert.ok(changed);
console.log("OK new steer invalidates stale compaction without losing instruction");


const summaryFailed = await store.createThread();
await store.appendMessage(summaryFailed.id, { role: "user", content: "task" });
await store.appendContextEvents(summaryFailed.id, [
  { role: "assistant", content: "experiment one" },
  { role: "assistant", content: "experiment two" },
]);
const failingSummary = await createUnifiedTurnContext({
  client: { model: "test", async chat() { throw new Error("summary unavailable"); } },
  messages: await store.getModelMessages(summaryFailed.id),
  journal: await store.getUnifiedContext(summaryFailed.id),
  contextWindowTokens: 8192,
  onCommit: (plan, summary, meta) => store.commitUnifiedCompaction(summaryFailed.id, plan, summary, meta),
});
await assert.rejects(failingSummary.forceCompact(1, failingSummary.initialMessages), /summary unavailable/);
assert.equal((await store.getUnifiedContext(summaryFailed.id)).compaction, null);
assert.equal((await store.getUnifiedContext(summaryFailed.id)).events.length, 3);
console.log("OK failed summary leaves original model view and log intact");

const rewriteThread = await store.createThread();
await store.appendMessage(rewriteThread.id, { role: "user", content: "task" });
await store.appendContextEvents(rewriteThread.id, [
  { role: "assistant", content: "experiment one" },
  { role: "assistant", content: "experiment two" },
]);
const rewriteBefore = await store.getUnifiedContext(rewriteThread.id);
const rewritePlan = planUnifiedCompaction(rewriteBefore, { triggerTokens: 1, targetTokens: 1, recentTokens: 1 });
await store.commitUnifiedCompaction(rewriteThread.id, rewritePlan, "state ".repeat(1200));
const oldRewrite = await store.getUnifiedContext(rewriteThread.id);
let rewriteCalls = 0;
const rewriting = await createUnifiedTurnContext({
  client: { model: "test", async chat() { rewriteCalls++; return { content: "short state with experiment evidence" }; } },
  messages: await store.getModelMessages(rewriteThread.id),
  journal: oldRewrite,
  contextWindowTokens: 8192,
  onRewrite: (snapshot, summary, meta) => store.commitUnifiedRewrite(rewriteThread.id, snapshot, summary, meta),
});
await rewriting.forceCompact(1, rewriting.initialMessages);
const rewriteAfter = await store.getUnifiedContext(rewriteThread.id);
assert.equal(rewriteCalls, 1);
assert.equal(rewriteAfter.compaction.version, oldRewrite.compaction.version + 1);
assert.equal(rewriteAfter.compaction.coveredThrough, oldRewrite.compaction.coveredThrough);
assert.match(rewriteAfter.compaction.summary, /short state/);
console.log("OK global rewrite runs only on oversized cumulative state");


const { runAgentTurn } = await import("../modules/runtime/AgentLoop.sys.mjs");
const prior = [{ role: "user", content: "task" }];
for (let i = 0; i < 3; i++) {
  prior.push({ role: "assistant", content: "", tool_calls: [{ id: "prior" + i, type: "function", function: { name: "probe", arguments: "{}" } }] });
  prior.push({ role: "tool", tool_call_id: "prior" + i, content: "evidence " + "x".repeat(900) });
}
let mainCalls = 0;
const mainSizes = [];
await runAgentTurn({
  client: {
    model: "test", contextWindowTokens: 8192,
    async chat(messages, opts) {
      if (!opts.tools) return { content: "verified state", toolCalls: [] };
      mainCalls++;
      mainSizes.push(JSON.stringify(messages).length);
      if (mainCalls === 1) throw new Error("maximum context length exceeded");
      return { content: "## 结论：完成", toolCalls: [] };
    },
  },
  router: { listSpecs: () => [], needsConfirm: () => false, dispatch: async () => ({ ok: true }) },
  messages: prior, maxRounds: 2, assist: true, autoApprove: true, contextStrategy: "projected",
});
assert.equal(mainCalls, 2);
assert.ok(mainSizes[1] < mainSizes[0]);
console.log("OK provider overflow retries once with a smaller view");

const noArtifact = await store.createThread();
await store.appendMessage(noArtifact.id, { role: "user", content: "task" });
let noArtifactCalls = 0;
await assert.rejects(runAgentTurn({
  client: {
    model: "test", contextWindowTokens: 8192,
    async chat(_messages, opts) {
      if (!opts.tools) return { content: "summary", toolCalls: [] };
      noArtifactCalls++;
      return noArtifactCalls === 1
        ? { content: "", toolCalls: [{ id: "big", type: "function", function: { name: "probe", arguments: "{}" } }] }
        : { content: "## 结论：完成", toolCalls: [] };
    },
  },
  router: {
    listSpecs: () => [{ type: "function", function: { name: "probe", parameters: { type: "object" } } }],
    needsConfirm: () => false,
    dispatch: async () => ({ ok: true, data: "R".repeat(30000) }),
  },
  messages: await store.getModelMessages(noArtifact.id),
  journal: await store.getUnifiedContext(noArtifact.id),
  onContextAppend: events => store.appendContextEvents(noArtifact.id, events),
  onContextCommit: (plan, summary, meta) => store.commitUnifiedCompaction(noArtifact.id, plan, summary, meta),
  contextStrategy: "projected", maxRounds: 2, assist: true, autoApprove: true,
}), /context|budget/i);
const rawArtifactFallback = await store.getUnifiedContext(noArtifact.id);
assert.ok(rawArtifactFallback.events.some(e => e.role === "tool" && e.content.includes("R".repeat(20000))));
console.log("OK failed artifact archival preserves the full tool result before budget failure");


const steerOrder = await store.createThread();
await store.appendMessage(steerOrder.id, { role: "user", content: "original" });
let dispatched = 0;
let applied = false;
const steerRequests = [];
await runAgentTurn({
  client: {
    model: "test",
    async chat(messages, opts) {
      if (!opts.tools) return { content: "summary" };
      steerRequests.push(messages);
      return steerRequests.length === 1
        ? { content: "", toolCalls: [
            { id: "one", type: "function", function: { name: "probe", arguments: "{}" } },
            { id: "two", type: "function", function: { name: "probe", arguments: "{}" } },
          ] }
        : { content: "## 结论：已按新要求完成", toolCalls: [] };
    },
  },
  router: {
    listSpecs: () => [{ type: "function", function: { name: "probe", parameters: { type: "object" } } }],
    needsConfirm: () => false,
    async dispatch() { dispatched++; return { ok: true, data: "result" }; },
  },
  messages: await store.getModelMessages(steerOrder.id),
  journal: await store.getUnifiedContext(steerOrder.id),
  onContextAppend: events => store.appendContextEvents(steerOrder.id, events),
  onContextRefresh: () => store.getUnifiedContext(steerOrder.id),
  hasSteering: () => dispatched === 1 && !applied,
  consumeSteering: async () => {
    if (dispatched !== 1 || applied) return [];
    applied = true;
    const text = "先跑浏览器调用";
    const saved = await store.appendMessage(steerOrder.id, { role: "user", content: text });
    return [{ role: "user", content: text, _contextEventId: saved.unifiedContext.lastId }];
  },
  contextStrategy: "projected", maxRounds: 3, assist: true, autoApprove: true,
});
const ordered = (await store.getUnifiedContext(steerOrder.id)).events;
assert.deepEqual(ordered.map(e => e.role), ["user", "assistant", "tool", "tool", "user"]);
assert.equal(ordered.at(-1).content, "先跑浏览器调用");
assert.equal(dispatched, 1);
const modelOrder = steerRequests[1].map(m => m.role);
assert.deepEqual(modelOrder.slice(-4), ["assistant", "tool", "tool", "user"]);
console.log("OK steering stays after a complete multi-tool group in storage and model view");


const cancelledTask = await store.createThread();
await store.appendMessage(cancelledTask.id, { role: "user", content: "old goal" });
await store.setThreadTurnStatus(cancelledTask.id, "cancelled");
await store.appendMessage(cancelledTask.id, { role: "user", content: "新任务：分析另一站点" });
const cancelledJournal = await store.getUnifiedContext(cancelledTask.id);
assert.equal(cancelledJournal.taskCard.originalText, "old goal");
assert.equal(cancelledJournal.taskCard.amendments.at(-1).kind, "new_task");
console.log("OK cancelled task keeps original source and marks the new active goal");


// Thinking-only responses must be retried, never committed as factual state.
const retryBudgets = [];
const emptyRetry = await createUnifiedTurnContext({
  messages: prior,
  client: { async chat(_messages, opts) {
    retryBudgets.push(opts.maxTokens);
    return retryBudgets.length === 1
      ? { content: "", reasoningContent: "private reasoning", finishReason: "length" }
      : { content: "verified summary", finishReason: "stop" };
  } },
  contextWindowTokens: 8192, reserveOutputTokens: 1024,
});
await emptyRetry.forceCompact(1, emptyRetry.initialMessages);
assert.equal(retryBudgets.length, 2);
assert.ok(retryBudgets[1] > retryBudgets[0]);
assert.equal(emptyRetry.journal.compaction.summary, "verified summary");
console.log("OK thinking-only summary retries with more output room");

const automaticHistory = [{ role: "user", content: "task" },
  ...Array.from({ length: 12 }, () => ({ role: "assistant", content: "x".repeat(1100) }))];
let emptyCalls = 0;
const deferred = await createUnifiedTurnContext({
  messages: automaticHistory,
  client: { async chat() { emptyCalls++; return { content: "", finishReason: "length" }; } },
  contextWindowTokens: 8192, reserveOutputTokens: 1024,
});
const deferredView = await deferred.compact(1, deferred.initialMessages);
assert.equal(emptyCalls, 2);
assert.equal(deferred.journal.compaction, null);
assert.equal(deferred.journal.events.length, automaticHistory.length);
deferred.requestMessages(deferredView);
await deferred.compact(2, deferredView);
assert.equal(emptyCalls, 2, "proactive failure has a cooldown");
await assert.rejects(deferred.forceCompact(3, deferredView), /连续两次/);
assert.equal(emptyCalls, 4);
assert.equal(deferred.journal.compaction, null);
console.log("OK empty summaries defer safely, cooldown, and forced compaction fails finitely");

let oversizedCalls = 0;
const oversizedEmpty = await createUnifiedTurnContext({
  messages: [...automaticHistory, ...automaticHistory.slice(1)],
  client: { async chat() { oversizedCalls++; return { content: "partial", finishReason: "length" }; } },
  contextWindowTokens: 8192, reserveOutputTokens: 1024,
});
await assert.rejects(oversizedEmpty.compact(1, oversizedEmpty.initialMessages), /连续两次/);
assert.equal(oversizedCalls, 2);
assert.equal(oversizedEmpty.journal.compaction, null);
assert.equal(oversizedEmpty.journal.events.length, 25);
console.log("OK truncated summaries cannot commit or bypass main request budget");

const abortController = new AbortController();
let abortCalls = 0;
const abortedSummary = await createUnifiedTurnContext({
  messages: prior, signal: abortController.signal,
  client: { async chat() { abortCalls++; abortController.abort(); return { content: "" }; } },
  contextWindowTokens: 8192, reserveOutputTokens: 1024,
});
await assert.rejects(abortedSummary.forceCompact(1, abortedSummary.initialMessages), { name: "AbortError" });
assert.equal(abortCalls, 1);
assert.equal(abortedSummary.journal.compaction, null);
console.log("OK abort does not retry or commit");

let emptyRewriteCalls = 0;
const emptyRewrite = await createUnifiedTurnContext({
  journal: oldRewrite,
  client: { async chat() {
    emptyRewriteCalls++;
    return emptyRewriteCalls === 1 ? { content: "", finishReason: "length" }
      : { content: "short rewritten state", finishReason: "stop" };
  } },
  contextWindowTokens: 8192,
});
await emptyRewrite.forceCompact(1, emptyRewrite.initialMessages);
assert.equal(emptyRewriteCalls, 2);
assert.equal(emptyRewrite.journal.compaction.summary, "short rewritten state");
console.log("OK global rewrite shares bounded empty-output recovery");



// A steer arriving while both summary attempts fail must survive fallback.
const failureSteerThread = await store.createThread();
for (const message of automaticHistory) await store.appendMessage(failureSteerThread.id, message);
let failureSteerCalls = 0;
const failureSteer = await createUnifiedTurnContext({
  journal: await store.getUnifiedContext(failureSteerThread.id),
  client: { async chat() {
    if (++failureSteerCalls === 1)
      await store.appendMessage(failureSteerThread.id, { role: "user", content: "先验证浏览器调用" });
    return { content: "", finishReason: "length" };
  } },
  onRefresh: () => store.getUnifiedContext(failureSteerThread.id),
  contextWindowTokens: 8192, reserveOutputTokens: 1024,
});
const failureSteerView = await failureSteer.compact(1, failureSteer.initialMessages);
assert.equal(failureSteerView.at(-1).content, "先验证浏览器调用");
assert.equal(failureSteer.journal.compaction, null);
assert.equal(failureSteer.journal.taskCard.amendments.at(-1).text, "先验证浏览器调用");
console.log("OK steer survives empty-summary fallback");

// Production configuration reaches the unified path and survives persistence.
const { ConfigStore } = await import("../modules/providers/ConfigStore.sys.mjs");
const { buildClientFromStore } = await import("../modules/providers/providers.sys.mjs");
const { resolveContextWindowTokens } = await import("../modules/llm/LlmClient.sys.mjs");
const config = new ConfigStore();
const profile = config.createModelProfile({ provider: "deepseek", model: "deepseek-v4-flash" });
config.setActiveModelProfileId(profile.id);
assert.equal(buildClientFromStore(config).contextWindowTokens, 1000000);
config.updateModelProfile(profile.id, { contextWindowTokens: 256000 });
assert.equal(buildClientFromStore(config).contextWindowTokens, 256000);
assert.equal(buildClientFromStore(config, { contextWindowTokens: 64000 }).contextWindowTokens, 64000);
assert.equal(resolveContextWindowTokens("unknown"), 128000);
assert.equal(resolveContextWindowTokens("deepseek-v5-unknown"), 128000);
config.updateModelProfile(profile.id, { contextWindowTokens: null });
const largeClient = buildClientFromStore(config);
let largeCalls = 0;
largeClient.chat = async () => { largeCalls++; return { content: "summary" }; };
const largeContext = await createUnifiedTurnContext({
  client: largeClient,
  messages: [{ role: "user", content: "task" },
    ...Array.from({ length: 100 }, () => ({ role: "assistant", content: "x".repeat(6000) }))],
});
await largeContext.compact(1, largeContext.initialMessages);
assert.equal(largeCalls, 0, "200k tokens must not trigger compression for a 1M model");
console.log("OK model window, profile override and large-context runtime are connected");

// A large tools/system budget must be counted once, not subtracted twice.
const { messagesTokens, estimateTokens } = await import("../modules/state/UnifiedContext.sys.mjs");
let budgetCalls = 0;
const budgetToolSpecs = [{ type: "function", function: { name: "probe", description: "x".repeat(2100) } }];
const budgetCtx = await createUnifiedTurnContext({
  client: { async chat() { budgetCalls++; return { content: "verified concise state" }; } },
  contextWindowTokens: 10000, reserveOutputTokens: 1000,
  systemPrompt: "s".repeat(1500), dynamicContext: "d".repeat(300),
  toolSpecs: budgetToolSpecs,
  messages: [{ role: "user", content: "task" },
    ...Array.from({ length: 6 }, () => ({ role: "assistant", content: "a".repeat(1500) }))],
});
let budgetView = await budgetCtx.compact(1, budgetCtx.initialMessages);
assert.equal(budgetCalls, 0, "below 75% of full-request budget");
budgetView.push({ role: "assistant", content: "a".repeat(3600) });
budgetView = await budgetCtx.compact(2, budgetView);
assert.ok(budgetCalls > 0, "full request over threshold must compact, even if raw history is below it");
assert.equal(budgetCtx.journal.compaction.tokensAfter,
  messagesTokens(budgetView) + estimateTokens(budgetToolSpecs));
budgetCtx.requestMessages(budgetView);
console.log("OK trigger and committed token counts use the same full-request budget");
