import { MEMORY_KINDS, normalizeMemory, qualifyHandoff } from "../state/MemoryContract.sys.mjs";
// Typed workspace memory in SQLite; ledger.md is a readable mirror.
// Discovery writes use remember; compaction writes use structured, versioned batches.
// Legacy mem rows are migrated as unverified records, retaining original evidence.
const DIR = "firefox-reverse-agent";
const DB = "memory.sqlite";
const MD = "ledger.md";

function agentWin(ctx) {
  try { const w = ctx && ctx.win; if (w && w.gBrowser && !w.closed) return w; } catch {}
  return Services.wm.getMostRecentWindow("navigator:browser");
}

export class LedgerBackend {
  /** @param {object} [opts] { workspace: WorkspaceBackend(getRoot) } */
  constructor({ workspace } = {}) {
    this._workspace = workspace || null;
    this._conn = null;
    this._opening = null;
    this._closing = null;
    this._shutdownClient = null;
    this._shutdownBlocker = null;
  }

  _unregisterShutdown() {
    if (this._shutdownBlocker) {
      this._shutdownClient.removeBlocker(this._shutdownBlocker);
      this._shutdownBlocker = null;
      this._shutdownClient = null;
    }
  }

  /** Firefox 退出时先等懒开库完成，再关闭连接；重复调用只执行一次。 */
  close() {
    if (this._closing) {
      return this._closing;
    }
    this._closing = (async () => {
      try {
        if (this._opening) {
          try {
            await this._opening;
          } catch {
            // 打开失败时 _db() 已负责关闭可能创建的连接。
          }
        }
        const conn = this._conn;
        this._conn = null;
        if (conn) {
          await conn.close();
        }
      } finally {
        this._unregisterShutdown();
      }
    })();
    return this._closing;
  }

  /** 懒开全局 SQLite 连接（单例，跨会话/多窗口共享同一记忆库；写经同一连接串行、并发安全）。 */
  async _db() {
    if (this._closing) {
      throw new Error("LedgerBackend is shutting down");
    }
    if (this._opening) {
      return this._opening;
    }
    if (this._conn) {
      return this._conn;
    }
    const opening = (async () => {
      const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
      const blocker = () => this.close();
      Sqlite.shutdown.addBlocker("Agent sidebar: close memory.sqlite", blocker);
      this._shutdownClient = Sqlite.shutdown;
      this._shutdownBlocker = blocker;
      let conn = null;
      try {
        const dir = PathUtils.join(PathUtils.profileDir, DIR);
        await IOUtils.makeDirectory(dir, { ignoreExisting: true, createAncestors: true });
        const path = PathUtils.join(dir, DB);
        conn = await Sqlite.openConnection({ path });
        await conn.execute(
          "CREATE TABLE IF NOT EXISTS mem(" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, site TEXT, workspace TEXT, kind TEXT, text TEXT, ev TEXT, ts TEXT, norm TEXT)"
        );
        await conn.execute("CREATE INDEX IF NOT EXISTS i_site ON mem(site)");
        await conn.execute("CREATE INDEX IF NOT EXISTS i_ws ON mem(workspace)");
        await conn.execute("CREATE INDEX IF NOT EXISTS i_norm ON mem(norm)");
        await conn.execute("CREATE TABLE IF NOT EXISTS memory_v2(id INTEGER PRIMARY KEY AUTOINCREMENT, memory_key TEXT UNIQUE, site TEXT, workspace TEXT, kind TEXT, status TEXT, text TEXT, ev TEXT, ts TEXT, norm TEXT, payload TEXT)");
        await conn.execute("CREATE INDEX IF NOT EXISTS memory_v2_ws ON memory_v2(workspace)");
        await conn.execute("CREATE TABLE IF NOT EXISTS memory_batches(batch_key TEXT PRIMARY KEY)");
        // Old entries carry no verification contract. Keep their text/evidence,
        // but do not silently promote them to verified facts under the new schema.
        await conn.execute("INSERT OR IGNORE INTO memory_v2(memory_key,site,workspace,kind,status,text,ev,ts,norm,payload) SELECT 'legacy:'||id,site,workspace,CASE WHEN kind='deadend' THEN 'deadend' ELSE 'observation' END,'unverified',text,ev,ts,norm,'{}' FROM mem");
        if (this._closing) {
          throw new Error("LedgerBackend is shutting down");
        }
        this._conn = conn;
        return conn;
      } catch (error) {
        try {
          if (conn) {
            await conn.close();
          }
        } finally {
          this._unregisterShutdown();
        }
        throw error;
      }
    })();
    this._opening = opening;
    try {
      return await opening;
    } finally {
      this._opening = null;
    }
  }

  /** 当前标签页主域（站点 key），取不到返回 ""。 */
  currentSite(ctx) {
    try {
      const win = agentWin(ctx);
      const uri = win && win.gBrowser && win.gBrowser.selectedBrowser && win.gBrowser.selectedBrowser.currentURI;
      const host = uri && uri.host;
      if (!host) {
        return "";
      }
      const parts = host.split(".").filter(Boolean);
      return parts.length > 2 ? parts.slice(-2).join(".") : host;
    } catch {
      return "";
    }
  }

  async _contextRows(ctx, allWorkspaces = false) {
    const ws = ctx?.workspaceRoot || "";
    if (!ws && !allWorkspaces) return [];
    const db = await this._db();
    const rows = await db.execute("SELECT memory_key,kind,status,text,ev,payload,site,ts,workspace FROM memory_v2" + (allWorkspaces ? "" : " WHERE workspace=:ws") + " ORDER BY id DESC", allWorkspaces ? {} : { ws });
    const all = rows.map(r => this._row(r));
    const superseded = new Set(all.flatMap(x => x.supersedes || []));
    return all.map(x => superseded.has(x.id) ? { ...x, status: "superseded" } : x);
  }

  _row(r) {
    let payload = {};
    try { payload = JSON.parse(r.getResultByName("payload") || "{}"); } catch {}
    return { ...payload, id: r.getResultByName("memory_key"), kind: r.getResultByName("kind"),
      workspace: r.getResultByName("workspace"), site: r.getResultByName("site"), timestamp: r.getResultByName("ts"),
      status: r.getResultByName("status"), text: r.getResultByName("text"), evidence: r.getResultByName("ev") };
  }

  _format(rows) {
    const labels = { fact: "事实", hypothesis: "假设", deadend: "失败路径", decision: "决策", artifact: "产物", observation: "观察" };
    return MEMORY_KINDS.map(kind => {
      const items = rows.filter(x => x.kind === kind);
      if (!items.length) return "";
      return "## " + labels[kind] + "\n" + items.map(x =>
        "- [" + x.status + "] " + x.text +
        (x.conditions ? "；适用条件：" + x.conditions : "") +
        (x.evidence ? "；证据：" + x.evidence : "") +
        (x.evidenceRefs?.length ? "；日志：" + x.evidenceRefs.map(e => e.threadId + "#" + e.eventId).join(", ") : "") +
        (x.artifact ? "；产物：" + JSON.stringify(x.artifact) : "") +
        "；记忆 ID：" + x.id
      ).join("\n");
    }).filter(Boolean).join("\n\n");
  }

  async _renderMd(ctx) {
    if (!ctx?.workspaceRoot) return;
    const body = "# 任务记忆（SQLite）\n\n" + this._format(await this._contextRows(ctx)) + "\n";
    await IOUtils.writeUTF8(PathUtils.join(ctx.workspaceRoot, MD), body);
  }

  async _addMany(items, ctx, db = null, batchKey = "") {
    const normalized = items.map(normalizeMemory); // Validate the whole batch before writes.
    db ||= await this._db();
    const ws = ctx?.workspaceRoot || "";
    const site = this.currentSite(ctx);
    let added = 0, dedup = 0;
    for (let i = 0; i < normalized.length; i++) {
      const item = normalized[i];
      for (const id of item.supersedes) {
        const found = await db.execute("SELECT memory_key FROM memory_v2 WHERE memory_key=:id AND workspace=:ws", { id, ws });
        if (!found.length) throw new Error("supersedes references missing memory in this workspace");
      }
      // Include evidence, status, conditions and artifact version in identity.
      // Never delete a hypothesis or a conflicting experiment by substring match.
      const norm = JSON.stringify(item);
      const existing = await db.execute("SELECT memory_key FROM memory_v2 WHERE workspace=:ws AND site=:site AND norm=:norm", { ws, site, norm });
      if (existing.length) { dedup++; continue; }
      const key = batchKey ? batchKey + ":" + i : globalThis.crypto.randomUUID();
      await db.execute("INSERT INTO memory_v2(memory_key,site,workspace,kind,status,text,ev,ts,norm,payload) VALUES(:key,:site,:ws,:kind,:status,:text,:ev,:ts,:norm,:payload)", {
        key, site, ws, kind: item.kind, status: item.status, text: item.text, ev: item.evidence,
        ts: new Date().toISOString(), norm, payload: norm,
      });
      added++;
    }
    return { added, dedup };
  }

  async append({ text, kind = "hypothesis", status = "unverified", evidence = "", ev, evidenceRefs = [], conditions, artifact, supersedes } = {}, ctx) {
    if (!ctx?.workspaceRoot) throw new Error("remember requires a bound workspace");
    const item = normalizeMemory({ text, kind, status, evidence: evidence || ev, evidenceRefs, conditions, artifact, supersedes });
    const db = await this._db();
    const result = await db.executeTransaction(() => this._addMany([item], ctx, db));
    await this._renderMd(ctx);
    return { ok: true, ...result, kind: item.kind, status: item.status,
      note: "已保存；verified 为显式验证声明，证据仍需核查。假设与失败条件不会自动升级为事实或永久禁令。" };
  }

  async digest({ maxChars = 6000 } = {}, ctx) {
    let rows;
    try { rows = await this._contextRows(ctx); } catch { return ""; }
    if (!rows.length) return "";
    const header = "【本任务记忆】按类型和状态阅读：unverified 不是事实；superseded 仅供追溯。失败路径只在所列条件下适用；环境变化或证据冲突时重新验证。用户有效目标以任务卡为准。\n";
    const body = header + this._format(rows);
    return body.slice(0, maxChars) +
      (body.length > maxChars ? "\n…全文见 ledger.md 或 recall。" : "");
  }

  async hasVerified(ctx) {
    return (await this._contextRows(ctx)).some(x => x.status === "verified" &&
      (x.evidence?.trim() || x.evidenceRefs?.length));
  }

  async recall({ query, kind, status, scope = "current", workspace, limit = 20 } = {}, ctx) {
    if (kind && !MEMORY_KINDS.includes(kind)) throw new Error("unknown memory kind");
    if (!["current", "workspace", "all"].includes(scope)) throw new Error("invalid recall scope");
    if (scope === "workspace" && !workspace?.trim()) throw new Error("explicit workspace required");
    if (scope === "current" && workspace) throw new Error("set scope=workspace for cross-workspace recall");
    if (status && !["verified", "unverified", "rejected", "superseded"].includes(status)) throw new Error("invalid status");
    const rows = await this._contextRows(scope === "workspace" ? { ...ctx, workspaceRoot: workspace } : ctx, scope === "all");
    const results = rows.filter(x => (!kind || x.kind === kind) && (!status || x.status === status) &&
      (!query || (x.text + " " + x.evidence).toLowerCase().includes(String(query).toLowerCase())))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
    return { ok: true, count: results.length, results };
  }

  // Structured input only. Batch receipt and all entries commit together.
  async mergeHandoff(handoff, ctx, { threadId, version, source = "compaction" } = {}) {
    if (!handoff || handoff.schemaVersion !== 1 || !Array.isArray(handoff.memories) ||
        !threadId || !Number.isSafeInteger(version) || version < 1) throw new Error("invalid structured memory handoff");
    if (!ctx?.workspaceRoot) throw new Error("memory sync requires workspace");
    const items = qualifyHandoff(handoff, threadId);
    if (!["compaction", "completion"].includes(source)) throw new Error("invalid memory batch source");
    const batchKey = threadId + ":" + (source === "completion" ? "completion:" : "") + version;
    const db = await this._db();
    const result = await db.executeTransaction(async () => {
      const seen = await db.execute("SELECT batch_key FROM memory_batches WHERE batch_key=:key", { key: batchKey });
      if (seen.length) return { ok: true, added: 0, alreadyApplied: true };
      const result = await this._addMany(items, ctx, db, batchKey);
      await db.execute("INSERT INTO memory_batches(batch_key) VALUES(:key)", { key: batchKey });
      return { ok: true, ...result };
    });
    await this._renderMd(ctx);
    return result;
  }
}
