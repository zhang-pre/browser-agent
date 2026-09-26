export const SUMMARY_PROMPT = `维护 Web 逆向任务的累计执行状态。输出结构化交接记录，保留目标的引用、已验证事实及证据 ID、待验证假设、相互矛盾的实验及各自环境、失败实验的适用条件、产物路径/版本、当前阶段和下一步。
你只能更新执行状态，不得修改任务卡中的有效目标。未知结论不得升级为已验证；矛盾实验标记待验证。精确签名/密文/请求体引用原始产物，不重新抄写。
本次输入按日志 ID 顺序排列。只输出一个 JSON 对象，不加 Markdown 围栏：
{"schemaVersion":1,"summary":"累计状态（含矛盾、环境差异、当前阶段）","facts":[],"hypotheses":[],"deadends":[],"decisions":[],"artifacts":[],"observations":[],"nextAction":"下一步"}
每个数组项必须有 text、status、evidenceIds（整数日志 ID 数组）。facts 仅可放有实验证据的 verified 结论；hypotheses 默认 unverified；deadends 必须 verified 且填写 conditions（失败实验的适用条件），单次失败不得概括为永不重试。artifact 项额外填写 artifact:{path,version或hash}。其他类型按实际状态填写。未知、矛盾或只有失败证据的结论留在 hypotheses/observations；严禁为了满足格式升级为 verified。summary 必须包含下一步。只引用输入中的证据 ID。`;

// Shared wire contract. Validation establishes structure/provenance, not truth.
export const MEMORY_KINDS = ["fact", "hypothesis", "deadend", "decision", "artifact", "observation"];
export const HANDOFF_FIELDS = { facts: "fact", hypotheses: "hypothesis", deadends: "deadend", decisions: "decision", artifacts: "artifact", observations: "observation" };
export function normalizeMemory(item) {
  if (!item || !MEMORY_KINDS.includes(item.kind)) throw new Error("unknown memory kind");
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (!text || text.length > 8000) throw new Error("memory text must contain 1..8000 characters");
  const status = item.status || "unverified";
  if (!["verified", "unverified", "rejected", "superseded"].includes(status)) throw new Error("invalid memory status");
  const evidence = typeof item.evidence === "string" ? item.evidence : "";
  const evidenceRefs = item.evidenceRefs || [];
  if (!Array.isArray(evidenceRefs) || evidenceRefs.some(e =>
    !e || typeof e.threadId !== "string" || !e.threadId ||
    !Number.isSafeInteger(e.eventId) || e.eventId < 1)) throw new Error("invalid memory evidence reference");
  if (status === "verified" && !evidence.trim() && !evidenceRefs.length) throw new Error("verified memory requires evidence");
  if (item.kind === "fact" && (status !== "verified" || (!evidence && !evidenceRefs.length))) {
    throw new Error("fact requires explicit verified status and evidence");
  }
  if (item.kind === "deadend" && (status !== "verified" || typeof item.conditions !== "string" || !item.conditions.trim() || (!evidence && !evidenceRefs.length))) {
    throw new Error("deadend requires verified evidence and applicable conditions");
  }
  const artifact = item.artifact || null;
  if (item.kind === "artifact" && (typeof artifact?.path !== "string" || !artifact.path || !(typeof artifact.hash === "string" && artifact.hash || typeof artifact.version === "string" && artifact.version))) {
    throw new Error("artifact requires path and hash/version");
  }
  const supersedes = item.supersedes || [];
  if (!Array.isArray(supersedes) || supersedes.some(id => typeof id !== "string" || !id)) throw new Error("invalid supersedes");
  if (supersedes.length && (status !== "verified" || (!evidence && !evidenceRefs.length))) throw new Error("superseding memory needs verified evidence");
  return { kind: item.kind, status, text, evidence, evidenceRefs: structuredClone(evidenceRefs),
    conditions: String(item.conditions || ""), artifact, supersedes };
}

export function parseHandoff(text, events, coveredThrough) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("handoff must be JSON"); }
  if (value?.schemaVersion !== 1 || typeof value.summary !== "string" || !value.summary.trim() ||
      typeof value.nextAction !== "string") throw new Error("invalid structured handoff");
  const memories = [];
  for (const [field, kind] of Object.entries(HANDOFF_FIELDS)) {
    if (!Array.isArray(value[field])) throw new Error("handoff missing " + field);
    for (const item of value[field]) {
      if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some(id =>
        !Number.isSafeInteger(id) || id < 1 || id > coveredThrough || events[id - 1]?.id !== id)) {
        throw new Error("handoff references unknown or uncovered evidence");
      }
      if (["fact", "deadend"].includes(kind) && !item.evidenceIds.length) throw new Error("verified memory needs evidence IDs");
      const memory = normalizeMemory({ ...item, kind, evidence: "",
        evidenceRefs: item.evidenceIds.map(eventId => ({ threadId: "pending", eventId })) });
      // A failed/aborted tool result cannot by itself establish a verified fact.
      if (kind === "fact" && item.evidenceIds.every(id => {
        const e = events[id - 1];
        if (e.role !== "tool") return false;
        try { const v = JSON.parse(e.content); return v.ok === false || v.data?.ok === false || v.data?.aborted === true; } catch { return false; }
      })) throw new Error("failed evidence cannot establish fact");
      memories.push({ ...memory, evidenceRefs: [], evidenceIds: [...new Set(item.evidenceIds)],
        evidenceArtifacts: item.evidenceIds.flatMap(eventId => events[eventId - 1].artifact
          ? [{ eventId, ...events[eventId - 1].artifact }] : []) });
    }
  }
  return { schemaVersion: 1, summary: value.summary.trim(), nextAction: value.nextAction.trim(), memories };
}
export function mergeHandoffs(previous, next) {
  const memories = [...(previous?.memories || []), ...next.memories];
  return { ...next, memories: [...new Map(memories.map(m => [JSON.stringify(m), m])).values()] };
}
export function qualifyHandoff(handoff, threadId) {
  return handoff.memories.map(m => normalizeMemory({ ...m,
    evidenceRefs: m.evidenceIds.map(eventId => ({ threadId, eventId,
      ...(m.evidenceArtifacts?.find(a => a.eventId === eventId) || {}) })) }));
}
