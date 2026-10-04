// Per-turn selection; the shared registry remains intact.
export const DEEP_LOCAL_TOOLS = new Set([
  "deep_target", "deep_run", "deep_health",
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
    + "按缺失证据选择工具：普通逆向以 MCP 的 Chrome 为主现场。黑盒目标先验证最短可运行路径，不因源码标有 JSVMP/WASM 就展开整套深度分析。只有现有手段拿不到完成目标所需的具体证据时，才升级，并先说明缺什么、为什么需要 Firefox。"
    + "需要解释器执行路径或局部值时考虑 jsvmp_trace；需要 WebAPI 调用证据时考虑 webapi_trace；闭包值可用 closure_read，分支覆盖可用 whitebox_diff。Firefox 是专项现场，先验证源码、输入和触发行为可复现；Chrome 成功或 Firefox 失败都不能直接证明另一侧的行为。"
    + "原生观测先 deep_target 确认目标，必要时 deep_run 加载并确认就绪，再开启窄过滤观测、触发一次目标执行，用 deep_health 检查本次新增记录，最后查询并停止。配置写入成功不代表内核已采集；健康检查没有新增记录时仅允许一次有依据的目标/PID/过滤条件修正与重试，仍失败就停止观测、记录限制、回到主路线。不要反复 start/query 或仅为修好观测而偏离用户目标。"
    + "刷新换 PID 需重新开启 trace；磁盘源码须在目标页执行并用 sourceURL 匹配 scriptUrl。trace 不会自动修正分支或注入密钥，jsvmp_trace 关闭 JIT 会影响时序。得到满足验收的证据后即可结束；用户要求总结时直接总结。"
    + "失败实验只排除已测输入、参数和环境下的具体方案，不能排除整个算法或运行路线。新证据推翻旧判断时明确标记旧判断已失效，后续不得把它当作前提。"
    + "没有可用 MCP 工具时说明连接状态；仍可按实际可用的 Firefox 深度工具开展分析，不要假装完成未执行的操作。"
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
