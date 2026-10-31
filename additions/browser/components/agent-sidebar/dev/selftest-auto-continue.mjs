import assert from "node:assert/strict";
import { ToolRouter } from "../modules/tools/ToolRouter.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";

const reply = (content, extra = {}) => ({ content, toolCalls: [], finishReason: "stop", ...extra });
const plan = reply("接下来我会检查目标文件，然后验证结果。");
const tool = id => reply("", { toolCalls: [{
  id, type: "function", function: { name: "fs_read", arguments: JSON.stringify({ path: id }) },
}] });

async function run(responses, options = {}) {
  const requests = [], dispatched = [], events = [];
  const router = new ToolRouter().register({
    name: "fs_read",
    handler: args => { dispatched.push(args.path); return { value: 42 }; },
  });
  const result = await runAgentTurn({
    router, maxRounds: 20,
    messages: [{ role: "user", content: "检查目标文件，验证结果并完成任务" }],
    client: { chat: async messages => {
      requests.push(structuredClone(messages));
      const next = typeof responses === "function" ? responses(requests.length) : responses[requests.length - 1];
      assert.ok(next, "unexpected extra model request");
      return structuredClone(next);
    } },
    onEvent: event => events.push(event),
    ...options,
  });
  return { result, requests, dispatched, events };
}

for (const localToolsEnabled of [true, false]) {
  for (const content of [plan.content, "我先分析一下目标文件。", "下一步：验证结果。", "继续检查目标文件。", "I'll inspect the target file and verify the result.", "Next, I will run the verification.", "I’ll verify the result."]) {
    const first = reply(content, { reasoningContent: "original reasoning", providerState: { opaque: "provider replay" } });
    const r = await run([first, tool("target"), reply("验证结果为 42。")], { localToolsEnabled });
    assert.equal(r.requests.length, 3);
    assert.deepEqual(r.dispatched, ["target"]);
    assert.equal(r.result.stopReason, "final");
    assert.equal(r.result.content, "验证结果为 42。");
    const replay = r.requests[1].find(message => message.role === "assistant");
    assert.equal(replay.content, content);
    assert.equal(replay.reasoning_content, first.reasoningContent);
    assert.deepEqual(replay.providerState, first.providerState);
    assert.match(r.requests[1].at(-1).content, /自动续跑/);
    assert.ok(r.requests[2].some(message => message.role === "tool" && message.tool_call_id === "target"));
  }
}

{
  const r = await run([tool("initial"), plan, tool("verification"), reply("完成，结果为 42。")]);
  assert.deepEqual(r.dispatched, ["initial", "verification"]);
  assert.equal(r.requests.length, 4);
}

{
  const r = await run([plan, plan, plan, tool("initial"), plan, plan, plan, tool("verification"), reply("结果为 42。")]);
  assert.deepEqual(r.dispatched, ["initial", "verification"]);
  assert.equal(r.result.stopReason, "final");
}

{
  const r = await run(() => plan);
  assert.equal(r.requests.length, 4);
  assert.deepEqual(r.dispatched, []);
  assert.equal(r.result.stopReason, "drift");
  assert.match(r.result.content, /尚未完成任务/);
  assert.equal(r.events.filter(event => event.type === "final").length, 1);
}

for (const content of [
  "需要你提供新的登录态，收到后我会检查目标页面。",
  "请提供样本，然后我会验证结果。",
  "I need your credentials before I can inspect the page.",
  "已全部完成，五页总和为 42。后续可以增加更多测试。",
  "已完成验证，结果为 42。下一步建议：运行更多样本测试。",
  "The verified result is 42.",
  "The verified result is 42. Next, you can run additional tests.",
  "```js\n// Next, I will run verification.\nconsole.log(42);\n```",
  "> 接下来我会验证结果。\n\n上面是之前的计划；验证结果为 42。",
]) {
  const r = await run([reply(content)]);
  assert.equal(r.requests.length, 1);
  assert.equal(r.result.content, content);
  assert.equal(r.result.stopReason, "final");
}

{
  const r = await run([plan], { assist: true });
  assert.equal(r.requests.length, 1);
  assert.equal(r.result.stopReason, "final");
}

{
  const r = await run([plan], { router: new ToolRouter() });
  assert.equal(r.requests.length, 1);
  assert.equal(r.result.stopReason, "final");
}

{
  const r = await run([reply(""), tool("target"), reply("结果为 42。")]);
  assert.deepEqual(r.dispatched, ["target"]);
}

{
  const truncated = reply("", { finishReason: "length", reasoningContent: "original truncated reasoning" });
  const r = await run([plan, truncated, truncated, truncated, truncated, plan, tool("target"), reply("结果为 42。")]);
  assert.deepEqual(r.dispatched, ["target"]);
  assert.equal(r.result.stopReason, "final");
}

{
  const controller = new AbortController();
  const r = await run([plan], { signal: controller.signal,
    onUsage: () => controller.abort(),
  });
  assert.equal(r.requests.length, 1);
  assert.deepEqual(r.dispatched, []);
  assert.equal(r.result.stopReason, "aborted");
}

{
  let consumed = false;
  const r = await run([plan, plan], {
    hasSteering: () => !consumed,
    consumeSteering: async () => {
      consumed = true;
      return [{ role: "user", content: "只总结进展，不要继续执行" }];
    },
  });
  assert.equal(r.requests.length, 1);
  assert.equal(r.result.stopReason, "final");
}

for (const content of ["总结进展，然后继续验证目标文件", "总结进展后继续验证目标文件", "Explain the findings and fix the issue."]) {
  const r = await run([plan, tool("target"), reply("结果为 42。")], {
    messages: [{ role: "user", content }],
  });
  assert.deepEqual(r.dispatched, ["target"]);
}

console.log("auto continuation passed");
