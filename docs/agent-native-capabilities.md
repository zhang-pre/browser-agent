# Agent 原生能力与后端

内置工具规格位于 `modules/tools/Tools.sys.mjs`，由 `createBuiltinTools(backends)` 根据后端是否存在注册。`ToolRouter` 负责分派、参数检查、确认标记和结果信封；`AgentLoop` 负责模型/工具循环。完整工具列表见 [README](../README.md#内置工具)。

## 实现对应

以下路径均相对于 `additions/browser/components/agent-sidebar/`。

| 工具/能力 | 实现 | 边界 |
|---|---|---|
| `page_*`、`deep_target`、`deep_run` | `backends/PageBackend` + `AgentEvalChild` JSWindowActor | Firefox 页面目标；深度执行要求 targetId，刷新/求值还检查 documentId |
| `net_capture / net_list / net_get` | `NetworkBackend` 的 HTTP observer + 内容侧发起栈 | 请求/响应头、状态、URL 和尽力采集的栈；不采集 body，不提供改包 |
| `scripts_*` | `ScriptsBackend` | 顶层页面外部脚本 URL 枚举和抓取，不覆盖所有运行时源码 |
| `code_search / find_param_entry` | `CodeBackend`、`Backends` 组合搜索 | 工作目录/语料搜索与请求线索，不保证自动识别 signer |
| `jsvmp_*` | `JsvmpBackend` + `JsvmpTraceCore` + `content/tools/*.cjs` | 解释器 NDJSON 与离线分析；开启追踪限制 JIT |
| `webapi_*` | `WebApiBackend` + `WebApiTraceCore` | WebIDL getter/method，环境依赖与流程查询 |
| `deep_health` | `NativeTraceHealth`，由 JSVMP/WebAPI 后端调用 | 以当前 PID、本轮起点后的新增记录判断采集 |
| `signer_trace / closure_read` | 页面调试通道 | 调试器观测，不等于无侵入 C++ 探针 |
| `hook_inject` | 页面 document-start 注入 | 页面脚本会被修改，需考虑重复安装与恢复 |
| WASM、JS trace、crypto、whitebox | `JsvmpBackend` 包装 `content/tools/*.cjs` | 宿主 Node 执行；结果先落盘再按需读取 |
| 文件与脚本执行 | `WorkspaceBackend` | 文件路径约束到工作目录；Node/Python 子进程仍具宿主权限 |
| Cookie | `Backends` 中的 `Services.cookies` 适配 | 存储管理，含 httpOnly；不是 Cookie 访问审计 |
| Skills / 记忆 | `SkillBackend`、`LedgerBackend` 与 `state/` | 按目录发现/检索，统一证据契约；旧 Notes 已移除 |
| 环境 / 扩展 | `EnvironmentBackend`、`AddonBackend` | 独立进程与 profile、AMO 与 AddonManager |

## 注册与执行

`createBuiltinTools` 的声明数是工具上限，后端缺失时不会注册对应工具。`localToolsEnabled=false` 再通过 `LocalCapabilityPolicy` 过滤会话工具面，MCP 动态工具另由 MCP Manager 组合。不要根据 `CONFIRM_TOOLS` 中遗留的名称推断工具已经实现。

工具结果使用 `{ok, data?, error?, meta?}` 信封。是否执行确认由工具标记、运行配置与确认回调共同决定；MCP sampling 的输入/回传双重审批另有规则，不受全自动模式豁免。

## 原生追踪接入

`apply-patches.sh` 不包含 Phase B。完整构建需要另执行 `python3 scripts/apply-phase-b.py upstream`，将追踪核心注册进构建，并修改 Interpreter 与 WebIDL 生成器。参见 [构建说明](../README.md#源码构建)。仅把 C++ 文件复制到源码树并不能让探针生效。

默认 trace 位于 `/tmp`；Windows 使用 `TEMP`/`TMP`（再回退系统临时路径）。JSVMP 默认 `browser-agent-jsvmp-b.ndjson.<pid>`，WebAPI 默认 `browser-agent-webapi.ndjson.<pid>`；环境启动可指定文件基路径。控制文件、过滤和读取由相应后端管理，`sid` 只在该进程有效，不能作为跨重启稳定标识。

建议顺序：确认 Firefox 目标和 ready → 开启窄范围观测 → 触发一次 → `deep_health` 确认新增记录 → 查询 → 停止。导航换 PID 要重新开启；旧文件有内容或 start 成功都不足以证明本次采集有效。JSVMP 限制 JIT 且写盘会改变性能，不承诺时间检测不可见。

## 维护与验证

新能力放入 backend，经 `Backends` 装配后在 `Tools` 声明；不得从 Runtime 反向调用 Firefox API。Node 自测验证路由与契约，Gecko 构建及真实页面验证原生接入和记录产出。具体测试入口见 [测试说明](../tests/README.md)。
