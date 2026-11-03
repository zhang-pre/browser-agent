const done = arguments[arguments.length - 1];
const options = arguments[0];
const checks = [];
(async () => {
  const check = (value, name) => {
    if (!value) throw new Error(name);
    checks.push(name);
  };
  const load = name => ChromeUtils.importESModule(
    "resource:///modules/agentsidebar/" + name + ".sys.mjs"
  );
  check(PathUtils.profileDir === options.profile, "isolated-profile");
  const brand = Services.strings.createBundle("chrome://branding/locale/brand.properties");
  check(brand.GetStringFromName("brandFullName") === "Web Reverse", "compiled-brand");
  const { ConfigStore } = load("providers/ConfigStore");
  const config = new ConfigStore();
  check(config.isPersistent, "native-preferences");
  check(config.getConfirmTools() === (options.phase === "initial"), "legacy-preference-and-restart");
  check(config.listModelProfiles().some(p => p.id === "legacy-model"), "legacy-model-profile");
  const { ConversationStore } = load("state/ConversationStore");
  const store = new ConversationStore();
  const legacy = await store.getThread("legacy-brand-sentinel");
  check(legacy?.messages[0]?.content === "legacy message", "legacy-conversation-read");
  const context = { workspaceRoot: options.workspace };
  await IOUtils.makeDirectory(options.workspace, { ignoreExisting: true });
  const { LedgerBackend } = load("backends/LedgerBackend");
  const ledger = new LedgerBackend();
  if (options.phase === "initial") {
    config.setConfirmTools(false);
    config.updateModelProfile("legacy-model", { name: "persisted model" });
    const thread = await store.createThread("native rename persistence");
    await store.appendMessage(thread.id, { role: "user", content: "persisted message" });
    Services.prefs.setStringPref("extensions.browser-agent.nativeTestThreadId", thread.id);
    Services.prefs.savePrefFile(null);
    const exported = await store.exportThread(thread.id);
    check(exported.format === "browser-agent-conversation" && exported.source.app === "Web Reverse", "portable-export");
    const imported = await store.importThread({ ...exported, format: "firefox-reverse-conversation" });
    check(imported.messages[0].content === "persisted message", "legacy-portable-import");
    await ledger.append({ text: "native rebrand sqlite sentinel" }, context);
    const { WorkspaceBackend } = load("backends/WorkspaceBackend");
    const workspace = new WorkspaceBackend({ config: {
      getNodePath: () => options.node, getPythonPath: () => options.python,
    } });
    const written = await workspace.write({ path: "fixture.txt", content: "file sentinel" }, context);
    const read = await workspace.read({ path: written.path }, context);
    check(read.content === "file sentinel", "native-file-roundtrip");
    const node = await workspace.runNode({ code: "console.log(6 * 7)" }, context);
    check(node.ok && node.output.trim() === "42", "native-node-execution");
    const python = await workspace.runPython({ code: "print(6 * 7)" }, context);
    check(python.ok && python.output.trim() === "42", "native-python-execution");
    const { getBackends } = load("backends/Backends");
    const backends = getBackends();
    const { createBuiltinTools } = load("tools/Tools");
    const names = createBuiltinTools(backends).map(t => t.name);
    check(["fs_read", "run_node", "env_list", "net_capture", "page_navigate", "remember"].every(n => names.includes(n)), "compiled-tool-registration");
    const environment = await backends.env.create({ id: "brand-smoke-env", name: "Native brand fixture" });
    check(await IOUtils.exists(PathUtils.join(options.environments, "brand-smoke-env", "env.json")), "isolated-environment-create");
    check(JSON.stringify(await backends.env.list()).includes("brand-smoke-env"), "environment-list");
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const pageContext = { ...context, win };
    const pause = () => new Promise(resolve => win.setTimeout(resolve, 100));
    await backends.page.navigate({ url: options.url }, pageContext);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await backends.page.info({}, pageContext)).value?.title === "Native product fixture"; } catch {}
      if (ready) break;
      await pause();
    }
    check(ready, "native-page-navigation-and-evaluation");
    await backends.page.click({ selector: "#probe" }, pageContext);
    check((await backends.page.eval({ expression: "window.probeValue" }, pageContext)).value === 42, "native-page-click");
    await backends.net.capture({ action: "start", urlPattern: options.url + "*" }, pageContext);
    try {
      const fetched = await backends.page.eval({ expression: "fetch('/api').then(r => r.json())" }, pageContext);
      check(fetched.value?.answer === 42, "fixture-request");
      const requests = await backends.net.list({ urlPattern: options.url + "api" }, pageContext);
      check(requests.requests.some(r => r.url.endsWith("/api") && r.status === 200), "native-network-capture");
    } finally {
      await backends.net.capture({ action: "stop" }, pageContext);
    }
    const label = await win.document.l10n.formatMessages([{ id: "sidebar-menu-agent-label" }]);
    check(label[0]?.attributes?.some(a => a.name === "label" && a.value === "Web Reverse"), "compiled-sidebar-label");
    await win.SidebarController.show("viewAgentSidebar");
    let title = "";
    for (let i = 0; i < 150; i++) {
      const browser = win.SidebarController.browser || win.document.getElementById("sidebar");
      title = browser?.contentDocument?.querySelector(".agent-panel__title")?.textContent?.trim() || "";
      if (title === "Web Reverse") break;
      await pause();
    }
    check(title === "Web Reverse", "rendered-sidebar-title");
    const { runAgentTurn } = load("runtime/AgentLoop");
    const { ToolRouter } = load("tools/ToolRouter");
    let rounds = 0, actions = 0;
    const router = new ToolRouter().register({ name: "fs_read", handler: () => { actions++; return { value: 42 }; } });
    const loop = await runAgentTurn({ router, maxRounds: 6,
      messages: [{ role: "user", content: "Inspect and verify the fixture." }],
      client: { chat: async () => {
        rounds++;
        if (rounds === 1) return { content: "I will inspect it.", toolCalls: [], finishReason: "stop" };
        if (rounds === 2) return { content: "", toolCalls: [{ id: "fixture", type: "function", function: { name: "fs_read", arguments: "{}" } }], finishReason: "tool_calls" };
        return { content: "The result is 42.", toolCalls: [], finishReason: "stop" };
      } },
    });
    check(rounds === 3 && actions === 1 && loop.stopReason === "final", "native-agent-tool-loop");
  } else {
    check(config.listModelProfiles().some(p => p.id === "legacy-model" && p.name === "persisted model"), "model-profile-restart-persistence");
    const id = Services.prefs.getStringPref("extensions.browser-agent.nativeTestThreadId");
    check((await store.getThread(id))?.messages[0]?.content === "persisted message", "conversation-restart-persistence");
  }
  const recalled = await ledger.recall({ query: "native rebrand sqlite sentinel" }, context);
  check(recalled.count === 1, "native-sqlite-roundtrip-and-restart");
  await ledger.close();
  check(!(await IOUtils.exists(PathUtils.join(PathUtils.profileDir, "browser-agent-agent"))), "legacy-data-root-preserved");
  return { passed: true, phase: options.phase, checks, buildId: Services.appinfo.appBuildID };
})().then(done, error => done({ error: String(error), stack: error.stack, checks }));
