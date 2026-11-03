# Agent 侧边栏

侧边栏已实现并由 `patches/agent-ui/` 注册进 Firefox。内容入口为 `chrome://browser/content/agent-sidebar/panel.html`，React 源码位于 `additions/browser/components/agent-sidebar/content/`。本文描述实际使用和维护入口，旧 A1–A6 规划不再作为当前功能清单。

## 会话与执行

1. 在设置中建立命名模型配置，选择 provider、模型、思考等级及端点。普通 API Key 由 `ConfigStore` 存入 Firefox prefs；订阅登录使用独立认证流程，见 [订阅接入](pi-provider-chatgpt-subscription.md)。
2. 选择工作目录和执行模式。全自动模式持续推进；AI 辅助模式用于阶段交接与方向确认。运行中发送文字是补充要求，Stop 才取消当前执行。
3. 工具结果、思考、文本及用量由 Runtime 事件更新 UI。历史与统一日志保存到 profile 数据目录，文件产物写入绑定工作目录。
4. Runtime 位于父进程，关闭/重载面板不会停止任务；浏览器退出会清理运行资源。详见 [Runtime](agent-runtime.md)。

普通模型配置使用 OpenAI 兼容或 Anthropic 协议；订阅配置有单独的 Responses 适配。实际 provider 与模型目录来自 `modules/providers/`，不读取 `settings/agent.example.json`。模型是否可调用还取决于端点和账号。

## 本地常规能力开关

对话页工作目录旁的「本地常规：开 / 关」决定每个会话的本地工具与提示词。默认开启；选择也作为后续新会话默认值，历史会话保留原配置。运行中不可切换；切换会新建干净会话，保留工作目录和旧会话历史。

开启时提供常规页面、网络、脚本、环境、扩展、Cookie、Skills 和记忆能力。关闭时只保留 `LocalCapabilityPolicy` 定义的 16 项深度工具和 8 项文件/执行支持工具：

- 原生目标、触发与健康检查：`deep_target / deep_run / deep_health`。
- JSVMP、WebAPI、闭包、WASM、JS 轨迹、密码特征和白盒差分工具。
- `fs_list / fs_read / fs_write / fs_copy / fs_mkdir / run_node / run_python / npm_install`。

关闭后不注入旧逆向方法论、阶段门、Skill 目录或账本，普通操作通过已配置 MCP 完成。MCP 服务 instructions 和工具仍按连接与授权状态注入。Firefox 深度工具不会观测 MCP 服务管理的 Chrome；使用前先确认目标。第三方接入与反向请求审批见 [MCP 客户端](mcp-client.md)。

## UI 与模块入口

| 文件/目录 | 职责 |
|---|---|
| `content/AgentPanel.jsx` | 对话、历史、工作目录、执行模式和运行状态 |
| `content/SettingsPane.jsx`、`ChatGptLogin.jsx` | 模型配置、运行选项、订阅登录 |
| `content/EnvironmentPane.jsx` | 指纹环境列表、编辑、启动和关闭 |
| `content/McpSettings.jsx`、`McpRequestPanel.jsx` | MCP 服务与授权请求 |
| `content/MarkdownContent.jsx`、`agent-panel.css` | Markdown 展示和样式 |
| `modules/runtime/`、`modules/state/` | 运行内核、会话、上下文和记忆 |
| `modules/host/`、`modules/backends/` | Firefox 装配、特权 API 和宿主子进程 |
| `modules/llm/`、`modules/providers/`、`modules/mcp/` | 协议、认证、模型与外部服务 |

模块的安装路径保留目录分组，例如 `resource:///modules/agentsidebar/host/AgentSession.sys.mjs`；旧扁平路径已移除。新增模块须登记 `moz.build`，前端资源由 `jar.mn` 打包。没有独立 `TraceBridge`、`HandlersTable` 或 `DisasmView` 实现，分析结果通过现有对话/工具与文件通道展示。

## 开发流程

在仓库根目录执行：

```bash
npm --prefix additions/browser/components/agent-sidebar install
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/sync-additions.sh
cd upstream
./mach build faster
```

此流程用于已完成上游接入的 JS/资源迭代；首次与原生代码构建见 [README](../README.md#源码构建)。`npm run watch` 可在侧栏源码目录持续打包，随后仍需同步和构建。

Firefox 模块运行宿主命令使用 `Subprocess.sys.mjs`，不使用 Node `child_process`。Windows 发行包自带 Node.js/npm 和 Python/pip；其他构建可使用本机安装的运行时，路径可在设置中配置。`fs_*` 的目录约束不把子进程变成系统沙箱。

当前回归入口见 [tests/README.md](../tests/README.md)；详细依赖边界见 [模块目录](../additions/browser/components/agent-sidebar/modules/README.md)。
