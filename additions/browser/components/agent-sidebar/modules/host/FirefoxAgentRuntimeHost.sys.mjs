/* FirefoxAgentRuntimeHost.sys.mjs — Firefox-only adapter for AgentRuntime.
 *
 * All privileged composition lives here: Timer.sys.mjs, application shutdown,
 * browser tool backends, and the ToolRouter singleton. Platform-neutral runtime
 * code depends on this narrow host object instead of importing Firefox APIs.
 */

import { ToolRouter } from "../tools/ToolRouter.sys.mjs";
import { createBuiltinTools } from "../tools/Tools.sys.mjs";
import { getBackends } from "../backends/Backends.sys.mjs";

import { WorkerLease } from "../runtime/WorkerLease.sys.mjs";
import { WorkspaceClaims } from "./WorkspaceClaims.sys.mjs";
const claims = new WorkspaceClaims({ pidState: async pid => {
  if (Services.appinfo.OS === "Linux") return await IOUtils.exists("/proc/" + pid) ? "alive" : "dead";
  return getBackends().env._pidState(pid);
} });
const admission = new WorkerLease({
  claim: (root, thread) => claims.claim(root, thread),
  bind: host => {
    const win = host?.win || Services.wm.getMostRecentWindow("navigator:browser");
    if (!win?.gBrowser?.selectedBrowser) throw new Error("找不到任务浏览器窗口");
    return { win, browser: win.gBrowser.selectedBrowser };
  },
});
const timers = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
let sharedRouter = null;

function router() {
  if (!sharedRouter) {
    sharedRouter = new ToolRouter();
    sharedRouter.registerAll(createBuiltinTools(getBackends()));
  }
  return sharedRouter;
}

function onShutdown(callback) {
  const observer = {
    observe() {
      callback();
    },
  };
  Services.obs.addObserver(observer, "quit-application-granted");
  return () => {
    try {
      Services.obs.removeObserver(observer, "quit-application-granted");
    } catch {
      // The observer service may already be shutting down.
    }
  };
}

const clock = Object.freeze({
  now: () => Date.now(),
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
});

const llmTransport = Object.freeze({
  fetch: (...args) => globalThis.fetch(...args),
  createAbortController: () => new AbortController(),
  setTimeout: timers.setTimeout,
  clearTimeout: timers.clearTimeout,
});

function createToolContext({
  workspaceRoot = null,
  hostContext = null,
  signal = null,
  onUnsafeExecution = null,
} = {}) {
  return {
    workspaceRoot: admission.owner?.workspaceRoot || workspaceRoot,
    threadId: admission.owner?.threadId || null,
    runId: admission.busy?.token || null,
    environmentPid: Services.appinfo.processID,
    browser: admission.owner?.browser || null,
    assertSafe: () => admission.assertSafe(),
    assertToolAllowed: name => {
      if (signal && name.startsWith("env_") && !["env_list", "env_current", "env_read_config"].includes(name)) {
        throw new Error("MVP 任务不能管理其他环境；请在任务开始前手动配置和打开环境");
      }
    },
    onUnsafeExecution: reason => { admission.poison(reason); onUnsafeExecution?.(reason); },
    win: admission.owner?.win || hostContext?.win || null,
    signal,
  };
}

const lifecycle = Object.freeze({ onShutdown });
const tools = Object.freeze({
  admission,
  getRouter: router,
  getBackends,
  createContext: createToolContext,
});

export function createFirefoxAgentRuntimePorts({
  config,
  conversations,
  createClient,
  isVisionModel,
} = {}) {
  return {
    clock,
    config,
    conversations,
    llm: {
      transport: llmTransport,
      createClient,
      isVisionModel,
    },
    tools,
    lifecycle,
  };
}

export const firefoxAgentRuntimeHost = Object.freeze({
  clock,
  lifecycle,
  tools,
  timers: clock,
  router,
  backends: getBackends,
  onShutdown,
  createToolContext,
  llmTransport,
});
