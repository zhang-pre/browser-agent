import { parseHandoff, mergeHandoffs, SUMMARY_PROMPT } from "./MemoryContract.sys.mjs";
import { resolveContextWindowTokens } from "../llm/LlmClient.sys.mjs";
// UnifiedTurnContext.sys.mjs — one budget and one compaction path across user turns.
import {
  appendUnifiedEvents, commitUnifiedCompaction, commitUnifiedRewrite, completeGroups, createUnifiedContext,
  estimateTokens, messagesTokens, normalizeUnifiedContext, planUnifiedCompaction,
  projectUnifiedMessages, taskCardText,
} from "./UnifiedContext.sys.mjs";

const START = "⟪FRX_RUNTIME_CONTEXT_START⟫";
const END = "⟪FRX_RUNTIME_CONTEXT_END⟫";
const number = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

function stripRuntime(content) {
  if (typeof content !== "string") return content;
  let out = content;
  for (;;) {
    const start = out.indexOf(START);
    if (start < 0) return out;
    const end = out.indexOf(END, start);
    out = end < 0 ? out.slice(0, start).trimEnd() :
      (out.slice(0, start) + out.slice(end + END.length)).trim();
  }
}
function forApi(m) {
  const out = { role: m.role, content: m.content };
  for (const key of ["tool_calls", "tool_call_id", "name", "reasoning_content"]) {
    if (m[key] !== undefined) out[key] = m[key];
  }
  return out;
}
function eventSource(events) {
  return events.map(e => {
    const payload = { id: e.id, role: e.role, content: e.content };
    if (e.tool_calls) payload.tool_calls = e.tool_calls;
    if (e.tool_call_id) payload.tool_call_id = e.tool_call_id;
    if (e.artifact) payload.artifact = e.artifact;
    return JSON.stringify(payload);
  }).join("\n");
}
function sourceChunks(events, maxTokens) {
  const groups = completeGroups(events);
  if (groups.some(g => !g.complete)) throw new Error("incomplete tool group in summary source");
  const chunks = [];
  let current = [], used = 0;
  for (const group of groups) {
    const cost = messagesTokens(group.events);
    if (cost > maxTokens) throw new Error("single tool group exceeds summary budget; externalize its result");
    if (current.length && used + cost > maxTokens) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(...group.events);
    used += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
function artifactRefs(events) {
  const refs = [];
  for (const event of events) {
    if (event.artifact?.path && (event.artifact.hash || event.artifact.version)) {
      refs.push({ ...event.artifact, eventId: event.id, toolCallId: event.tool_call_id || null });
    }
  }
  return refs;
}

export async function createUnifiedTurnContext({
  client, messages, journal, systemPrompt = "", dynamicContext = "", getLedger,
  signal, onUsage, cacheKey = "", onCheckpoint, onEvent, onAppend, onCommit, onRewrite, onValidateEvidence, onRefresh,
  toolSpecs = [], contextWindowTokens, reserveOutputTokens,
}) {
  let state = journal
    ? normalizeUnifiedContext(journal)
    : createUnifiedContext((messages || []).filter(m => !m._contextSynthetic));
  const windowTokens = resolveContextWindowTokens(client.model, contextWindowTokens ?? client.contextWindowTokens);
  const outputTokens = number(reserveOutputTokens, number(client.request?.max_tokens, Math.min(32768, Math.floor(windowTokens * 0.25))));
  const hardInput = windowTokens - outputTokens - Math.max(2048, Math.floor(windowTokens * 0.04));
  const toolTokens = estimateTokens(toolSpecs);
  let ledger = "";
  try { ledger = String(await getLedger?.() || ""); } catch {}
  function build(journalState = state) {
    const view = projectUnifiedMessages(journalState);
    const block = [dynamicContext, ledger].map(x => String(x || "").trim()).filter(Boolean).join("\n\n");
    if (block) {
      for (let i = view.length - 1; i >= 0; i--) {
        if (view[i].role === "user") {
          const m = view[i];
          view[i] = { ...m, content: `${stripRuntime(m.content)}\n\n${START}\n【本轮动态上下文】\n${block}\n${END}` };
          break;
        }
      }
    }
    return [...(systemPrompt ? [{ role: "system", content: systemPrompt, _contextSynthetic: true }] : []), ...view];
  }
  const sync = async msgs => {
    const pending = msgs.filter(m => m.role !== "system" && !m._contextSynthetic && !m._contextEventId);
    if (!pending.length) return;
    const clean = pending.map(m => ({
      ...forApi({ ...m, content: stripRuntime(m.content) }),
      ...(m.artifact ? { artifact: m.artifact } : {}),
      internal: m.internal === true || (typeof m.content === "string" && /^（系统[）·]/.test(m.content)),
    }));
    if (completeGroups(clean.map((m, i) => ({ id: i + 1, ...m }))).some(g => !g.complete)) {
      throw new Error("cannot persist an incomplete tool group");
    }
    const result = onAppend ? await onAppend(clean) : appendUnifiedEvents(state, clean);
    state = normalizeUnifiedContext(result.state);
    if (result.events.length !== pending.length) throw new Error("context event append mismatch");
    pending.forEach((m, i) => { m._contextEventId = result.events[i].id; });
  };
  const emit = event => { try { onEvent?.(event); } catch {} };
  let initialMessages = build();
  if (journal) {
    initialMessages.push(...(messages || []).filter(m =>
      m.role !== "system" && !m._contextSynthetic && !m._contextEventId
    ).map(m => ({ ...m })));
  }

  // Reserve retry room before selecting source chunks. Thinking tokens may use
  // the whole first output allocation without producing any summary text.
  const retryOutput = Math.min(16384, Math.floor(windowTokens * 0.4));
  const summarySafety = Math.max(1024, Math.floor(windowTokens * 0.04));
  let retryAfterRound = 0;
  async function summaryText(content, firstOutput, phase, coveredThrough) {
    const request = [
      { role: "system", content: SUMMARY_PROMPT },
      { role: "user", content },
    ];
    const room = windowTokens - messagesTokens(request) - summarySafety;
    if (room < firstOutput) throw new Error(phase + " request exceeds model context budget");
    let detail = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const maxTokens = Math.min(room, attempt ? retryOutput : firstOutput);
      const res = await client.chat(request, {
        signal, maxTokens, cacheKey: cacheKey ? cacheKey + ":unified-" + phase : "",
      });
      signal?.throwIfAborted();
      try { onUsage?.(res?.usage, { phase: "handoff" }); } catch {}
      const text = typeof res?.content === "string" ? res.content.trim() : "";
      const truncated = ["length", "max_tokens"].includes(res?.finishReason);
      let validation = "";
      if (text && !truncated) {
        try { return parseHandoff(text, state.events, coveredThrough); }
        catch (error) { validation = error.message; }
      }
      // Metadata only: reasoning is not a factual summary and must never be
      // substituted for missing content or exposed in diagnostic events.
      detail = "finishReason=" + (res?.finishReason || "unknown") +
        ", contentChars=" + text.length +
        ", reasoningChars=" + String(res?.reasoningContent || "").length +
        ", maxTokens=" + maxTokens + (validation ? ", validation=" + validation : "");
      emit({ type: "context_summary_retry", phase, attempt: attempt + 1, detail });
    }
    const error = new Error("上下文压缩失败：模型连续两次未返回符合结构契约的完整摘要；原始记录和旧摘要已保留。" +
      " (" + phase + ": " + detail + ")");
    error.code = "CONTEXT_SUMMARY_INCOMPLETE";
    throw error;
  }

  async function summarize(plan) {
    const task = taskCardText(state, plan.cutoffId - 1);
    const summaryOutput = Math.min(4096, Math.max(512, Math.floor(windowTokens * 0.16)));
    const summaryInput = windowTokens - retryOutput - summarySafety;
    const maxSource = Math.max(256, Math.min(32000,
      summaryInput - estimateTokens(SUMMARY_PROMPT) - estimateTokens(task) - summaryOutput - 512));
    const chunks = sourceChunks(plan.evicted, maxSource);
    let handoff = null;
    let summary = plan.previousSummary;
    for (const chunk of chunks) {
      const content = `任务卡（只读）：\n${task}\n\n上一版累计状态：\n${summary || "（无）"}\n\n本次新增日志：\n${eventSource(chunk)}`;
      if (estimateTokens(content) + estimateTokens(SUMMARY_PROMPT) > summaryInput) {
        throw new Error("summary request exceeds model context budget");
      }
      const next = await summaryText(content, summaryOutput, "summary", chunk.at(-1).id);
      handoff = mergeHandoffs(handoff, next);
      summary = next.summary;
    }
    return handoff;
  }
  async function rewriteText(previous, task, refs, coveredThrough) {
    const content = `任务卡（只读）：\n${task}\n\n当前累计状态：\n${previous}\n\n证据引用：\n${JSON.stringify(refs || [])}\n\n请重整为更短的累计状态；保留全部已验证结论的证据 ID、相互矛盾的实验及环境、待验证项、当前阶段和下一步。`;
    const rewriteOutput = Math.min(3072, Math.max(512, Math.floor(windowTokens * 0.14)));
    if (estimateTokens(content) + estimateTokens(SUMMARY_PROMPT) > windowTokens - rewriteOutput - Math.max(1024, Math.floor(windowTokens * 0.04))) {
      throw new Error("global rewrite request exceeds model context budget");
    }
    return summaryText(content, rewriteOutput, "rewrite", coveredThrough);
  }

  async function compactImpl(round, msgs, { force = false } = {}) {
    await sync(msgs);
    try { if (getLedger) ledger = String(await getLedger() || ""); } catch {}
    const live = build();
    // Use the same full-request accounting at trigger, candidate and send time.
    // Only subtract fixed overhead when choosing how much raw history to retain.
    const overhead = messagesTokens(live) - messagesTokens(projectUnifiedMessages(state)) + toolTokens;
    const available = hardInput - overhead;
    if (available <= 0) throw new Error("essential context exceeds model window; reduce tool definitions or the latest input");
    const current = messagesTokens(live) + estimateTokens(toolSpecs);
    const trigger = force ? 0 : Math.floor(hardInput * 0.75);
    if (!force && (current <= trigger || (round < retryAfterRound && current <= hardInput))) return live;
    const plan = planUnifiedCompaction(state, {
      triggerTokens: 0, // Full-request threshold was checked above.
      targetTokens: Math.floor(available * 0.55),
      recentTokens: force
        ? Math.max(1, Math.floor(available * 0.08))
        : Math.min(20000, Math.floor(available * 0.28)),
    });
    if (!plan) {
      const previous = state.compaction;
      const summaryTooLarge = previous && estimateTokens(previous.summary) > available * 0.4;
      if (previous && (summaryTooLarge || current > hardInput)) {
        if (onValidateEvidence) await onValidateEvidence(previous.evidenceRefs || []);
        const snapshot = {
          version: previous.version, coveredThrough: previous.coveredThrough,
          taskCardVersion: state.taskCard.version, snapshotHead: state.lastId,
          beforeTokens: current,
        };
        const handoff = await rewriteText(previous.summary, taskCardText(state, previous.coveredThrough), previous.evidenceRefs, previous.coveredThrough);
        const shorter = handoff.summary;
        const candidate = commitUnifiedRewrite(state, snapshot, shorter, { handoff });
        const after = messagesTokens(build(candidate)) + toolTokens;
        if (after > hardInput) throw new Error("essential context still exceeds model window after global rewrite");
        candidate.compaction.tokensAfter = after;
        state = onRewrite
          ? normalizeUnifiedContext(await onRewrite(snapshot, shorter, { afterTokens: after, handoff }))
          : candidate;
        emit({ type: "checkpoint", round, summary: shorter });
        try { await onCheckpoint?.(shorter); } catch {}
        try { ledger = String(await getLedger?.() || ledger); } catch {}
        return build();
      }
      if (current > hardInput) throw new Error("context budget exceeded: no complete group can be compressed; archive or narrow the large tool result");
      return live;
    }
    plan.beforeTokens = current;
    const refs = [...(state.compaction?.evidenceRefs || []), ...artifactRefs(plan.evicted)];
    if (onValidateEvidence) await onValidateEvidence(refs);
    let handoff = await summarize(plan);
    let summary = handoff.summary;
    let candidate = commitUnifiedCompaction(state, plan, summary, { evidenceRefs: refs, handoff });
    let after = messagesTokens(build(candidate)) + toolTokens;
    if (after > hardInput) {
      handoff = mergeHandoffs(handoff, await rewriteText(summary, taskCardText(candidate, candidate.compaction.coveredThrough), candidate.compaction.evidenceRefs, candidate.compaction.coveredThrough));
      summary = handoff.summary;
      candidate = commitUnifiedCompaction(state, plan, summary, { evidenceRefs: refs, handoff });
      after = messagesTokens(build(candidate)) + toolTokens;
    }
    if (after > hardInput) throw new Error("context budget exceeded after compaction; archive the large tool result in a workspace or narrow its output");
    candidate.compaction.tokensAfter = after;
    state = onCommit
      ? normalizeUnifiedContext(await onCommit(plan, summary, { evidenceRefs: refs, afterTokens: after, handoff }))
      : candidate;
    emit({ type: "checkpoint", round, summary });
    try { await onCheckpoint?.(summary); } catch {}
    try { ledger = String(await getLedger?.() || ledger); } catch {}
    return build();
  }
  async function compact(round, msgs, options = {}) {
    try {
      return await compactImpl(round, msgs, options);
    } catch (error) {
      if (error.code !== "CONTEXT_SUMMARY_INCOMPLETE" || signal?.aborted) throw error;
      // A concurrent steer remains in the durable journal, including on failure.
      if (onRefresh) state = normalizeUnifiedContext(await onRefresh());
      const live = build();
      if (options.force || messagesTokens(live) + estimateTokens(toolSpecs) > hardInput) throw error;
      retryAfterRound = round + 3;
      emit({ type: "context_compaction_deferred", round, message: error.message });
      return live;
    }
  }
  return {
    initialMessages,
    appendSteering(msgs, incoming) {
      msgs.push(...incoming.map(m => ({ ...m })));
    },
    compact,
    sync,
    async refresh() {
      if (onRefresh) state = normalizeUnifiedContext(await onRefresh());
    },
    async forceCompact(round, msgs) { return compact(round, msgs, { force: true }); },
    requestMessages(msgs) {
      const clean = msgs.map(forApi);
      const size = messagesTokens(clean) + estimateTokens(toolSpecs);
      if (size > hardInput) throw new Error(`model context budget exceeded: ${size} > ${hardInput} tokens estimated`);
      return clean;
    },
    get journal() { return state; },
  };
}

