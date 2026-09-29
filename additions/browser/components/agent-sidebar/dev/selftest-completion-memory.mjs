import assert from "node:assert/strict";
import { runCompletionMemory, extractCompletionMemory } from "../modules/state/CompletionMemory.sys.mjs";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { AgentTurnOrchestrator } from "../modules/runtime/AgentTurnOrchestrator.sys.mjs";
import { AgentRuntimeCore } from "../modules/runtime/AgentRuntimeCore.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { messagesTokens, planUnifiedCompaction } from "../modules/state/UnifiedContext.sys.mjs";
import { handoffJson } from "./handoff-fixture.mjs";

async function harness({ verified = false, content, workspaceRoot = "/ws" } = {}) {
  const store = new ConversationStore({ memoryOnly: true });
  const thread = await store.createThread();
  await store.appendMessage(thread.id, { role: "user", content: "verify endpoint" });
  await store.appendContextEvents(thread.id, [
    { role: "assistant", content: "", reasoning_content: "PRIVATE_REASONING",
      tool_calls: [{ id: "probe", type: "function", function: { name: "run_node", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "probe", content: JSON.stringify({ ok: true, data: { ok: true, output: "matched" } }) },
  ]);
  let chats = 0, writes = 0;
  const batches = new Map();
  const statuses = [];
  const ledger = {
    async hasVerified() { return verified; },
    async mergeHandoff(handoff, ctx, source) {
      const key = JSON.stringify(source);
      if (batches.has(key)) return { ok: true, added: 0, alreadyApplied: true };
      writes++; batches.set(key, handoff);
      if (handoff.memories.some(x => x.status === "verified")) verified = true;
      return { ok: true, added: handoff.memories.length };
    },
  };
  const value = JSON.parse(handoffJson("experiment matched"));
  value.facts = [{ text: "endpoint matched", status: "verified", evidenceIds: [3] }];
  const client = { model: "test", contextWindowTokens: 8192, async chat(messages) {
    chats++;
    assert.ok(!JSON.stringify(messages).includes("PRIVATE_REASONING"));
    assert.equal((await store.getThread(thread.id)).memoryCompletion.status, "pending");
    return { content: content ?? JSON.stringify(value), finishReason: "stop" };
  } };
  return { store, ledger, client, thread, statuses, batches,
    get chats() { return chats; }, get writes() { return writes; },
    input: { store, ledger, client, threadId: thread.id, workspaceRoot, toolContext: { workspaceRoot },
      signal: new AbortController().signal, onStatus: value => statuses.push(value) } };
}

let h = await harness();
await runCompletionMemory(h.input);
assert.equal(h.chats, 1); assert.equal(h.writes, 1);
assert.equal((await h.store.getUnifiedContext(h.thread.id)).compaction, null);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "saved");
assert.deepEqual([...h.batches.values()][0].memories[0].evidenceIds, [3]);
await runCompletionMemory(h.input);
assert.equal(h.chats, 1);
console.log("OK no compaction required; pending job precedes API; exactly one completion batch");

h = await harness({ verified: true });
await runCompletionMemory(h.input);
assert.equal(h.chats, 0); assert.equal(h.writes, 0);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "skipped");
h = await harness({ content: handoffJson("insufficient evidence") });
await runCompletionMemory(h.input);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "no_verified");
await runCompletionMemory(h.input);
assert.equal(h.chats, 1, "empty verified memory must not trigger repeated extraction");
console.log("OK existing verified record skips; no verified result records coverage");

h = await harness({ content: "invalid JSON" });
await runCompletionMemory(h.input);
assert.equal(h.chats, 2); assert.equal(h.writes, 0);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "pending");
await runCompletionMemory({ ...h.input, retryOnly: true, workspaceRoot: "/other" });
assert.equal(h.chats, 2);
h.client.chat = async () => ({ content: handoffJson("only observations"), finishReason: "stop" });
await runCompletionMemory({ ...h.input, retryOnly: true });
assert.equal(h.writes, 1);
console.log("OK extraction failure durable; wrong directory cannot redirect recovery");

h = await harness();
const merge = h.ledger.mergeHandoff;
h.ledger.mergeHandoff = async () => { throw new Error("SQL unavailable"); };
await runCompletionMemory(h.input);
assert.equal(h.chats, 1);
assert.ok((await h.store.getThread(h.thread.id)).memoryCompletion.job.handoff);
h.ledger.mergeHandoff = merge;
await runCompletionMemory({ ...h.input, retryOnly: true });
assert.equal(h.chats, 1, "retry saved handoff without another API request");
assert.equal(h.writes, 1);
console.log("OK database failure recovers from durable handoff");

h = await harness();
const save = h.store.setMemoryCompletion.bind(h.store);
h.store.setMemoryCompletion = async (id, state) => {
  if (state.status === "saved") throw new Error("receipt save failed");
  return save(id, state);
};
await runCompletionMemory(h.input);
assert.equal(h.writes, 1);
h.store.setMemoryCompletion = save;
await runCompletionMemory({ ...h.input, retryOnly: true });
assert.equal(h.chats, 1); assert.equal(h.writes, 1);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "saved");
console.log("OK crash between SQLite and conversation receipt replays idempotently");

h = await harness();
h.store.setMemoryCompletion = async () => { throw new Error("disk failed"); };
await runCompletionMemory(h.input);
assert.equal(h.chats, 0); assert.equal(h.writes, 0);
console.log("OK failed initial persistence prevents API call");

h = await harness();
const abort = new AbortController(); abort.abort();
await runCompletionMemory({ ...h.input, signal: abort.signal });
assert.equal(h.chats, 0);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion, undefined);
console.log("OK cancelled task starts no memory request");

// Real AgentLoop + orchestrator: the final answer is durable before extraction.
// Stopping memory must leave the already completed task completed.
h = await harness();
const core = new AgentRuntimeCore();
const orch = Object.create(AgentTurnOrchestrator.prototype);
orch.conversationStore = h.store; orch.runtimeCore = core;
const state = core.beginRun(h.thread.id);
const ac = new AbortController(); state.abort = ac;
const journal = await h.store.getUnifiedContext(h.thread.id);
const taskClient = { async chat() { return { content: "已完成，接口验证成功", toolCalls: [] }; } };
const result = await runAgentTurn({
  client: taskClient, messages: await h.store.getModelMessages(h.thread.id), journal,
  router: { listSpecs: () => [], needsConfirm: () => false, async dispatch() {} },
  contextWindowTokens: 8192,
});
assert.equal(result.stopReason, "final");
let memoryCalls = 0;
h.client.chat = async () => {
  memoryCalls++;
  const current = await h.store.getThread(h.thread.id);
  assert.equal(current.lastTurnStatus, "completed");
  assert.match(current.messages.at(-1).content, /已完成/);
  assert.equal(core.getState(h.thread.id).taskCompleted, true);
  core.abortThread(h.thread.id);
  ac.signal.throwIfAborted();
};
await orch._complete({ threadId: h.thread.id, state, abortController: ac, client: h.client,
  backends: { ledger: h.ledger }, workspaceRoot: "/ws", toolContext: { workspaceRoot: "/ws" } }, result);
assert.equal(memoryCalls, 1);
assert.equal(state.aborted, false);
assert.equal((await h.store.getThread(h.thread.id)).lastTurnStatus, "completed");
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "pending");
console.log("OK real final stop invokes extraction; cancel memory preserves completed task");

// Multiple chunks retain original logs even when the model view has compressed them.
h = await harness();
await h.store.appendContextEvents(h.thread.id, [
  { role: "assistant", content: "", tool_calls: [{ id: "large", type: "function", function: { name: "probe", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "large", content: "OBSERVATION ".repeat(6500) },
  { role: "assistant", content: "final report is only a guide" },
]);
const before = await h.store.getUnifiedContext(h.thread.id);
const plan = planUnifiedCompaction(before, { triggerTokens: 0, recentTokens: 1 });
await h.store.commitUnifiedCompaction(h.thread.id, plan, "compressed");
let requests = 0;
h.client.chat = async (messages, options) => {
  requests++;
  assert.ok(messagesTokens(messages) + options.maxTokens + 1024 <= 8192);
  assert.ok(!JSON.stringify(messages).includes("PRIVATE_REASONING"));
  return { content: handoffJson("observations"), finishReason: "stop" };
};
await runCompletionMemory(h.input);
assert.ok(requests > 1);
assert.equal((await h.store.getUnifiedContext(h.thread.id)).compaction.version, 1);
console.log("OK chunk budgets include full request; historical evidence survives compaction");

// No known evidence may be upgraded based solely on assistant claims or failed results.
h = await harness();
let bad = JSON.parse(handoffJson("unsupported"));
bad.facts = [{ text: "claim", status: "verified", evidenceIds: [2] }];
h.client.chat = async () => ({ content: JSON.stringify(bad) });
await runCompletionMemory(h.input);
assert.equal(h.writes, 0);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "pending");
console.log("OK assistant-only evidence does not establish completion facts");

// Read only archived evidence, preserve thinking/tool pairing, and retain byte ranges.
h = await harness();
await h.store.appendContextEvents(h.thread.id, [
  { role: "assistant", content: "", tool_calls: [{ id: "archive", type: "function", function: { name: "run_node", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "archive", content: "result archived; inspect evidence",
    artifact: { path: ".frx-context/tool-results/evidence.json", version: "immutable-evidence-v1" } },
]);
let readCalls = 0, modelCalls = 0;
const readEvidence = async args => {
  readCalls++; assert.deepEqual(args, { path: ".frx-context/tool-results/evidence.json", offset: 10, limit: 100 });
  return { ok: true, content: '{"matched":true}', bytes: 16, size: 1000, truncated: true };
};
h.client.chat = async (messages, opts) => {
  modelCalls++;
  assert.equal(opts.tools[0].function.name, "read_memory_evidence");
  if (modelCalls === 1) return { content: "", reasoningContent: "READ_REASONING",
    toolCalls: [
      { id: "read1", type: "function", function: { name: "read_memory_evidence", arguments: '{"eventId":5,"offset":10,"limit":100}' } },
      { id: "bad", type: "function", function: { name: "read_memory_evidence", arguments: '{"eventId":999,"path":"/secret"}' } },
    ] };
  assert.equal(messages.at(-3).reasoning_content, "READ_REASONING");
  assert.equal(messages.at(-2).tool_call_id, "read1");
  assert.equal(JSON.parse(messages.at(-1).content).ok, false);
  const result = JSON.parse(handoffJson("archived evidence confirms"));
  result.facts = [{ text: "matched", status: "verified", evidenceIds: [5] }];
  return { content: JSON.stringify(result) };
};
await runCompletionMemory({ ...h.input, readEvidence });
assert.equal(readCalls, 1); assert.equal(modelCalls, 2);
assert.equal((await h.store.getThread(h.thread.id)).memoryCompletion.status, "saved");
assert.deepEqual([...h.batches.values()][0].memories[0].evidenceArtifacts[0].readSlices, [{ offset: 10, limit: 100 }]);
console.log("OK bounded evidence reader cannot access arbitrary paths; thinking/tool groups and source slices retained");

// Save rollback must preserve an already pending job and unrelated new input.
h = await harness({ content: "bad" });
await runCompletionMemory(h.input);
const prior = structuredClone((await h.store.getThread(h.thread.id)).memoryCompletion);
await h.store.appendMessage(h.thread.id, { role: "user", content: "new direction" });
h.store._save = async () => { throw new Error("disk down"); };
await assert.rejects(h.store.setMemoryCompletion(h.thread.id, { status: "saved" }), /disk down/);
assert.deepEqual((await h.store.getThread(h.thread.id)).memoryCompletion, prior);
assert.equal((await h.store.getUnifiedContext(h.thread.id)).events.at(-1).content, "new direction");
console.log("OK failed receipt save rolls back memory metadata without losing new input");
