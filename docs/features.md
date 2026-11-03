# 功能清单

本页描述当前实现；完整内置工具名见 [内置工具清单](tools.md)，参数契约以 [Tools.sys.mjs](../additions/browser/components/agent-sidebar/modules/tools/Tools.sys.mjs) 为准。

## Agent 与模型

- React 侧边栏支持会话历史、工作目录、流式文本/思考/工具结果、全自动与 AI 辅助模式，以及运行中发送补充要求。
- 父进程 Runtime 管理执行、确认、取消、上下文压缩和持久化，面板关闭或重载后可重新订阅。
- 配置支持多个命名模型档案；协议栈支持 OpenAI 兼容 Chat Completions、Anthropic Messages 和订阅专用 Codex Responses。内置 provider 与默认模型以 `providers/providers.sys.mjs` 为准，不能从历史 `settings/agent.example.json` 推断。
- 第三方 MCP 支持 stdio 与 Streamable HTTP、动态工具、资源、提示词和有限的服务反向请求，详见 [MCP 客户端](mcp-client.md)。
- 「本地常规」关闭时只保留原生深度分析与本地支持工具，普通浏览器操作交给已连接的 MCP；完整行为见 [侧边栏](agent-sidebar.md)。

## 页面、网络与源码

| 能力 | 实现与边界 |
|---|---|
| 页面操作 | `PageBackend` / `AgentEvalChild` 通过 Firefox JSWindowActor 完成求值、导航、元素操作与页面信息等 |
| 原生目标控制 | `deep_target` 返回 Firefox 目标、文档、PID 与 ready；`deep_run` 显式导航、刷新或求值；`deep_health` 检查本次 trace 新增记录 |
| HTTP 记录 | `NetworkBackend` 订阅 `http-on-*`，记录 URL、方法、状态、请求/响应头，并尝试合并内容侧发起栈；内存缓冲默认最多 3000 条 |
| 网络限制 | `net_get` 不返回请求或响应 body，`captureBody:true` 会报不支持；没有内置 `net_intercept` 注册，也没有 WebSocket 帧或 WebRTC DataChannel 采集 |
| 脚本保存 | 枚举顶层页面 `document.scripts` 和 Resource Timing 中的外部脚本 URL，再取回源码；不是调试器的完整 eval/new Function/Worker 源码目录 |
| 入口定位 | `find_param_entry` 组合已捕获请求 URL 与源码字面量搜索，提供线索，不自动证明生成函数 |
| Cookie | 原生 Cookie 管理器提供 list/set/remove，包括 httpOnly；不是 CookieService 读写审计或第三方 Cookie 流向追踪 |

## 原生观测与离线分析

- **JSVMP**：`JsvmpTraceCore` 在解释器执行点记录 opcode、script、参数、局部值、返回值等 NDJSON。运行时通过控制文件开关、过滤和限制记录；启用后限制 JIT 层级，已热编译目标可能需重新加载，时序会受影响。当前没有 TOML Hook DSL、任意 PC 修改或 lock-free 后台 writer 的实现。
- **WebAPI**：`WebApiTraceCore` 与 WebIDL 生成器接入记录符合条件的非静态 getter/method 调用，提供环境依赖与调用流程查询；不能据此宣称任意 JS 属性或全部 setter 都已覆盖。
- **签名与闭包**：`signer_trace`、`closure_read` 使用调试通道；`hook_inject` 是 document-start 页面脚本注入。它们与 C++ 探针的机制不同，不能一概称为页面不可感知。
- **离线工具**：dispatcher 拆解/反汇编、密码常量扫描、普通 JS AST 轨迹、WASM 探测/WAT 导出与白盒分支对照。打包源码在 `content/tools/*.cjs`，通过 `WorkspaceBackend` 调宿主 Node 执行。

开启配置成功不等于采集成功。先确认目标与 PID，再开启窄范围观测、触发执行、检查 `deep_health`、查询并停止。MCP 的 Chrome 现场与 Firefox 原生现场分别验证。

## 指纹与环境隔离

`EnvironmentBackend` 和 `EnvironmentPane` 已实现环境创建、配置导入、编辑、启动、关闭、删除，以及当前主进程配置管理。每个环境使用独立 profile、进程、Marionette 端口与目录。

新环境默认 `native-consistent`：语言/时区可配置，UA 默认随实际 Firefox，Screen、DPR、窗口几何和 GPU 保持原生。Canvas 支持真实 software 后端选择；WebGL 支持采样设置；字体可使用本机安装字体白名单；Offline Audio 种子模式需显式开启。历史配置继续兼容，不自动变成新策略。详见 [原生一致指纹策略](native-fingerprint-consistency.md)。

配置通过环境管理器写入环境 JSON 与 profile，并由 `FrxFingerprintConfig` 的父进程快照提供给子进程；更改后通常需重开环境。不是所有字段均可热更新，也不是每次启动都随机化所有表面。

代理由环境配置生成 Firefox `network.proxy.*` prefs，支持 direct/system/auto/PAC 和手动 HTTP/HTTPS/SOCKS 配置。历史示例里的 `rules` 域名/正则路由和 `username/password` 自动认证没有对应实现；按规则选择代理应使用实际配置的 PAC。详见 [代理模块说明](../patches/proxy/README.md)。

## 本地工作与记忆

- 文件工具按会话工作目录解析路径，脚本工具调用 Node/Python（Windows 发行包已内置运行时），npm 安装用于补充分析依赖。
- `skill_list / skill_get / skill_read_resource` 发现和按需读取内置、用户或工作区 Skill。
- `remember / recall` 是统一记忆入口；支持事实、假设、失败条件、决策、产物与观察，携带状态和证据。默认检索当前工作目录，跨目录需显式指定范围。
- `notes_add / notes_get` 已移除；旧 `.frx-notes.ndjson` 保留但不读取或迁移。压缩交接和完成兜底使用统一证据契约，不把未经验证的推断升级成事实。
- Firefox 扩展管理使用 AMO 查询与原生 AddonManager。

实现存在不等于所有平台完成端到端验收。测试入口与覆盖边界见 [tests/README.md](../tests/README.md)。
