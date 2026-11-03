import assert from "node:assert/strict";
import { setupBundledRuntimePath } from "../modules/host/BundledRuntimes.sys.mjs";

function services(os, files, initialPath = "C:\\Windows\\System32") {
  let path = initialPath;
  const file = value => ({
    path: value,
    clone() { return file(this.path); },
    append(part) { this.path += "\\" + part; },
    exists() { return files.includes(this.path); },
    isFile() { return files.includes(this.path); },
  });
  return {
    appinfo: { OS: os },
    dirsvc: { get: () => file("C:\\Program Files\\Firefox Reverse") },
    env: { get: () => path, set: (_key, value) => { path = value; } },
  };
}

const root = "C:\\Program Files\\Firefox Reverse\\runtimes";
const windows = services("WINNT", [root + "\\node\\node.exe", root + "\\python\\python.exe"]);
assert.deepEqual(setupBundledRuntimePath({ services: windows }), [root + "\\node", root + "\\python"]);
assert.equal(windows.env.get("PATH"), root + "\\node;" + root + "\\python;C:\\Windows\\System32");
const original = windows.env.get("PATH");
setupBundledRuntimePath({ services: windows });
assert.equal(windows.env.get("PATH"), original);

for (const os of ["Linux", "Darwin", "WINNT"]) {
  const empty = services(os, []);
  assert.deepEqual(setupBundledRuntimePath({ services: empty }), []);
  assert.equal(empty.env.get("PATH"), "C:\\Windows\\System32");
}
const partial = services("WINNT", [root + "\\node\\node.exe"]);
assert.deepEqual(setupBundledRuntimePath({ services: partial }), [root + "\\node"]);
assert.equal(partial.env.get("PATH"), root + "\\node;C:\\Windows\\System32");
assert.deepEqual(setupBundledRuntimePath({ services: undefined }), []);
console.log("bundled runtimes: private PATH, spaces, idempotence and development fallback passed");
