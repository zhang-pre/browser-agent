import assert from "node:assert/strict";
globalThis.ChromeUtils = { importESModule: () => ({ setTimeout, clearTimeout }) };
const { PageBackend } = await import("../modules/backends/PageBackend.sys.mjs");
const browser = {
  browsingContext: { id: 7, currentWindowGlobal: { innerWindowId: 11, osPid: 123 } },
  currentURI: { spec: "https://example.test/" }, contentTitle: "Target",
  webProgress: { isLoadingDocument: false },
  reload() { this.webProgress.isLoadingDocument = true; },
};
const ctx = { win: { gBrowser: { selectedBrowser: browser } } };
const page = new PageBackend();
let evaluated = 0, navigated = 0;
page.eval = async args => { evaluated++; return { ok: true, value: args.expression }; };
page.navigate = async ({ url }) => { navigated++; browser.currentURI.spec = url; };
assert.deepEqual(await page.deepTarget({}, ctx), {
  ok: true, browser: "Firefox", targetId: "7", documentId: "11", pid: 123,
  url: "https://example.test/", title: "Target", ready: true,
});
await assert.rejects(page.deepRun({ action: "evaluate", targetId: "8", documentId: "11", expression: "run()" }, ctx), /目标/);
await assert.rejects(page.deepRun({ action: "evaluate", targetId: "7", documentId: "10", expression: "run()" }, ctx), /文档/);
assert.equal(evaluated, 0);
const result = await page.deepRun({ action: "evaluate", targetId: "7", documentId: "11", expression: "run()" }, ctx);
assert.equal(result.value, "run()");
assert.equal(result.target.pid, 123);
assert.equal(result.targetChanged, false);
await assert.rejects(page.deepRun({ action: "navigate", targetId: "7", url: "javascript:run()" }, ctx), /http/);
assert.equal(navigated, 0);
const nav = await page.deepRun({ action: "navigate", targetId: "7", url: "https://example.test/next" }, ctx);
assert.equal(nav.dispatched, true);
assert.equal(nav.ready, false);
assert.equal(navigated, 1);
const reload = await page.deepRun({ action: "reload", targetId: "7", documentId: "11" }, ctx);
assert.equal(reload.ready, false);
assert.equal((await page.deepTarget({}, ctx)).ready, false);
await assert.rejects(page.deepRun({ action: "evaluate", targetId: "7", documentId: "11", expression: "run()" }, ctx), /文档/);
browser.webProgress.isLoadingDocument = false;
browser.browsingContext.currentWindowGlobal = { innerWindowId: 12, osPid: 456 };
assert.equal((await page.deepTarget({}, ctx)).pid, 456);
await assert.rejects(page.deepRun({ action: "reload", targetId: "7", documentId: "11" }, ctx), /文档/);
page.eval = async () => {
  browser.browsingContext.currentWindowGlobal = { innerWindowId: 13, osPid: 789 };
  return { ok: true, value: "navigated" };
};
const changed = await page.deepRun({ action: "evaluate", targetId: "7", documentId: "12", expression: "run()" }, ctx);
assert.equal(changed.targetChanged, true);
assert.equal(changed.target.pid, 456);
assert.equal(changed.currentTarget.pid, 789);
console.log("deep runtime selftest passed");
