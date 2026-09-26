import { createUnifiedContext, appendUnifiedEvents, commitUnifiedCompaction, commitUnifiedRewrite } from "../modules/state/UnifiedContext.sys.mjs";
export function contextStoreFixture() {
  const journals = new Map();
  const get = id => journals.get(id) || createUnifiedContext();
  return {
    async markMemorySync() {},
    async getUnifiedContext(id) { return get(id); },
    async appendContextEvents(id, events) {
      const result = appendUnifiedEvents(get(id), events);
      journals.set(id, result.state);
      return result;
    },
    async commitUnifiedCompaction(id, plan, summary, meta) {
      const state = commitUnifiedCompaction(get(id), plan, summary, meta);
      journals.set(id, state);
      return state;
    },
    async commitUnifiedRewrite(id, snapshot, summary, meta) {
      const state = commitUnifiedRewrite(get(id), snapshot, summary, meta);
      journals.set(id, state);
      return state;
    },
    async appendMessage(id, message) {
      if (!message.skipContext) journals.set(id, appendUnifiedEvents(get(id), [message]).state);
      return { unifiedContext: get(id) };
    },
  };
}
