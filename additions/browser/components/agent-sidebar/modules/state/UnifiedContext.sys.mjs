// UnifiedContext.sys.mjs — persisted event log and model-facing projection.
export const UNIFIED_CONTEXT_VERSION = 1;
const CONTINUE = /^(?:继续|继续执行|接着做|接着|继续验证|继续分析|go on|continue)[\s。.!！]*$/i;

export function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length;
  return Math.ceil(cjk * 1.5 + (text.length - cjk) / 3) + 4;
}
export function messageTokens(m) {
  return 8 + estimateTokens(m?.content) +
    (m?.tool_calls ? estimateTokens(m.tool_calls) : 0) +
    (m?.reasoning_content ? estimateTokens(m.reasoning_content) : 0);
}
export const messagesTokens = messages => (messages || []).reduce((n, m) => n + messageTokens(m), 0);

function modelMessage(m) {
  const out = { role: m.role, content: m.content ?? "" };
  for (const key of ["tool_calls", "tool_call_id", "name", "reasoning_content", "artifact"]) {
    if (m[key] !== undefined) out[key] = m[key];
  }
  return out;
}
function add(state, message) {
  if (!message || !["user", "assistant", "tool"].includes(message.role)) return null;
  const event = { id: ++state.lastId, ...modelMessage(message) };
  state.events.push(event);
  if (event.role === "user" && typeof event.content === "string" && !message.internal) {
    const card = state.taskCard;
    if (!card.originalId) {
      card.originalId = event.id;
      card.originalText = event.content;
      card.version++;
    } else if (!CONTINUE.test(event.content.trim())) {
      card.amendments.push({
        id: event.id, text: event.content,
        ...(message.newTask ? { kind: "new_task" } : {}),
      });
      card.version++;
    }
  }
  return event;
}
export function createUnifiedContext(messages = []) {
  const state = {
    version: UNIFIED_CONTEXT_VERSION, lastId: 0, events: [],
    taskCard: { version: 0, originalId: null, originalText: "", amendments: [] },
    compaction: null,
  };
  for (const m of messages) add(state, m);
  return state;
}
function validateState(state) {
  const card = state.taskCard;
  const original = card.originalId ? state.events[card.originalId - 1] : null;
  if (card.originalId &&
      (!original || original.role !== "user" || original.content !== card.originalText)) {
    throw new Error("invalid task-card original source");
  }
  let last = card.originalId || 0;
  for (const item of card.amendments) {
    const event = state.events[item.id - 1];
    if (!event || event.role !== "user" || event.content !== item.text || item.id <= last) {
      throw new Error("invalid task-card amendment source");
    }
    last = item.id;
  }
  if (card.version !== (card.originalId ? 1 : 0) + card.amendments.length) {
    throw new Error("invalid task-card version");
  }
  const compact = state.compaction;
  if (compact && (!Number.isSafeInteger(compact.coveredThrough) ||
      compact.coveredThrough < 1 || compact.coveredThrough > state.lastId ||
      compact.recentFrom !== compact.coveredThrough + 1 ||
      !String(compact.summary || "").trim())) {
    throw new Error("invalid compaction coverage");
  }
  for (const ref of compact?.evidenceRefs || []) {
    if (!ref.eventId) continue;
    const event = state.events[ref.eventId - 1];
    if (!event || event.artifact?.path !== ref.path ||
        (ref.version && event.artifact.version !== ref.version)) {
      throw new Error("invalid compaction evidence source");
    }
  }
}

export function normalizeUnifiedContext(raw, messages = []) {
  if (!raw || raw.version !== UNIFIED_CONTEXT_VERSION || !Array.isArray(raw.events) ||
      !raw.taskCard || !Number.isSafeInteger(raw.lastId)) return createUnifiedContext(messages);
  const state = {
    version: UNIFIED_CONTEXT_VERSION, lastId: raw.lastId,
    events: raw.events.map(e => ({ ...e })),
    taskCard: {
      version: raw.taskCard.version || 0,
      originalId: raw.taskCard.originalId || null,
      originalText: String(raw.taskCard.originalText || ""),
      amendments: Array.isArray(raw.taskCard.amendments) ? raw.taskCard.amendments.map(x => ({ ...x })) : [],
    },
    compaction: raw.compaction ? { ...raw.compaction } : null,
  };
  if (state.events.length !== state.lastId || state.events.some((e, i) => e.id !== i + 1)) {
    throw new Error("invalid unified context event sequence");
  }
  validateState(state);
  return state;
}
export function appendUnifiedEvents(raw, messages) {
  const state = normalizeUnifiedContext(raw);
  const events = [];
  for (const m of messages || []) {
    const event = add(state, m);
    if (event) events.push(event);
  }
  return { state, events };
}
export function taskCardText(state, covered = state.compaction?.coveredThrough || 0) {
  const card = state.taskCard;
  if (!card.originalId || covered < card.originalId) return "";
  const amendments = card.amendments.filter(x => x.id <= covered)
    .map(x => x.kind === "new_task"
      ? "- [新任务 #" + x.id + "，当前目标以此消息为准] " + x.text
      : "- [用户消息 #" + x.id + "] " + x.text);
  return `【当前任务卡 v${card.version}】\n[原始用户目标 #${card.originalId}] ${card.originalText}` +
    (amendments.length ? `\n【后续指令，按时间顺序；明确修改以较新指令为准】\n${amendments.join("\n")}` : "");
}
export function projectUnifiedMessages(state) {
  const covered = state.compaction?.coveredThrough || 0;
  const out = [];
  const card = taskCardText(state, covered);
  if (card) out.push({ role: "user", content: card, _contextSynthetic: true });
  if (state.compaction?.summary) {
    out.push({ role: "user", content: `【累计执行状态】\n${state.compaction.summary}`, _contextSynthetic: true });
  }
  for (const event of state.events) {
    if (event.id > covered) out.push({ ...modelMessage(event), _contextEventId: event.id });
  }
  return out;
}
export function completeGroups(events) {
  const groups = [];
  for (let i = 0; i < events.length;) {
    const first = events[i];
    if (first.role === "assistant" && Array.isArray(first.tool_calls) && first.tool_calls.length) {
      const ids = new Set(first.tool_calls.map(call => call.id));
      const group = [first];
      let j = i + 1;
      while (j < events.length && ids.size &&
             (events[j].role === "tool" || events[j].role === "user")) {
        group.push(events[j]);
        if (events[j].role === "tool") ids.delete(events[j].tool_call_id);
        j++;
      }
      groups.push({ events: group, complete: ids.size === 0, firstId: first.id });
      i = j;
    } else {
      groups.push({ events: [first], complete: first.role !== "tool", firstId: first.id });
      i++;
    }
  }
  return groups;
}
export function planUnifiedCompaction(state, { triggerTokens, targetTokens, recentTokens }) {
  const beforeTokens = messagesTokens(projectUnifiedMessages(state));
  if (beforeTokens <= triggerTokens) return null;
  const covered = state.compaction?.coveredThrough || 0;
  const groups = completeGroups(state.events.filter(e => e.id > covered));
  if (groups.length < 2 || groups.some(g => !g.complete)) return null;
  let keep = groups.length - 1, cost = 0;
  for (let i = groups.length - 1; i >= 1; i--) {
    const next = messagesTokens(groups[i].events);
    if (i < groups.length - 1 && cost + next > recentTokens) break;
    cost += next;
    keep = i;
  }
  const cutoffId = groups[keep].firstId;
  if (cutoffId <= covered + 1) return null;
  return {
    snapshotHead: state.lastId, taskCardVersion: state.taskCard.version,
    previousCoveredThrough: covered, cutoffId,
    evicted: state.events.filter(e => e.id > covered && e.id < cutoffId),
    previousSummary: state.compaction?.summary || "",
    beforeTokens, targetTokens,
  };
}
export function commitUnifiedCompaction(raw, plan, summary, { evidenceRefs = [], afterTokens = 0 } = {}) {
  const state = normalizeUnifiedContext(raw);
  if (!summary || !String(summary).trim()) throw new Error("empty context summary");
  if (state.taskCard.version !== plan.taskCardVersion ||
      (state.compaction?.coveredThrough || 0) !== plan.previousCoveredThrough ||
      state.lastId < plan.snapshotHead) throw new Error("context changed during compaction");
  if (plan.cutoffId <= plan.previousCoveredThrough + 1 || plan.cutoffId > plan.snapshotHead) {
    throw new Error("invalid context coverage");
  }
  const liveGroups = completeGroups(state.events.filter(e => e.id > plan.previousCoveredThrough));
  const boundary = liveGroups.findIndex(g => g.firstId === plan.cutoffId);
  if (boundary < 1 || liveGroups.some(g => !g.complete) ||
      plan.evicted.length !== plan.cutoffId - plan.previousCoveredThrough - 1 ||
      plan.evicted.some((e, i) => e.id !== plan.previousCoveredThrough + i + 1)) {
    throw new Error("context cutoff splits a tool interaction or coverage is inconsistent");
  }
  const previousRefs = state.compaction?.evidenceRefs || [];
  const refs = [...previousRefs, ...evidenceRefs]
    .filter(x => x && typeof x.path === "string" && (x.hash || x.version));
  const uniqueRefs = [...new Map(refs.map(x => [x.path + ":" + (x.hash || x.version), x])).values()];
  state.compaction = {
    version: (state.compaction?.version || 0) + 1, taskCardVersion: plan.taskCardVersion,
    coveredFrom: 1, coveredThrough: plan.cutoffId - 1, recentFrom: plan.cutoffId,
    snapshotHead: plan.snapshotHead, summary: String(summary).trim(),
    evidenceRefs: uniqueRefs,
    tokensBefore: plan.beforeTokens, tokensAfter: afterTokens,
  };
  return state;
}


export function commitUnifiedRewrite(raw, snapshot, summary, { afterTokens = 0 } = {}) {
  const state = normalizeUnifiedContext(raw);
  const current = state.compaction;
  if (!current || !String(summary || "").trim()) throw new Error("cannot rewrite empty context");
  if (state.taskCard.version !== snapshot.taskCardVersion ||
      current.version !== snapshot.version ||
      current.coveredThrough !== snapshot.coveredThrough ||
      state.lastId < snapshot.snapshotHead) {
    throw new Error("context changed during global rewrite");
  }
  state.compaction = {
    ...current, version: current.version + 1, taskCardVersion: state.taskCard.version,
    summary: String(summary).trim(), snapshotHead: snapshot.snapshotHead,
    tokensBefore: snapshot.beforeTokens, tokensAfter: afterTokens,
  };
  return state;
}
