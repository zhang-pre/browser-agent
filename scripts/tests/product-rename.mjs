import assert from "node:assert/strict";
import path from "node:path";
import { dataDirectory, LEGACY_PRODUCT } from "../../additions/browser/components/agent-sidebar/modules/state/BrandCompatibility.sys.mjs";
import { ConfigStore } from "../../additions/browser/components/agent-sidebar/modules/providers/ConfigStore.sys.mjs";
import { ConversationStore } from "../../additions/browser/components/agent-sidebar/modules/state/ConversationStore.sys.mjs";

// New settings win, while old settings remain readable until explicitly cleared.
const oldPrefix = `extensions.${LEGACY_PRODUCT}.agent.`;
const newPrefix = "extensions.browser-agent.agent.";
const prefs = new Map([[oldPrefix + "confirmTools", "1"]]);
const config = new ConfigStore({
  persistent: true,
  getString: (key, fallback) => prefs.has(key) ? prefs.get(key) : fallback,
  setString: (key, value) => prefs.set(key, value),
  clear: key => prefs.delete(key),
});
assert.equal(config.getConfirmTools(), true);
config.setConfirmTools(false);
assert.equal(prefs.get(newPrefix + "confirmTools"), "0");
assert.equal(config.getConfirmTools(), false);
config.b.clear(newPrefix + "confirmTools");
assert.equal(prefs.has(oldPrefix + "confirmTools"), false);
assert.equal(config.getConfirmTools(), false);

// Both portable formats import; new exports use only the current identifier.
const store = new ConversationStore({ memoryOnly: true });
const thread = await store.createThread("rename compatibility");
await store.appendMessage(thread.id, { role: "user", content: "preserved message" });
const exported = await store.exportThread(thread.id);
assert.equal(exported.format, "browser-agent-conversation");
for (const format of [exported.format, LEGACY_PRODUCT + "-conversation"]) {
  const imported = await store.importThread({ ...exported, format });
  assert.equal(imported.messages[0].content, "preserved message");
}
await assert.rejects(store.importThread({ ...exported, format: "unknown" }));

// Resolve the whole data root so conversations, SQLite, MCP and JS stay together.
for (const paths of [path.posix, path.win32]) {
  const parent = paths === path.posix ? "/profile" : "C:\\profile";
  const directories = new Set();
  globalThis.PathUtils = { join: paths.join };
  globalThis.Ci = { nsIFile: {} };
  globalThis.Cc = { "@mozilla.org/file/local;1": { createInstance: () => ({
    initWithPath(value) { this.path = value; },
    exists() { return directories.has(this.path); },
    isDirectory() { return true; },
  }) } };
  for (const name of ["browser-agent-agent", ".browser-agent"]) {
    const current = paths.join(parent, name);
    const legacy = paths.join(parent, name.replace("browser-agent", LEGACY_PRODUCT));
    assert.equal(dataDirectory(parent, name), current);
    directories.add(legacy);
    assert.equal(dataDirectory(parent, name), legacy);
    directories.add(current);
    assert.equal(dataDirectory(parent, name), current);
  }
}
console.log("Product rename: legacy settings, portable conversations, and POSIX/Windows data roots passed");
