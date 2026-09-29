import assert from "node:assert/strict";
import { migrateConversationContext } from "../modules/state/ConversationMigration.sys.mjs";
import { createUnifiedContext, normalizeUnifiedContext, projectUnifiedMessages } from "../modules/state/UnifiedContext.sys.mjs";

const messages = [
  { role: "system", content: "old system metadata" },
  { role: "user", content: "original goal" },
  { role: "assistant", content: "early finding", reasoning_content: "original reasoning" },
  { role: "user", content: "use browser first" },
  { role: "assistant", content: "recent result" },
];
const projection = { version: 1, cutoff: 3, summary: "early finding from experiment" };
const migrated = migrateConversationContext({ contextProjection: projection }, messages);
assert.equal(migrated.lastId, 4);
assert.equal(migrated.compaction.coveredThrough, 2);
assert.equal(migrated.compaction.recentFrom, 3);
assert.equal(migrated.taskCard.originalText, "original goal");
assert.equal(migrated.taskCard.amendments[0].text, "use browser first");
assert.equal(migrated.events[1].reasoning_content, "original reasoning");
assert.deepEqual(normalizeUnifiedContext(migrated), migrated);
assert.match(JSON.stringify(projectUnifiedMessages(migrated)), /early finding from experiment/);
assert.equal(projectUnifiedMessages(migrated).at(-2).content, "use browser first");
assert.deepEqual(migrateConversationContext({ unifiedContext: migrated, contextProjection: projection }, messages), migrated);
assert.equal(migrateConversationContext({ contextProjection: { ...projection, cutoff: 2 } }, messages).compaction, null);
assert.equal(migrateConversationContext({ contextProjection: { ...projection, version: 99 } }, messages).compaction, null);
const raw = createUnifiedContext(messages);
raw.lastId++;
assert.equal(migrateConversationContext({ unifiedContext: raw }, messages).events.length, 4);
console.log("OK legacy migration preserves goals, corrections, reasoning and evidence text; validates boundary, maps IDs, and is idempotent");
