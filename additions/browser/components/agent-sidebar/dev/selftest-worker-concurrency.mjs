import assert from "node:assert/strict";
import { WorkerLease } from "../modules/runtime/WorkerLease.sys.mjs";
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { LedgerBackend } from "../modules/backends/LedgerBackend.sys.mjs";
import { LlmClient } from "../modules/llm/LlmClient.sys.mjs";
import { ToolRouter } from "../modules/tools/ToolRouter.sys.mjs";
const delay = ms => new Promise(r => setTimeout(r, ms));
for (let round = 0; round < 30; round++) {
  const lease = new WorkerLease({ claim: async root => { await delay(1); return root; } });
  const a = lease.prepare("A", {workspaceRoot:"/A"});
  await assert.rejects(lease.prepare("B", {workspaceRoot:"/B"}), /正在/);
  assert.throws(() => lease.raw("env_list"), /占用/);
  const token = await a;
  await assert.rejects(lease.begin("B", {workspaceRoot:"/A", preparationToken:token}), /不匹配/);
  await lease.begin("A", {workspaceRoot:"/A", preparationToken:token});
  lease.cancelPreparation(token);
  assert.equal(lease.snapshot().phase, "running", "cancelling preparation cannot release a running task");
  lease.finish(token);
  await assert.rejects(lease.prepare("B", {workspaceRoot:"/B"}), /绑定/);
  const next = await lease.begin("A", {workspaceRoot:"/A"});
  lease.poison("timeout"); lease.finish(next);
  await assert.rejects(lease.prepare("A", {workspaceRoot:"/A"}), /重启/);
  assert.throws(() => lease.raw("env_list"), /重启/);

  const store = new ConversationStore({memoryOnly:true});
  let loads = 0;
  const read = store._readFile.bind(store);
  store._readFile = async () => { loads++; await delay(1); return read(); };
  const [ta, tb] = await Promise.all([store.createThread("A"), store.createThread("B")]);
  assert.equal(loads, 1);
  assert.equal((await store.listThreads()).length, 2);
  let writes = 0;
  store._save = async () => { await delay(1); if (++writes === 1) throw Error("injected disk failure"); };
  const results = await Promise.allSettled([
    store.appendMessage(ta.id, {role:"user", content:"A failed"}),
    store.appendMessage(tb.id, {role:"user", content:"B survives"}),
  ]);
  assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "fulfilled");
  assert.equal((await store.getThread(ta.id)).messages.length, 0);
  const snap = await store.getThread(tb.id);
  assert.equal(snap.messages[0].content, "B survives");
  snap.messages.length = 0;
  assert.equal((await store.getThread(tb.id)).messages.length, 1);
}
console.log("PASS: 30 rounds of admission, poison, cold load, rollback and snapshot isolation");

const signal = new AbortController().signal;
let listeners = 0;
const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
signal.addEventListener = (...args) => { listeners++; return add(...args); };
signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
const client = new LlmClient({protocol:"openai",baseUrl:"http://fixture.invalid",apiKey:"fixture",model:"test",
  transport:{fetch:async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:"ok"},finish_reason:"stop"}]})})}});
for (let i=0;i<30;i++) {
  await client.chat([{role:"user",content:"fixture"}],{signal});
  assert.equal(listeners,0);
}
const router = new ToolRouter({maxChars:50});
router.register({name:"large",handler:async()=>"x".repeat(500)});
const [full, clipped] = await Promise.all([router.dispatch("large",{}, {},{maxChars:1000}),router.dispatch("large",{})]);
assert.equal(router.maxChars,50); assert.equal(full.data.length,500); assert.ok(clipped.meta?.truncated);
let unsafe = false;
router.register({name:"timeout",handler:async()=>({timedOut:true})});
await router.dispatch("timeout",{}, {onUnsafeExecution:()=>{unsafe=true;}});
assert.equal(unsafe,true);
for (let i=0;i<30;i++) {
  const ledger = new LedgerBackend();
  let snapshot = "A", written = "", release, started;
  const barrier = new Promise(r=>{release=r;});
  const entered = new Promise(r=>{started=r;});
  let count = 0;
  ledger._writeMirror = async () => { const value=snapshot; if (++count===1) {started(); await barrier;} written=value; };
  const a=ledger._renderMd({workspaceRoot:"/same"});
  await entered;
  snapshot="A+B";
  const b=ledger._renderMd({workspaceRoot:"/same"});
  release(); await Promise.all([a,b]); assert.equal(written,"A+B");
}
console.log("PASS: listener cleanup, request-local output limits, timeout poisoning and 30 mirror races");
