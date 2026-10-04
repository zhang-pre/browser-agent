/* Firefox stdio transport. No shell interpolation; stdout is protocol only. */
import { createJsonLineParser } from "../mcp/McpClient.sys.mjs";

export function createFirefoxStdioTransport({ Subprocess, resolveCommand, config, env = {}, onStderr = () => {} }) {
  let process = null, closed = false, reportClose = null, writing = Promise.resolve();
  const disposeProcess = () => {
    for (const pipe of [process?.stdin, process?.stdout, process?.stderr]) {
      try { Promise.resolve(pipe?.close?.(true)).catch(() => {}); } catch { /* already closed */ }
    }
    try { Promise.resolve(process?.kill()).catch(() => {}); } catch { /* already exited */ }
  };
  const stop = error => {
    if (closed) return;
    closed = true;
    disposeProcess();
    reportClose?.(error);
  };
  return {
    async start(onMessage, onClose) {
      reportClose = onClose;
      const resolved = await resolveCommand(config, env);
      if (closed) throw new Error("MCP connection closed");
      process = await Subprocess.call({ command: resolved.command, arguments: resolved.args,
        workdir: config.cwd || undefined, environment: resolved.env, environmentAppend: true, stderr: "pipe" });
      if (closed) { disposeProcess(); throw new Error("MCP connection closed"); }
      const parser = createJsonLineParser(onMessage, { onError: error => stop(error) });
      // Start all pipe consumers before waiting for exit, preventing pipe backpressure.
      void (async () => {
        try {
          let chunk;
          while (!closed && (chunk = await process.stdout.readString())) parser.push(chunk);
          if (!closed) { parser.end(); stop(new Error("MCP stdout closed")); }
        } catch { stop(new Error("MCP stdout failed")); }
      })();
      void (async () => {
        try {
          let chunk;
          while (!closed && (chunk = await process.stderr.readString())) onStderr(chunk);
        } catch { /* pipe closes with the process */ }
      })();
      void process.wait().then(() => stop(new Error("MCP process exited")), () => stop(new Error("MCP process failed")));
    },
    send(message, { signal } = {}) {
      const task = writing.then(() => {
        if (closed || !process || signal?.aborted) throw new Error("MCP connection closed or cancelled");
        return process.stdin.write(JSON.stringify(message) + "\n");
      });
      writing = task.catch(() => {});
      return task;
    },
    close() { stop(new Error("MCP connection closed")); },
  };
}
function userError(message) { const error = new Error(message); error.mcpUserMessage = message; return error; }
export async function resolveMcpCommand(config, secrets, { windows, workspace, Subprocess, PathUtils, IOUtils, getEnv }) {


  const environment = { ...Subprocess.getEnvironment(), ...secrets };
  const hasPath = Object.keys(secrets).some(k => windows ? k.toUpperCase() === "PATH" : k === "PATH");
  if (windows && hasPath) {
    const key = Object.keys(secrets).find(k => k.toUpperCase() === "PATH");
    for (const item of Object.keys(environment)) if (item.toUpperCase() === "PATH") delete environment[item];
    environment.PATH = secrets[key];
  }
  if (config.cwd && !PathUtils.isAbsolute(config.cwd)) throw userError("MCP 工作目录必须为当前系统的绝对路径");
  let command = config.command, args = config.args || [];
  const bare = command.replace(/\\/g, "/").split("/").pop().toLowerCase();
  const isNode = /^(node|node.exe)$/.test(bare);
  const isPython = /^(python3?|python3?\.exe)$/.test(bare);
  const npm = /^(npx|npm)(\.cmd|\.exe)?$/.exec(bare);
  // Windows npm wrappers are batch scripts. Launch the actual CLI with Node,
  // preserving argument boundaries instead of composing a cmd.exe command line.
  if (windows && npm) {
    let node;
    if (hasPath) {
      try { node = await Subprocess.pathSearch("node.exe", environment); }
      catch { throw userError("Configured PATH does not contain Node.js (node.exe)"); }
    } else {
      node = await workspace._resolveExe("node");
    }
    if (!node) throw userError("找不到 Node.js；请先安装运行环境或配置 node.exe 的绝对路径");
    const dirs = [PathUtils.parent(node)];
    if (PathUtils.isAbsolute(command)) dirs.unshift(PathUtils.parent(command));
    try { const appData = getEnv("APPDATA"); if (appData) dirs.push(PathUtils.join(appData, "npm")); } catch { /* optional */ }
    let cli = null;
    for (const dir of dirs) {
      const candidate = PathUtils.join(dir, "node_modules", "npm", "bin", `${npm[1]}-cli.js`);
      if (await IOUtils.exists(candidate)) { cli = candidate; break; }
    }
    if (!cli) throw userError("找不到 npm/npx CLI；请使用 node.exe，并在 args 中填写 CLI 脚本的绝对路径");
    command = node; args = [cli, ...args];
  } else if (!PathUtils.isAbsolute(command)) {
    try { command = await Subprocess.pathSearch(command, environment); }
    catch {
      const fallback = (isNode || isPython) ? await workspace._resolveExe(isNode ? "node" : "python") : null;
      if (!fallback) throw userError("找不到 MCP 启动命令；请安装所需运行环境或填写可执行文件的绝对路径");
      command = fallback;
    }
  }
  if (windows && /\.(cmd|bat)$/i.test(command)) throw userError("请使用可执行文件或解释器加脚本参数；除 npm/npx 外暂不直接运行 .cmd/.bat");
  if (!hasPath) {
    if (windows) for (const key of Object.keys(environment)) if (key.toUpperCase() === "PATH") delete environment[key];
    environment.PATH = workspace._mergedPath(command);
  }
  return { command, args, env: environment };
}
