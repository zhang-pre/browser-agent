/* AgentRuntime.sys.mjs — platform-neutral Agent composition root. */

import { runAgentTurn } from "./AgentLoop.sys.mjs";
import { AgentRuntimeCore } from "./AgentRuntimeCore.sys.mjs";
import {
  assertAgentBackendsPort,
  assertAgentRouterPort,
  defineAgentRuntimePorts,
} from "./AgentRuntimePorts.sys.mjs";
import { AgentTurnOrchestrator } from "./AgentTurnOrchestrator.sys.mjs";
import { emptyUsage } from "../llm/Usage.sys.mjs";

function createToolContext(ports, input) {
  const context = ports.tools.createContext(input);
  if (!context || typeof context !== "object") {
    throw new TypeError(
      "AgentRuntimePorts: ports.tools.createContext() must return an object"
    );
  }
  return context;
}

/**
 * Assemble one fully independent Agent runtime from host-provided ports.
 *
 * The factory imports no Firefox adapter. A Node process, test runner, browser,
 * or another application can host the same runtime by implementing the Ports
 * contract from AgentRuntimePorts.sys.mjs.
 *
 * @param {import("./AgentRuntimePorts.sys.mjs").AgentRuntimePorts} inputPorts
 * @returns {Readonly<object>}
 */
export function createAgentRuntime(inputPorts) {
  const ports = defineAgentRuntimePorts(inputPorts);
  const runtimeCore = new AgentRuntimeCore({
    now: ports.clock.now,
    setTimeout: ports.clock.setTimeout,
    clearTimeout: ports.clock.clearTimeout,
    createUsage: emptyUsage,
  });
  const getRouter = () =>
    assertAgentRouterPort(ports.tools.getRouter());
  const getBackends = () =>
    assertAgentBackendsPort(ports.tools.getBackends());
  const turnOrchestrator = new AgentTurnOrchestrator({
    runtimeCore,
    ports,
    runAgentTurn,
  });
  const admission = ports.tools.admission;
  const runLog = [];
  const boundOptions = options => ({ ...options,
    workspaceRoot: admission?.owner?.workspaceRoot || options.workspaceRoot,
    systemPrompt: (options.systemPrompt || "") + (admission ? "\n【专用环境限制】一个 Firefox 进程只服务本会话。仅在绑定的工作目录内修改任务文件；不得更改其他任务目录或共享 Git 引用。不得启动脱离当前工具生命周期的后台进程、守护服务或 detached 子进程。需要此类服务时先停止并向用户说明。" : ""),
  });
  let disposed = false;
  let unregisterShutdown = null;

  function ensureActive() {
    if (disposed) {
      throw new Error("AgentRuntime has been disposed");
    }
  }

  function dispose() {
    if (disposed) {
      return false;
    }
    disposed = true;
    if (admission?.busy) admission.poison("运行时已关闭");
    runtimeCore.abortAll();
    const unregister = unregisterShutdown;
    unregisterShutdown = null;
    if (typeof unregister === "function") {
      try {
        unregister();
      } catch {
        // Host shutdown may already have removed its own listener.
      }
    }
    return true;
  }

  const runtime = {
    version: ports.version,
    workerState() { return admission?.snapshot() || null; },
    async prepare(threadId, options) {
      ensureActive();
      if (!admission) throw new Error("Host does not support worker admission");
      return admission.prepare(threadId, options);
    },
    assertPreparation(token) {
      if (!admission) throw new Error("Host does not support worker admission");
      admission.assertPreparation(token);
    },
    preparationContext(token) {
      this.assertPreparation(token);
      return createToolContext(ports, { workspaceRoot: admission.owner.workspaceRoot, hostContext: { win: admission.owner.win } });
    },
    cancelPreparation(token) { admission?.cancelPreparation(token); },

    isRunning(threadId) {
      return runtimeCore.isRunning(threadId);
    },

    listRunning() {
      return runtimeCore.listRunning();
    },

    listTools() {
      try {
        return { ok: true, tools: getRouter().listSpecs() };
      } catch (error) {
        return {
          ok: false,
          error: String((error && error.message) || error),
        };
      }
    },

    async callTool(name, args, options = {}) {
      ensureActive();
      if (!name || typeof name !== "string") {
        return { ok: false, error: "callTool: name (string) required" };
      }
      const running = runtimeCore.listRunning();
      if (running.length) {
        return {
          ok: false,
          error:
            `agent 正在运行（${running.map(item => item.id).join(", ")}）——raw 工具直调已暂时禁用：` +
            "它与运行中的 agent 共享同一工具环境，并发会相互干扰。" +
            "请等待本轮自然结束；主动停止后必须重启环境。",
          running,
        };
      }
      let token;
      try {
        token = admission?.raw(name);
        const context = createToolContext(ports, {
          workspaceRoot: options.workspaceRoot || null,
          hostContext: options.hostContext || null,
          signal: null,
        });
        return await getRouter().dispatch(name, args || {}, context);
      } catch (error) { return { ok: false, error: String(error.message || error) }; }
      finally { admission?.finish(token); }
    },

    acquireThread(candidateIds, owner) {
      ensureActive();
      return runtimeCore.acquireThread(candidateIds, owner);
    },

    renewThread(threadId, owner) {
      ensureActive();
      return runtimeCore.renewThread(threadId, owner);
    },

    releaseThread(threadId, owner) {
      runtimeCore.releaseThread(threadId, owner);
    },

    getState(threadId) {
      return runtimeCore.getState(threadId);
    },

    subscribe(threadId, callback) {
      ensureActive();
      return runtimeCore.subscribe(threadId, callback);
    },

    respondConfirm(threadId, id, approved, all) {
      ensureActive();
      return runtimeCore.respondConfirm(threadId, id, approved, all);
    },

    steer(threadId, content) {
      ensureActive();
      return runtimeCore.enqueueSteer(threadId, content);
    },

    stop(threadId) {
      if (admission?.busy && (admission.owner?.threadId === threadId || admission.busy.threadId === threadId)) admission.poison("任务被停止；旧页面操作可能尚未退出");
      const taskCompleted = runtimeCore.getState(threadId)?.taskCompleted;
      if (runtimeCore.abortThread(threadId) && !taskCompleted) {
        void ports.conversations
          .setThreadTurnStatus(threadId, "cancelled")
          .catch(() => {});
      }
    },

    async start(threadId, options = {}) {
      ensureActive();
      const token = await admission?.begin(threadId, options);
      ensureActive();
      runLog.push({ threadId, at: ports.clock.now(), convoLen: options.convo?.length ?? -1 });
      void turnOrchestrator.run(threadId, boundOptions(options))
        .finally(() => admission?.finish(token)).catch(error => console.error("Agent run failed", threadId, error));
      return { ok: true, started: true, tid: threadId };
    },

    async run(threadId, options = {}) {
      ensureActive();
      runLog.push({
        threadId,
        at: ports.clock.now(),
        convoLen: Array.isArray(options.convo) ? options.convo.length : -1,
      });
      const token = await admission?.begin(threadId, options);
      try {
        ensureActive();
        return await turnOrchestrator.run(threadId, boundOptions(options));
      } finally { admission?.finish(token); }
    },

    getRunLog() {
      return runLog.slice(-20);
    },

    dispose,
  };

  Object.freeze(runtime);
  if (ports.lifecycle.onShutdown) {
    const unregister = ports.lifecycle.onShutdown(dispose);
    if (typeof unregister === "function") {
      if (disposed) {
        try {
          unregister();
        } catch {
          // A synchronous shutdown callback may already own cleanup.
        }
      } else {
        unregisterShutdown = unregister;
      }
    }
  }
  return runtime;
}
