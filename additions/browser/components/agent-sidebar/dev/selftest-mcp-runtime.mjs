import assert from "node:assert/strict";
import { ToolRouter } from "../modules/tools/ToolRouter.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { assertAgentRouterPort } from "../modules/runtime/AgentRuntimePorts.sys.mjs";

let policy = "ask", invoked = 0, saved = 0;
const name = "mcp_service_write";
const spec = { name, mcp: { serverId: "service", toolName: "write" }, needsConfirm: true,
  getPolicy: () => policy, approveAlways: async () => { policy = "allow"; saved++; },
  handler: async () => { invoked++; return "done"; } };
const router = new ToolRouter();
let prepared = 0;
router.setPrepareHook(() => { prepared++; router.replaceSource("service", [spec]); });
async function run(options = {}, beforeReply) {
  let calls = 0;
  const client = { chat: async (_messages, config) => {
    if (calls++ === 0) {
      assert(config.tools.some(t => t.function.name === name));
      await beforeReply?.();
      return { toolCalls: [{ id: "call", type: "function", function: { name, arguments: "{}" } }] };
    }
    return { content: "done" };
  } };
  return runAgentTurn({ client, router: assertAgentRouterPort(router), messages: [], assist: true, maxRounds: 2, ...options });
}
let result = await run({ autoApprove: true });
assert.equal(result.toolCalls[0].env.denied, true, "builtin auto-approve must not bypass MCP ask");
assert.equal(invoked, 0);
await run({ mcpAutoApprove: true, confirm: () => { throw Error("must not prompt"); } });
assert.equal(invoked, 1);
assert.equal(policy, "ask", "automatic approval is not persistent");
assert.equal((await router.dispatch(name, {})).denied, true, "raw dispatch cannot bypass ask");
policy = "deny";
result = await run({ mcpAutoApprove: true });
assert.equal(result.toolCalls[0].env.denied, true);
policy = "ask";
result = await run({ confirm: async call => { assert.equal(call.mcp.serverId, "service"); policy = "deny"; return true; } });
assert.equal(result.toolCalls[0].env.denied, true, "revocation while waiting is immediate");
policy = "ask";
await run({ confirm: async () => ({ approved: true, always: true }) });
assert.equal(saved, 1);
assert.equal(policy, "allow");
await run({ confirm: () => { throw Error("allow must not prompt"); } });
policy = "ask";
const controller = new AbortController();
result = await run({ signal: controller.signal, confirm: async () => { controller.abort(); return { approved: true, always: true }; } });
assert.equal(saved, 1, "cancelled confirmation does not persist approval");
assert.equal(result.toolCalls[0].env.denied, true);
policy = "allow";
await run({}, () => router.removeSource("service"));
assert(prepared >= 8, "prepare is forwarded by runtime port");
router.register({ name: "builtin", handler: () => true });
assert.throws(() => router.replaceSource("service", [{ ...spec, name: "builtin" }]));
assert(router.has("builtin"), "failed source replacement is atomic");
// A persistent grant applies immediately to later calls in this same snapshot.
policy = "ask";
let prompts = 0, batches = 0;
await runAgentTurn({ router, messages: [], assist: true, maxRounds: 3,
  confirm: async () => { prompts++; return { approved: true, always: true }; },
  client: { chat: async () => batches++ < 2
    ? { toolCalls: [{ id: String(batches), type: "function", function: { name, arguments: "{}" } }] }
    : { content: "done" } } });
assert.equal(prompts, 1);
// Cancellation during connection preparation never enters the model pipeline.
const preparingAbort = new AbortController();
const preparingRouter = new ToolRouter().setPrepareHook(() => preparingAbort.abort());
const cancelled = await runAgentTurn({ router: preparingRouter, messages: [], signal: preparingAbort.signal,
  client: { chat: () => { throw Error("model must not run after cancellation"); } } });
assert.equal(cancelled.stopReason, "aborted");

const { AgentRuntimeCore } = await import("../modules/runtime/AgentRuntimeCore.sys.mjs");
const { AgentTurnOrchestrator } = await import("../modules/runtime/AgentTurnOrchestrator.sys.mjs");
const core = new AgentRuntimeCore();
const orchestrator = Object.create(AgentTurnOrchestrator.prototype);
orchestrator.runtimeCore = core;
orchestrator.getRouter = () => router;
const state = core.beginRun("approval");
state.abort = new AbortController();
state.approveAll = true; // Builtin global approval must not approve MCP.
let pending = orchestrator._requestConfirmation(state, { id: "p", name, args: {}, mcp: spec.mcp });
assert(state.pendingConfirm);
assert.equal(core.getState("approval").pendingConfirm.mcp.serverId, "service");
core.respondConfirm("approval", "p", true, true);
assert.deepEqual(await pending, { approved: true, always: true });
state.approveAll = false;
pending = orchestrator._requestConfirmation(state, { id: "p2", name, args: {}, mcp: spec.mcp });
core.respondConfirm("approval", "p2", true, true);
assert.deepEqual(await pending, { approved: true, always: true });
assert.equal(state.approveAll, false, "MCP persistent approval cannot authorize other tools");
pending = orchestrator._requestConfirmation(state, { id: "p3", name, args: {}, mcp: spec.mcp });
core.abortThread("approval");
assert.equal(await pending, false);
assert.equal(state.pendingConfirm, null);
for (const assist of [false, true]) {
  for (const confirmMode of [false, true]) {
    const opts = orchestrator._buildLoopOptions({ assist, confirmMode, abortController: new AbortController(), state }, []);
    assert.equal(opts.mcpAutoApprove, !assist);
    assert.equal(opts.autoApprove, !confirmMode);
    assert.equal(typeof opts.confirm, "function");
  }
}
console.log("MCP runtime selftest: all passed");
