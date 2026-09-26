import assert from "node:assert/strict";
import { parseHandoff, mergeHandoffs } from "../modules/state/MemoryContract.sys.mjs";
import { createUnifiedContext, planUnifiedCompaction } from "../modules/state/UnifiedContext.sys.mjs";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { AgentTurnOrchestrator } from "../modules/runtime/AgentTurnOrchestrator.sys.mjs";
import { handoffJson } from "./handoff-fixture.mjs";
const journal = createUnifiedContext([
  { role: "user", content: "goal" },
  { role: "assistant", content: "experiment" },
  { role: "user", content: "continue" },
]);
const value = JSON.parse(handoffJson("verified summary"));
value.facts = [{ text: "observed result", status: "verified", evidenceIds: [2] }];
value.hypotheses = [{ text: "possible explanation", status: "unverified", evidenceIds: [2] }];
const handoff = parseHandoff(JSON.stringify(value), journal.events, 2);
assert.equal(handoff.memories[1].kind, "hypothesis");
assert.throws(() => parseHandoff("## 已确认事实", journal.events, 2));
assert.throws(() => parseHandoff(JSON.stringify({ ...value, facts: [{ ...value.facts[0], evidenceIds: [3] }] }), journal.events, 2), /uncovered/);
assert.throws(() => parseHandoff(JSON.stringify({ ...value, facts: [{ ...value.facts[0], status: "unverified" }] }), journal.events, 2), /verified/);
assert.equal(mergeHandoffs(handoff, { ...handoff, memories: [] }).memories.length, 2);

const store = new ConversationStore({ memoryOnly: true });
const thread = await store.createThread();
for (const event of journal.events) await store.appendMessage(thread.id, event);
const plan = planUnifiedCompaction(await store.getUnifiedContext(thread.id),
  { triggerTokens: 0, recentTokens: 1 });
const save = store._save.bind(store);
store._save = async () => { throw new Error("disk failed"); };
await assert.rejects(store.commitUnifiedCompaction(thread.id, plan, handoff.summary, { handoff }), /disk failed/);
assert.equal((await store.getUnifiedContext(thread.id)).memoryOutbox.length, 0);
store._save = save;
await store.commitUnifiedCompaction(thread.id, plan, handoff.summary, { handoff });
let state = await store.getUnifiedContext(thread.id);
assert.equal(state.memoryOutbox.length, 1);
assert.deepEqual(state.compaction.handoff, handoff);
await store.markMemorySync(thread.id, 1, "sqlite unavailable");
state = await store.getUnifiedContext(thread.id);
assert.equal(state.memoryOutbox[0].attempts, 1);
assert.equal(state.memoryOutbox[0].status, "pending");
assert.equal(state.events.length, 3);
await store.markMemorySync(thread.id, 1);
assert.equal((await store.getUnifiedContext(thread.id)).memoryOutbox.length, 0);
console.log("OK structured contract, qualified coverage, monotonic memory aggregation and atomic durable outbox");

// Exercise the actual checkpoint recovery coordinator against the persisted store.
await store.commitUnifiedRewrite(thread.id, {
  version: 1, coveredThrough: state.compaction.coveredThrough,
  taskCardVersion: state.taskCard.version, snapshotHead: state.lastId,
}, handoff.summary, { handoff, workspaceRoot: "/ws" });
let fail = true, writes = 0;
const warnings = [];
const orchestrator = Object.create(AgentTurnOrchestrator.prototype);
orchestrator.conversationStore = store;
orchestrator.runtimeCore = { pushDelta: (_, text) => warnings.push(text), notify() {} };
const context = { threadId: thread.id, workspaceRoot: "/ws", state: {},
  toolContext: { workspaceRoot: "/ws" },
  backends: { ledger: { async mergeHandoff(value, ctx, source) {
    writes++;
    assert.deepEqual(value, handoff);
    assert.equal(source.version, 2);
    assert.equal(ctx.workspaceRoot, "/ws");
    if (fail) throw new Error("database unavailable");
    return { ok: true };
  } } } };
await orchestrator._syncMemory(context);
state = await store.getUnifiedContext(thread.id);
assert.equal(state.memoryOutbox[0].attempts, 1);
assert.equal(state.compaction.summary, handoff.summary);
assert.equal(state.events.length, 3);
assert.match(warnings[0], /记忆同步待重试/);
await orchestrator._syncMemory({ ...context, workspaceRoot: "/other" });
assert.equal(writes, 1, "workspace change must not redirect pending memory");
fail = false;
await orchestrator._syncMemory(context);
assert.equal(writes, 2);
assert.equal((await store.getUnifiedContext(thread.id)).memoryOutbox.length, 0);
await orchestrator._syncMemory(context);
assert.equal(writes, 2, "successful outbox must not replay");
console.log("OK orchestrator preserves summary on Ledger failure and retries in its original workspace");
