# agent-sidebar — UI 与运行时

本目录包含 React 侧栏、父进程 Agent Runtime、模型与 MCP 适配、工具和 Firefox 后端。`patches/agent-ui/` 负责将其注册到 Firefox；实际使用见 [侧栏说明](../../../../docs/agent-sidebar.md)。

| 目录/文件 | 职责 |
|---|---|
| `content/` | React 面板、CSS、HTML、内置 Skill、模板及离线 `.cjs` 工具 |
| `modules/` | runtime、llm、providers、state、tools、backends、host、mcp 分组的 ESM |
| `dev/` | Node 与 Firefox 自测/fixture，不随运行资源同步 |
| `package.json` | React 18 + esbuild，生成 `content/agent-sidebar.bundle.js` |
| `moz.build`、`jar.mn` | ESM 安装与 chrome 资源打包 |
| `preferences/` | 默认偏好与语言配置 |

## 构建与验证

仓库根目录运行：

```bash
npm --prefix additions/browser/components/agent-sidebar install
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/sync-additions.sh
```

同步脚本不编译 JSX；已接入的源码树随后运行 `mach build faster` 更新资源。首次构建和原生变更见 [根 README](../../../../README.md#源码构建)。模块安装保留分组路径；开发规则见 [modules/README.md](modules/README.md)。

常规回归入口是 `bash scripts/selftest-agent-tools.sh`；额外定向测试及真实 Firefox 测试见 [tests/README.md](../../../../tests/README.md)。`dev/selftest-llm.mjs` 默认 dry-run，带 `--live` 才使用环境中的 API Key 发起真实调用。

## 执行边界

`AgentSession` 装配 Firefox Ports 与共享 Runtime，React 订阅其状态。模型协议、流解析、重试、状态内核和编排均有独立模块，详见 [Runtime 架构](../../../../docs/agent-runtime.md)。普通模型 Key 由 `ConfigStore` 保存到 prefs，订阅认证与 MCP 凭据使用独立存储适配。

「本地常规」默认开启；关闭会建立保留工作目录的干净会话，只向模型提供深度分析与文件/执行支持工具，普通操作交给 MCP。旧会话仍保留，运行中不能切换。完整筛选与浏览器目标边界见 [侧栏说明](../../../../docs/agent-sidebar.md#本地常规能力开关)。

记忆统一使用 `remember / recall`；压缩与完成记忆流程见 [模块说明](modules/README.md#压缩与记忆交接)。本地执行使用 Firefox `Subprocess` 启动宿主 Node/Python，不使用 `child_process`，也不提供操作系统级文件沙箱。
