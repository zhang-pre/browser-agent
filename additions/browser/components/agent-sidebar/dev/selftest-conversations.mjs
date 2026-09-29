/* dev/selftest-conversations.mjs — ConversationStore（内存 backend）逻辑自测。
 *   node dev/selftest-conversations.mjs
 */
import { ConversationStore } from "../modules/state/ConversationStore.sys.mjs";
import { planUnifiedCompaction } from "../modules/state/UnifiedContext.sys.mjs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.error("  ✗ FAIL:", m)));

const s = new ConversationStore({ memoryOnly: true });

ok((await s.listThreads()).length === 0, "初始无线程");

const t1 = await s.createThread();
ok(t1.id && t1.title === "新对话" && t1.messages.length === 0, "createThread 返回空线程");
ok((await s.listThreads()).length === 1, "列表含 1 条");

await s.appendMessage(t1.id, { role: "user", content: "帮我分析 sign 加密入口在哪" });
const got = await s.getThread(t1.id);
ok(got.messages.length === 1 && got.messages[0].role === "user", "appendMessage 落入");
ok(got.title === "帮我分析 sign 加密入口在哪", "首条 user 消息自动成标题");

await s.appendMessage(t1.id, { role: "assistant", content: "..." });
ok((await s.getThread(t1.id)).messages.length === 2, "assistant 消息追加");

const longThread = await s.createThread("长会话");
for (let i = 0; i < 10; i++) {
  await s.appendMessage(longThread.id, {
    role: i % 2 ? "assistant" : "user",
    content: `${i}:` + "x".repeat(2000),
  });
}
const journal = await s.getUnifiedContext(longThread.id);
const plan = planUnifiedCompaction(journal, { triggerTokens: 1, targetTokens: 1000, recentTokens: 1500 });
await s.commitUnifiedCompaction(longThread.id, plan, "已确认事实和下一步");
const projected = await s.getModelMessages(longThread.id);
ok(projected.length < 10 && projected[0].content.includes("任务卡") &&
   projected[1].content.includes("已确认事实和下一步") &&
   projected.at(-1)._contextEventId === 10, "模型视图使用统一任务卡、累计状态和近期原文");
ok((await s.getThread(longThread.id)).messages.length === 10, "投影不删除 UI 完整历史");
await s.addThreadUsage(longThread.id, {
  requests: 2,
  inputTokens: 1000,
  uncachedInputTokens: 400,
  outputTokens: 50,
  cacheReadTokens: 600,
  providerReported: true,
});
ok((await s.getThread(longThread.id)).usage.cacheReadTokens === 600, "会话累计 Usage 持久化");

await s.setThreadTurnStatus(t1.id, "cancelled");
ok((await s.getThread(t1.id)).cancellationPending === true, "手动停止写入取消边界");
ok((await s.consumeCancellationBoundary(t1.id)) === true, "下一轮消费取消边界");
ok((await s.consumeCancellationBoundary(t1.id)) === false, "取消边界只消费一次");

await s.setThreadMode(t1.id, "supervised");
ok((await s.getThread(t1.id)).mode === null, "已移除的双模型模式不再持久化");
await s.setThreadMode(t1.id, "assist");

const bundle = await s.exportThread(t1.id);
ok(bundle.format === "firefox-reverse-conversation" && bundle.schemaVersion === 1, "导出包格式带版本");
ok(!("workspace" in bundle.conversation) && !("envId" in bundle.conversation), "导出不携带本机目录和环境绑定");
const imported = await s.importThread(JSON.stringify(bundle));
ok(imported.id !== t1.id && imported.messages.length === 2, "导入生成新 id 并保留消息");
ok(imported.mode === "assist", "导入保留辅助模式");
const retiredBundle = structuredClone(bundle);
retiredBundle.conversation.mode = "supervised";
const retiredImport = await s.importThread(JSON.stringify(retiredBundle));
ok(retiredImport.mode === null && retiredImport.messages.length === 2, "旧双模型导入保留消息但不再启用旧模式");
const savedIOUtils = globalThis.IOUtils;
globalThis.IOUtils = {
  readJSON: async () => ({ threads: [{ ...t1, mode: "supervised" }] }),
};
try {
  const reopened = new ConversationStore({ memoryOnly: false, path: "legacy-conversations.json" });
  const oldThread = await reopened.getThread(t1.id);
  ok(oldThread.mode === null && oldThread.messages.length === 2, "旧双模型本机会话保留消息并重置模式");
} finally {
  if (savedIOUtils === undefined) delete globalThis.IOUtils;
  else globalThis.IOUtils = savedIOUtils;
}
const savedLegacyIO = globalThis.IOUtils;
globalThis.IOUtils = {
  readJSON: async () => ({ threads: [{
    ...t1,
    unifiedContext: undefined,
    messages: [...t1.messages, { role: "user", content: "继续" }],
    contextProjection: {
      version: 1, summary: "旧版已验证状态", cutoff: 2, sourceCount: 2,
      createdAt: 1, updatedAt: 2,
    },
  }] }),
};
try {
  const oldStore = new ConversationStore({ memoryOnly: false, path: "projection-migration.json" });
  const migrated = await oldStore.getModelMessages(t1.id);
  ok(migrated.some(m => m.content.includes("旧版已验证状态")) &&
     migrated.at(-1).content === "继续", "旧版持久化投影迁移到统一累计状态");
} finally {
  if (savedLegacyIO === undefined) delete globalThis.IOUtils;
  else globalThis.IOUtils = savedLegacyIO;
}
ok(imported.workspace === null && imported.envId === null && imported.lastTurnStatus === "idle", "导入会话保持静止且不绑定本机资源");
ok(!("contextProjection" in imported) && imported.usage.requests === 0, "导入不携带运行期投影和 Usage");
let badImport = false;
try { await s.importThread('{"hello":true}'); } catch { badImport = true; }
ok(badImport, "拒绝非 Firefox Reverse 会话 JSON");

// 第二个线程 + 排序（updatedAt 倒序）
const t2 = await s.createThread();
await s.appendMessage(t2.id, { role: "user", content: "第二个对话" });
const list = await s.listThreads();
ok(list[0].id === t2.id, "最近更新的线程排在前");
ok(list.find(t => t.id === t1.id).count === 2, "摘要带消息计数");

await s.renameThread(t1.id, "RC4 入口分析");
ok((await s.getThread(t1.id)).title === "RC4 入口分析", "renameThread 生效");

await s.deleteThread(t2.id);
ok((await s.listThreads()).length === 4, "deleteThread 仅删除目标线程，导入和长会话仍保留");

console.log(`\nConversationStore 自测：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
