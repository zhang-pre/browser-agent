import assert from "node:assert/strict";
import { NativeTraceHealth } from "../modules/backends/NativeTraceHealth.sys.mjs";
const files = new Map();
globalThis.IOUtils = {
  stat: async f => ({ size: Buffer.byteLength(files.get(f) || "") }),
  read: async (f, {offset, maxBytes}) => Buffer.from(files.get(f) || "").subarray(offset, offset + maxBytes),
};
const h = new NativeTraceHealth();
files.set("trace.1", '{"op":"old"}\n');
await h.arm(1, "trace.1");
assert.equal((await h.check(1, "trace.1")).captured, false, "old records are not a healthy capture");
await h.arm(1, "trace.1");
assert.equal((await h.check(1, "trace.1")).stopRecommended, true, "restarting cannot erase failed checks");
assert.equal((await h.check(2, null)).state, "not_armed", "process switch requires a fresh baseline");
files.set("trace.1", files.get("trace.1") + '{"_meta":true}\n');
assert.equal((await h.check(1, "trace.1")).captured, false);
files.set("trace.1", files.get("trace.1") + '{"op":"new"}\n');
assert.equal((await h.check(1, "trace.1")).captured, true);
h.stop(1);
assert.equal((await h.check(1, "trace.1")).state, "not_armed");
await assert.rejects(h.arm(null, null), /PID/);
await h.arm(3, null);
files.set("trace.3", '{"op":"first"}\n');
assert.equal((await h.check(3, "trace.3")).captured, true);
await h.arm(3, "trace.3");
files.set("trace.3", '{"op":"rotated"}\n');
assert.equal((await h.check(3, "trace.3")).captured, false, "same-size overwrite cannot prove append capture");
console.log("native health passed");

// Missing target traces must not fall back to a parent/other tab's file.
const { JsvmpBackend } = await import("../modules/backends/JsvmpBackend.sys.mjs");
const { WebApiBackend } = await import("../modules/backends/WebApiBackend.sys.mjs");
globalThis.Services = { env: { get: () => "" }, appinfo: { OS: "Linux" } };
globalThis.PathUtils = { filename: f => f.split("/").at(-1) };
const ctx = { win: { gBrowser: { selectedBrowser: { browsingContext: { currentWindowGlobal: { osPid: 9 } } } } } };
IOUtils.getChildren = async () => ["/tmp/browser-agent-jsvmp-b.ndjson.8", "/tmp/browser-agent-webapi.ndjson.8"];
assert.equal(await new JsvmpBackend()._findTrace(ctx), null);
assert.equal(await new WebApiBackend()._findTrace(ctx), null);
IOUtils.getChildren = async () => ["/tmp/browser-agent-jsvmp-b.ndjson.9", "/tmp/browser-agent-webapi.ndjson.9"];
assert.equal(await new JsvmpBackend()._findTrace(ctx), "/tmp/browser-agent-jsvmp-b.ndjson.9");
assert.equal(await new WebApiBackend()._findTrace(ctx), "/tmp/browser-agent-webapi.ndjson.9");
console.log("native PID isolation passed");
