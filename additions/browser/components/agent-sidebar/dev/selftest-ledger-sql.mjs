// Real SQLite regression for migration, type safety, evidence and idempotence.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LedgerBackend } from "../modules/backends/LedgerBackend.sys.mjs";
const sqlite = new DatabaseSync(":memory:");
const calls = [];
const conn = {
  async execute(sql, params) {
    calls.push({ sql, params });
    const stmt = sqlite.prepare(sql);
    const rows = Array.isArray(params) ? stmt.all(...params) : params ? stmt.all(params) : stmt.all();
    return rows.map(value => ({ getResultByName: name => value[name] }));
  },
  async executeTransaction(fn) {
    sqlite.exec("BEGIN");
    try { const result = await fn(); sqlite.exec("COMMIT"); return result; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  },
  async close() { sqlite.close(); },
};
sqlite.exec("CREATE TABLE mem(id INTEGER PRIMARY KEY,site TEXT,workspace TEXT,kind TEXT,text TEXT,ev TEXT,ts TEXT,norm TEXT)");
sqlite.exec("INSERT INTO mem VALUES(1,'test','/ws','fact','old assertion','old experiment','yesterday','old')");
globalThis.ChromeUtils = { importESModule: () => ({ Sqlite: {
  shutdown: { addBlocker() {}, removeBlocker() {} }, openConnection: async () => conn,
} }) };
globalThis.PathUtils = { profileDir: "/profile", join: (...x) => x.join("/") };
globalThis.IOUtils = { async makeDirectory() {}, async writeUTF8() {} };
const ledger = new LedgerBackend();
ledger.currentSite = () => "test";
const ctx = { workspaceRoot: "/ws" };
await ledger._db();
let rows = (await ledger.recall({}, ctx)).results;
assert.equal(rows[0].kind, "observation");
assert.equal(rows[0].status, "unverified");
assert.equal(rows[0].evidence, "old experiment");
console.log("OK old memory migrated without fabricated verification");

await ledger.append({ text: "sign might use AES-CBC", kind: "hypothesis" }, ctx);
await assert.rejects(ledger.append({ text: "guess", kind: "unknown" }, ctx), /unknown/);
await assert.rejects(ledger.append({ text: "guess", kind: "fact" }, ctx), /verified/);
await assert.rejects(ledger.append({ text: "wrong", kind: "fact", status: "verified" }, ctx), /evidence/);
await assert.rejects(ledger.append({ text: "one failure", kind: "deadend", status: "verified", evidence: "experiment" }, ctx), /conditions/);
assert.match(await ledger.digest({}, ctx), /假设/);
assert.match(await ledger.digest({}, ctx), /unverified/);
console.log("OK hypothesis never coerces to fact; facts and failed paths require validation metadata");

const hypothesis = (await ledger.recall({ kind: "hypothesis" }, ctx)).results[0];
await ledger.append({ kind: "fact", status: "verified", text: "sign is AES-CBC",
  evidence: "experiment X confirms against browser", supersedes: [hypothesis.id] }, ctx);
rows = (await ledger.recall({}, ctx)).results;
assert.equal(rows.find(x => x.id === hypothesis.id).status, "superseded");
assert.ok(rows.some(x => x.kind === "fact" && x.status === "verified"));
await assert.rejects(ledger.append({ text: "decision", kind: "decision", status: "verified", evidence: "proof", supersedes: [hypothesis.id] },
  { workspaceRoot: "/different" }), /missing memory/);

const handoff = { schemaVersion: 1, summary: "state", nextAction: "verify",
  memories: [{ kind: "fact", status: "verified", text: "verified result", evidence: "",
    evidenceIds: [7], evidenceRefs: [], conditions: "", artifact: null, supersedes: [] }] };
const first = await ledger.mergeHandoff(handoff, ctx, { threadId: "thread-A", version: 1 });
assert.equal(first.added, 1);
assert.equal((await ledger.mergeHandoff(handoff, ctx, { threadId: "thread-A", version: 1 })).alreadyApplied, true);
await ledger.mergeHandoff(handoff, ctx, { threadId: "thread-B", version: 1 });
rows = (await ledger.recall({ query: "verified result" }, ctx)).results;
assert.equal(rows.length, 2);
assert.deepEqual(rows.map(x => x.evidenceRefs[0].threadId).sort(), ["thread-A", "thread-B"]);
await assert.rejects(ledger.mergeHandoff("## 已确认事实", ctx), /structured/);
console.log("OK structured handoff, thread-qualified evidence and idempotent batch receipts");

const execute = conn.execute;
conn.execute = async (sql, params) => {
  if (sql.startsWith("INSERT INTO memory_batches")) throw new Error("disk failure");
  return execute(sql, params);
};
await assert.rejects(ledger.mergeHandoff(handoff, ctx, { threadId: "thread-C", version: 1 }), /disk failure/);
assert.equal((await ledger.recall({ query: "verified result" }, ctx)).count, 2);
conn.execute = execute;
assert.equal((await ledger.mergeHandoff(handoff, ctx, { threadId: "thread-C", version: 1 })).added, 1);
console.log("OK failed batch rolls back entries and receipt; retry succeeds");

const payload = "/ws'); DROP TABLE memory_v2;--";
await ledger.append({ text: "safe", kind: "decision" }, { workspaceRoot: payload });
assert.ok(calls.every(x => !x.sql.includes(payload)));
assert.equal((await ledger.recall({}, { workspaceRoot: payload })).count, 1);
await ledger.close();
console.log("OK bound SQL and workspace isolation");
