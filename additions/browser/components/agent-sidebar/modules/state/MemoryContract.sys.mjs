export const SUMMARY_PROMPT = `维护 Web 逆向任务的累计执行状态。输出结构化交接记录，保留目标的引用、已验证事实及证据 ID、待验证假设、相互矛盾的实验及各自环境、失败实验的适用条件、产物路径/版本、当前阶段和下一步。
你只能更新执行状态，不得修改任务卡中的有效目标。未知结论不得升级为已验证；矛盾实验标记待验证。精确签名/密文/请求体引用原始产物，不重新抄写。
失败条件必须写明浏览器/执行环境、输入、参数、观测结果及尚未覆盖的范围；候选密钥不匹配不能排除 AES，某套桩失败不能排除 jsdom。配置成功或零记录不能证明目标行为不存在。新证据推翻旧条目时，用完全相同的 text、conditions 和对应数组输出 status=superseded（或 rejected），附更正证据 ID，并另写新结论；summary 必须明确旧结论已失效，不得继续当作前提。累计条目允许退役状态，失效条目只用于避免重犯。
本次输入按日志 ID 顺序排列。只输出一个 JSON 对象，不加 Markdown 围栏：
{"schemaVersion":1,"summary":"累计状态（含矛盾、环境差异、当前阶段）","facts":[],"hypotheses":[],"deadends":[],"decisions":[],"artifacts":[],"observations":[],"nextAction":"下一步"}
每个数组项必须有 text、status、evidenceIds（整数日志 ID 数组）。status 只能是 verified、unverified、rejected、superseded 四者之一（所有数组均适用）；待验证或不确定使用 unverified，不使用 pending、unknown、confirmed 等其他值。所有数组中 status=verified 的条目都必须有非空 evidenceIds，包括 hypotheses、decisions、artifacts、observations；文字 evidence 或产物路径不能替代日志 ID。没有证据的计划、决策和观察使用 unverified；无法支持的 facts/deadends 应移入 hypotheses/observations 并标记 unverified，不得编造 ID。facts 的有效结论须为 verified；已推翻的旧条目可为 rejected/superseded；hypotheses 默认 unverified；deadends 的有效条目必须 verified 且填写 conditions（失败实验的适用条件），单次失败不得概括为永不重试。artifact 项额外填写 artifact:{path,version或hash}。其他类型按实际状态填写。未知、矛盾或只有失败证据的结论留在 hypotheses/observations；严禁为了满足格式升级为 verified。summary 必须包含下一步。只引用输入中的证据 ID。`;

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
  const retired = ["rejected", "superseded"].includes(status);
  if (item.kind === "fact" && ((!retired && status !== "verified") || (!evidence && !evidenceRefs.length))) {
    throw new Error("fact requires explicit verified status and evidence");
  }
  if (item.kind === "deadend" && ((!retired && status !== "verified") || typeof item.conditions !== "string" || !item.conditions.trim() || (!evidence && !evidenceRefs.length))) {
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
    for (const [index, item] of value[field].entries()) {
      try {
        if (!item || typeof item !== "object") throw new Error("memory item must be an object");
        if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some(id =>
          !Number.isSafeInteger(id) || id < 1 || id > coveredThrough || events[id - 1]?.id !== id)) {
          throw new Error("handoff references unknown or uncovered evidence");
        }
        if (["fact", "deadend"].includes(kind) && !item.evidenceIds.length) throw new Error("verified memory needs evidence IDs");
        if (item.status === "verified" && !item.evidenceIds.length) {
          throw new Error("verified memory requires evidence: evidenceIds must contain source log IDs; use unverified when no supporting evidence exists, never invent IDs");
        }
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
      } catch (error) {
        throw new Error(`${field}[${index}]: ${error.message}`);
      }
    }
  }
  return { schemaVersion: 1, summary: value.summary.trim(), nextAction: value.nextAction.trim(), memories };
}
export function mergeHandoffs(previous, next) {
  // Latest status wins for the same claim, including explicit retractions.
  const memories = [...(previous?.memories || []), ...next.memories];
  return { ...next, memories: [...new Map(memories.map(m => [m.kind + "\n" + m.text + "\n" + (m.conditions || ""), m])).values()] };
}
export function qualifyHandoff(handoff, threadId) {
  return handoff.memories.map(m => normalizeMemory({ ...m,
    evidenceRefs: m.evidenceIds.map(eventId => ({ threadId, eventId,
      ...(m.evidenceArtifacts?.find(a => a.eventId === eventId) || {}) })) }));
}
