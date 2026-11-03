import assert from "node:assert/strict";
import { ToolRouter } from "../modules/tools/ToolRouter.sys.mjs";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
for (const localToolsEnabled of [true, false]) {
  for (const content of ["这里是加密过程和尝试的总结。", "五页总和 = 27542089", "The verified result is 42.", "下一步：我会检查目标文件并验证结果。", "Next, I will inspect the page."]) {
    let calls = 0;
    const r = await runAgentTurn({
      router: new ToolRouter().register({ name: "fs_read", handler: () => assert.fail("summary must not execute tools") }),
      localToolsEnabled, maxRounds: 5,
      messages: [{ role: "user", content: "总结一下过程和结果" }],
      client: { chat: async () => { calls++; return { content, toolCalls: [], finishReason: "stop" }; } },
    });
    assert.equal(calls, 1);
    assert.equal(r.content, content);
    assert.equal(r.stopReason, "final");
    assert(!JSON.stringify(r.messages).includes("现在就调用工具"));
  }
}
console.log("final response passed");
