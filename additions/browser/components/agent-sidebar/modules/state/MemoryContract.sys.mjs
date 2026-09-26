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
        try { const v = JSON.parse(e.content); return v.ok === false || v.data?.aborted === true; } catch { return false; }
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
