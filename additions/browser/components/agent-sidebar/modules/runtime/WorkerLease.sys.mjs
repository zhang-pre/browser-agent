/** One environment process owns one conversation until process exit. */
export class WorkerLease {
  constructor({ claim, bind = () => ({}) }) {
    this.claim = claim;
    this.bind = bind;
    this.owner = null;
    this.busy = null;
    this.reason = null;
  }
  snapshot() {
    return { threadId: this.owner?.threadId || null, workspaceRoot: this.owner?.workspaceRoot || null,
      phase: this.busy?.phase || "idle", restartRequired: !!this.reason, reason: this.reason };
  }
  assertSafe() {
    if (this.reason) throw new Error("环境必须重启：" + this.reason);
  }
  async prepare(threadId, { workspaceRoot, hostContext } = {}) {
    this.assertSafe();
    if (this.busy) throw new Error("此环境正在执行或准备任务；不支持排队，请使用另一个独立 Firefox 环境");
    if (this.owner && this.owner.threadId !== threadId) throw new Error("此环境进程已绑定另一个会话；请重启或使用另一个独立环境");
    if (!threadId || !workspaceRoot) throw new Error("任务必须绑定会话和独立工作目录");
    const reservation = { token: globalThis.crypto.randomUUID(), phase: "preparing", threadId };
    this.busy = reservation;
    try {
      const root = await this.claim(workspaceRoot, threadId);
      this.assertSafe();
      if (this.owner && this.owner.workspaceRoot !== root) throw new Error("进程生命周期内不可更换工作目录，请重启环境");
      if (!this.owner) this.owner = { threadId, workspaceRoot: root, ...this.bind(hostContext) };
      return reservation.token;
    } catch (error) {
      if (this.busy === reservation) this.busy = null;
      throw error;
    }
  }
  assertPreparation(token) {
    this.assertSafe();
    if (!token || this.busy?.token !== token || this.busy.phase !== "preparing") throw new Error("无效或已结束的任务准备凭证");
  }
  async begin(threadId, options = {}) {
    const token = options.preparationToken || await this.prepare(threadId, options);
    this.assertPreparation(token);
    if (this.owner.threadId !== threadId || this.owner.workspaceRoot !== await this.claim(options.workspaceRoot, threadId)) throw new Error("准备凭证与任务目录不匹配");
    this.assertPreparation(token);
    this.busy.phase = "running";
    return token;
  }
  cancelPreparation(token) {
    if (this.busy?.phase === "preparing") this.finish(token);
  }
  finish(token) {
    if (this.busy?.token === token) this.busy = null;
  }
  poison(reason) { this.reason ||= reason; }
  raw(name) {
    this.assertSafe();
    if (this.busy) throw new Error("环境被任务占用，不能直调工具");
    if (!name.startsWith("env_") && name !== "page_automation_scan") throw new Error("MVP 仅允许环境管理工具直调；页面和文件操作必须通过绑定的任务执行");
    const token = globalThis.crypto.randomUUID();
    this.busy = { token, phase: "management" };
    return token;
  }
}
