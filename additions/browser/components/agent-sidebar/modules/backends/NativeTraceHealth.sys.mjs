// Per-content-process baseline: a control-file write is not evidence of capture.
export class NativeTraceHealth {
  constructor() { this.sessions = new Map(); }
  async arm(pid, file) {
    if (!pid) throw new Error("原生观测需要可用的 Firefox 内容进程 PID");
    let offset = 0;
    try { if (file) offset = (await IOUtils.stat(file)).size || 0; } catch {}
    const old = this.sessions.get(pid);
    this.sessions.set(pid, { file, offset, misses: old?.misses || 0 });
  }
  stop(pid) { this.sessions.delete(pid); }
  async check(pid, file) {
    const session = this.sessions.get(pid);
    if (!pid || !session) return {
      state: "not_armed", captured: false, contentPid: pid,
      stopRecommended: false,
      note: "当前 PID 没有本次观测基线。先确认 Firefox 目标；换进程后需要重新开启观测。",
    };
    if (file && !file.endsWith("." + pid)) return {
      state: "target_mismatch", captured: false, contentPid: pid, traceFile: file,
      stopRecommended: true, note: "文件不属于当前 PID，不能作为 Firefox 目标的观测证据；停止并确认目标配置。",
    };
    let count = 0, size = 0, error = null;
    try {
      if (file) {
        size = (await IOUtils.stat(file)).size || 0;
        const baseline = session.file === file && size >= session.offset ? session.offset : 0;
        const offset = Math.max(baseline, size - 256 * 1024);
        const bytes = await IOUtils.read(file, { offset, maxBytes: 256 * 1024 });
        let text = new TextDecoder().decode(bytes);
        // A partial first/last line cannot establish a captured record.
        if (offset > baseline) text = text.slice(text.indexOf("\n") + 1);
        for (const line of text.split("\n").slice(0, -1)) {
          try {
            const value = JSON.parse(line);
            if (value && typeof value === "object" && !Array.isArray(value) && !value._meta && !value._warn) count++;
          } catch {}
        }
      }
    } catch (e) { error = String(e?.message || e); }
    if (count) session.misses = 0;
    else session.misses++;
    return {
      state: count ? "capturing" : error ? "read_error" : "no_new_records",
      captured: count > 0, sampledNewRecords: count, contentPid: pid, traceFile: file,
      consecutiveMisses: session.misses, stopRecommended: !count && session.misses >= 2,
      ...(error ? { error } : {}),
      note: count
        ? "本次开启后有新增记录；仍需查询确认记录对应目标脚本/调用，不能仅凭文件有数据判断目标证据齐全。"
        : session.misses >= 2
          ? "两次检查没有新增记录。停止该观测并恢复运行状态，记录限制后回到主路线；不要继续重复 start/query。"
          : "尚未证明内核采集有效。确认目标已执行，检查 PID、脚本/接口过滤和加载的内核；只做一次有依据的修正与触发后再检查。旧文件和配置写入均不算本次证据。",
    };
  }
}
