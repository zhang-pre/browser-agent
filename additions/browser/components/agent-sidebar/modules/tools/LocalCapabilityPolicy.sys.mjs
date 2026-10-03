// Per-turn selection; the shared registry remains intact.
export const DEEP_LOCAL_TOOLS = new Set([
  "jsvmp_trace", "jsvmp_query", "jsvmp_status", "jsvmp_split_dispatcher", "jsvmp_disassemble",
  "wasm_probe", "wasm_disasm", "js_trace", "crypto_scan", "whitebox_diff",
  "webapi_trace", "webapi_query", "closure_read",
]);
export const SUPPORT_LOCAL_TOOLS = new Set([
  "fs_list", "fs_read", "fs_write", "fs_copy", "fs_mkdir",
  "run_node", "run_python", "npm_install",
]);
export function localToolVisible(name) {
  return DEEP_LOCAL_TOOLS.has(name) || SUPPORT_LOCAL_TOOLS.has(name);
}
export function mcpOnlyPrompt(assist = false) {
  return "你是浏览器分析助手。按用户目标和当前可用工具开展工作，用中文如实报告证据、结果与未确定事项。"
    + "普通页面、网络、源码与调试操作使用已连接的 MCP 服务，遵循其工具说明。"
    + "本地深度分析工具用于 JSVMP/WASM、引擎观测和离线分析；文件与脚本工具用于支持这些工作。"
    + "本地引擎观测针对 Firefox，MCP 页面属于各服务自己的浏览器，不能将两者视为同一目标。"
    + "没有可用 MCP 工具时说明连接状态，不要假装已经完成浏览器操作。"
    + (assist ? "遇到需要用户决策的实质分叉时汇报并等待；明确授权的步骤直接完成。"
      : "在用户授权范围内持续完成任务；需要用户提供信息时明确说明，完成后报告结果。");
}
export function workspaceContext(path) {
  return path ? "【当前工作目录】" + path + "。本地文件和脚本执行以此为根；MCP 的路径与目标遵循对应服务说明。"
    : "【当前工作目录】未设置。本地深度分析需要文件或脚本时，请用户先选择工作目录。";
}
function neutralToolReferences(text) {
  return text.replace(
    /\b(?:page_\w+|net_\w+|scripts_\w+|skill_\w+|signer_trace|hook_inject|code_search|find_param_entry|remember|recall)\b/g,
    "当前可用的工具");
}
export function deepToolDocumentation(spec) {
  const clean = value => {
    if (typeof value === "string") return neutralToolReferences(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, clean(v)]));
    return value;
  };
  return {
    ...spec, description: clean(spec.description), parameters: clean(spec.parameters),
    handler: async (...args) => {
      try {
        const result = await spec.handler(...args);
        if (!result || typeof result !== "object" || Array.isArray(result)) return result;
        // Only UI guidance is rewritten. Never touch source, stdout, trace data or artifacts.
        const copy = { ...result };
        for (const key of ["note", "hint", "error"]) {
          if (typeof copy[key] === "string") copy[key] = neutralToolReferences(copy[key]);
        }
        return copy;
      } catch (error) {
        throw new Error(neutralToolReferences(String(error?.message || error)), { cause: error });
      }
    },
  };
}
