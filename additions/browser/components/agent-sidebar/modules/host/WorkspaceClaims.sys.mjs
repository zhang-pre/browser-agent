const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");

export function canonicalWorkspace(path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  file.normalize();
  if (!file.exists() || !file.isDirectory()) throw new Error("工作目录必须已经存在：" + path);
  const result = file.path.replace(/[\\/]+$/, "");
  if (!result || /^[A-Za-z]:$/.test(result)) throw new Error("不能把文件系统根目录作为任务工作目录");
  return Services.appinfo.OS === "WINNT" ? result.toLowerCase() : result;
}
export function overlaps(a, b) {
  const sep = Services.appinfo.OS === "WINNT" ? "\\" : "/";
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** SQLite's writer transaction makes check + claim atomic across Firefox processes. */
export class WorkspaceClaims {
  constructor({ path, pid = Services.appinfo.processID, pidState } = {}) {
    this.path = path || PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".firefox-reverse", "worker-claims.sqlite");
    this.pid = pid;
    this.pidState = pidState;
    this.token = Services.uuid.generateUUID().toString();
    this.root = null;
    this.connection = null;
  }
  async db() {
    if (!this.connection) this.connection = (async () => {
      await IOUtils.makeDirectory(PathUtils.parent(this.path), { ignoreExisting: true });
      for (let attempt = 0; ; attempt++) {
        let db;
        try {
          db = await Sqlite.openConnection({ path: this.path, openNotExclusive: true });
          await db.execute("PRAGMA busy_timeout = 5000");
          await db.execute("CREATE TABLE IF NOT EXISTS claims (token TEXT PRIMARY KEY, pid INTEGER NOT NULL, workspace TEXT NOT NULL, thread TEXT NOT NULL)");
          Sqlite.shutdown.addBlocker("Agent workspace claims", () => db.close());
          return db;
        } catch (error) {
          if (db) await db.close();
          if (attempt >= 39 || !/NS_ERROR_STORAGE_BUSY|2153971713|database is locked/.test(String(error))) throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    })().catch(error => { this.connection = null; throw error; });
    return this.connection;
  }
  async claim(path, threadId) {
    const root = canonicalWorkspace(path);
    if (this.root) {
      if (root !== this.root) throw new Error("环境进程已绑定工作目录，请重启后更换");
      return root;
    }
    const db = await this.db();
    await db.executeTransaction(async () => {
      const rows = await db.execute("SELECT token, pid, workspace FROM claims");
      for (const row of rows) {
        const token = row.getResultByName("token");
        if (token === this.token) continue;
        const pid = row.getResultByName("pid");
        // Unknown liveness and reused PIDs remain occupied: never steal a live task.
        if (await this.pidState(pid) === "dead") {
          await db.execute("DELETE FROM claims WHERE token = :token", { token });
        } else if (overlaps(root, row.getResultByName("workspace"))) {
          throw new Error("工作目录与另一个 Firefox 任务重叠（PID " + pid + "）：" + row.getResultByName("workspace"));
        }
      }
      await db.execute("INSERT INTO claims (token, pid, workspace, thread) VALUES (:token, :pid, :workspace, :thread)",
        { token: this.token, pid: this.pid, workspace: root, thread: threadId });
    }, db.TRANSACTION_IMMEDIATE);
    this.root = root;
    return root;
  }
}
