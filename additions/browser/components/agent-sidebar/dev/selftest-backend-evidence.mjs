// node --test dev/selftest-backend-evidence.mjs
// Firefox APIs are mocked; the real backend implementations and tool registry run in Node.
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

globalThis.ChromeUtils = {
  importESModule(url) {
    if (url.endsWith("/Timer.sys.mjs")) return { setTimeout, clearTimeout };
    throw new Error("Unexpected Firefox module: " + url);
  },
};
globalThis.Ci = { nsIHttpChannel: {} };
globalThis.Services = { obs: { addObserver() {}, removeObserver() {} } };

// Optional isolated source tree for verifying these regressions against the previous revision.
const base = process.env.AGENT_SIDEBAR_UNDER_TEST
  ? pathToFileURL(process.env.AGENT_SIDEBAR_UNDER_TEST.replace(/\/$/, "") + "/")
  : new URL("../", import.meta.url);
const load = file => import(new URL("modules/" + file, base));
const { NetworkBackend } = await load("backends/NetworkBackend.sys.mjs");
const { ScriptsBackend } = await load("backends/ScriptsBackend.sys.mjs");
const { getBackends } = await load("backends/Backends.sys.mjs");
const { createBuiltinTools } = await load("tools/Tools.sys.mjs");
const { ToolRouter } = await load("tools/ToolRouter.sys.mjs");

function channel(id) {
  return {
    channelId: id,
    URI: { spec: "https://example.test/api?sign=" + id },
    requestMethod: "POST",
    responseStatus: 200,
    QueryInterface() { return this; },
    visitRequestHeaders(v) { v.visitHeader("X-Sign", "signature"); },
    visitResponseHeaders(v) { v.visitHeader("Content-Type", "application/json"); },
    getResponseHeader() { return "application/json"; },
  };
}

function pageWithScripts(urls, contexts) {
  return { async eval({ expression }, ctx) {
    contexts.push(ctx);
    const value = vm.runInNewContext(expression, {
      document: { scripts: urls.map(src => ({ src })) },
      performance: { getEntriesByType: () => [] },
    });
    // Match the actor's array cap; JSON string results preserve all URLs.
    return { value: Array.isArray(value) && value.length > 200
      ? [...value.slice(0, 200), "…(+more)"] : value };
  } };
}

test("body options fail explicitly without starting capture; metadata still works", async () => {
  const net = new NetworkBackend();
  const unsupported = await net.capture({ action: "start", captureBody: true });
  assert.equal(unsupported.ok, false);
  assert.match(unsupported.error, /body/);
  assert.equal((await net.capture()).capturing, false);
  net.observe(channel(1), "http-on-modify-request");
  assert.equal((await net.get({ id: 1, includeBody: true })).ok, false);
  assert.equal((await net.get({ id: 1 })).request.reqHeaders["X-Sign"], "signature");
});

test("clear invalidates queued stacks and response associations, keeps capture and monotonic IDs", async () => {
  let drains = 0;
  const net = new NetworkBackend({ page: {
    armNetStack: async () => ({ armed: true }),
    drainNetStack: async () => { drains++; return [{ channelId: "1", stack: ["old"] }]; },
  } });
  await net.capture({ action: "start" });
  const oldChannel = channel(1);
  net.observe(oldChannel, "http-on-modify-request");
  const oldRecord = net._buf[0];
  net.recordStack("pending", ["old"]);
  const result = await net.capture({ action: "clear" });
  assert.equal(result.capturing, true);
  assert.equal(result.stacksCleared, true);
  assert.equal(drains, 1);
  assert.equal(net._pendingStacks.size, 0);
  assert.equal(net._buf.length, 0);
  net.observe(oldChannel, "http-on-examine-response");
  assert.equal(oldRecord.status, null, "late response cannot mutate discarded evidence");
  net.observe(channel(2), "http-on-modify-request");
  assert.equal(net._buf[0].id, 2);
  assert.equal(net._buf[0].initiatorStack, null);
});

test("clear rejects a stale in-flight stack drain and reports unavailable child cleanup", async () => {
  let finishOldDrain;
  let calls = 0;
  const net = new NetworkBackend({ page: {
    drainNetStack() {
      if (++calls === 1) return new Promise(resolve => { finishOldDrain = resolve; });
      return Promise.reject(new Error("actor destroyed"));
    },
  } });
  const oldList = net.list();
  assert.equal((await net.capture({ action: "clear" })).stacksCleared, false);
  finishOldDrain([{ channelId: "old", stack: ["stale"] }]);
  await oldList;
  assert.equal(net._pendingStacks.size, 0);
});

test("network cursor reaches older requests without duplicates when new traffic arrives", async () => {
  const net = new NetworkBackend();
  for (let i = 1; i <= 5; i++) net.observe(channel(i), "http-on-modify-request");
  const first = await net.list({ limit: 2, method: "POST" });
  assert.deepEqual(first.requests.map(r => r.id), [4, 5]);
  assert.equal(first.total, 5);
  net.observe(channel(6), "http-on-modify-request");
  const second = await net.list({ limit: 2, beforeId: first.nextBeforeId });
  assert.deepEqual(second.requests.map(r => r.id), [2, 3]);
  const third = await net.list({ limit: 2, beforeId: second.nextBeforeId });
  assert.deepEqual(third.requests.map(r => r.id), [1]);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextBeforeId, null);
  await assert.rejects(net.list({ limit: 0 }), /limit/);
  await assert.rejects(net.capture({ action: "typo" }), /action/);
});

test("script listing filters and pages URLs, while short-name resolution uses the whole catalog and context", async () => {
  const ctx = { workspaceRoot: "/task-a", win: {} };
  const urls = Array.from({ length: 321 }, (_, i) => `https://example.test/bundle.${i}.js`);
  const contexts = [];
  const scripts = new ScriptsBackend({ page: pageWithScripts(urls, contexts) });
  const first = await scripts.list({}, ctx);
  assert.equal(first.count, 100);
  assert.equal(first.total, 321);
  const second = await scripts.list({ offset: first.nextOffset, limit: 1000 }, ctx);
  assert.deepEqual(second.urls, urls.slice(100));
  assert.equal(second.nextOffset, null);
  assert.deepEqual((await scripts.list({ urlPattern: "*/bundle.32?.js" }, ctx)).urls, [urls[320]]);
  assert.equal(await scripts._resolveUrl("bundle.320.js", ctx), urls[320]);
  assert.ok(contexts.every(c => c === ctx));
  scripts.page.eval = async () => ({ value: "[]", totalLength: 100, returnedLength: 2 });
  await assert.rejects(scripts.list({}, ctx), /截断/);
});

test("batch capture separates returned failures and exceptions and preserves all outcomes", async () => {
  const ctx = { workspaceRoot: "/task-b", win: {} };
  const urls = Array.from({ length: 325 }, (_, i) => `https://example.test/${i}.js`);
  const contexts = [];
  const scripts = new ScriptsBackend({ page: pageWithScripts(urls, contexts) });
  scripts.save = async ({ url }, gotCtx) => {
    contexts.push(gotCtx);
    if (url === urls[0]) return { ok: false, error: "HTTP 404", httpStatus: 404 };
    if (url === urls[1]) throw new Error("timeout");
    return { ok: true, path: url, bytes: 12 };
  };
  const result = await scripts.captureAll({}, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.partial, true);
  assert.equal(result.savedCount, 323);
  assert.equal(result.saved.length, 323);
  assert.equal(result.failedCount, 2);
  assert.equal(result.saved.length + result.failed.length, result.total);
  assert.ok(result.failed.some(r => r.httpStatus === 404));
  assert.ok(result.failed.some(r => r.error === "timeout"));
  assert.ok(contexts.every(c => c === ctx));
  scripts.save = async () => ({ ok: false, error: "denied" });
  const failed = await scripts.captureAll({}, ctx);
  assert.equal(failed.ok, false);
  assert.equal(failed.partial, false);
  assert.equal(failed.failed.length, 325);
});

test("find_param_entry awaits network results and forwards the session to both backends", async () => {
  const backends = getBackends();
  const ctx = { workspaceRoot: "/task-c", win: {} };
  const oldList = backends.net.list;
  const oldSearch = backends.code.search;
  const contexts = [];
  try {
    backends.net.list = async (_args, gotCtx) => {
      contexts.push(gotCtx);
      await Promise.resolve();
      return { requests: [{ id: 42, method: "POST", status: 200, url: "https://example.test/?sign=abc" }] };
    };
    backends.code.search = async (_args, gotCtx) => {
      contexts.push(gotCtx);
      return { hits: [{ file: "work/signer.js", line: 1 }] };
    };
    const result = await backends.find.paramEntry({ param: "sign" }, ctx);
    assert.equal(result.netError, undefined);
    assert.equal(result.codeError, undefined);
    assert.equal(result.requests[0].id, 42);
    assert.equal(result.codeHits[0].file, "work/signer.js");
    assert.ok(contexts.every(c => c === ctx));
  } finally {
    backends.net.list = oldList;
    backends.code.search = oldSearch;
  }
});

test("tool schemas expose cleanup and pagination, and raw dispatch preserves large evidence", async () => {
  const specs = createBuiltinTools({ net: new NetworkBackend(), scripts: new ScriptsBackend() });
  const spec = name => specs.find(s => s.name === name);
  assert.ok(spec("net_capture").parameters.properties.action.enum.includes("clear"));
  assert.ok(spec("net_list").parameters.properties.beforeId);
  assert.ok(spec("scripts_list").parameters.properties.offset);
  const router = new ToolRouter();
  const data = { requests: [{ headers: "x".repeat(25000), tail: "must survive" }] };
  router.register({ name: "evidence", handler: async () => data });
  const result = await router.dispatch("evidence", {});
  assert.deepEqual(result.data, data);
  assert.equal(result.meta.oversized, true);
});
