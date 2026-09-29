// Read-only migration for conversations saved before the unified event log.
import { createUnifiedContext, normalizeUnifiedContext } from "./UnifiedContext.sys.mjs";

function normalizeLegacyProjection(raw, messageCount = Infinity) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cutoff = Math.floor(Number(raw.cutoff));
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (
    raw.version !== 1 ||
    !summary ||
    !Number.isFinite(cutoff) ||
    cutoff < 1 ||
    cutoff >= messageCount
  ) {
    return null;
  }
  return {
    version: 1,
    summary,
    cutoff,
    sourceCount: Number.isFinite(raw.sourceCount)
      ? Math.max(cutoff, Math.floor(raw.sourceCount))
      : cutoff,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    strategy: "projected",
  };
}

export function migrateConversationContext(thread, messages) {
  if (thread.unifiedContext) {
    try { return normalizeUnifiedContext(thread.unifiedContext, messages); }
    catch { return createUnifiedContext(messages); }
  }
  const state = createUnifiedContext(messages);
  const projection = normalizeLegacyProjection(thread.contextProjection, messages.length);
  // Old projection cutoffs are UI-message indexes, not event IDs. Only migrate
  // a valid user boundary, and derive coverage from accepted event roles.
  if (projection && messages[projection.cutoff]?.role === "user") {
    const covered = createUnifiedContext(messages.slice(0, projection.cutoff)).lastId;
    if (covered > 0 && covered < state.lastId) {
      state.compaction = {
        version: 1, taskCardVersion: state.taskCard.version,
        coveredFrom: 1, coveredThrough: covered, recentFrom: covered + 1,
        snapshotHead: state.lastId, summary: projection.summary,
        evidenceRefs: [], tokensBefore: 0, tokensAfter: 0,
      };
    }
  }
  return state;
}
