# 架构概览

本文按当前源码说明构建与运行边界。Firefox 基线由 `scripts/bootstrap.sh` 和 `.github/workflows/release.yml` 锁定为 `cebc55aab4d2661d1f6c2d1526362947ec4016c1`；`upstream/` 是本地源码树，不随本仓库提交。

## 源码与接入

| 路径 | 当前职责 |
|---|---|
| `additions/browser/components/agent-sidebar/` | React UI、Agent Runtime、模型协议、MCP 客户端、工具和 Firefox 后端 |
| `additions/dom/base/` | 指纹配置服务、种子与 NavigatorUAData 实现 |
| `additions/dom/bindings/` | WebIDL getter/method 原生追踪 |
| `additions/dom/media/webaudio/` | 离线音频 PCM 转换 |
| `additions/js/src/vm/` | SpiderMonkey 解释器追踪核心 |
| `additions/js/xpconnect/src/` | 早期 interrupt hook 源码；当前 Phase B 接入使用解释器核心 |
| `patches/agent-ui/`、`patches/branding/` | 侧栏注册、打包、退出修复和品牌补丁 |
| `scripts/apply-fingerprint-config.py` | 对上游的指纹消费者、进程快照及相关首选项接入 |
| `scripts/apply-phase-b.py` | 对上游 Interpreter、WebIDL 生成器及构建清单的追踪接入 |
| `settings/*.example.json` | 示例与历史配置参考；不是被浏览器统一自动读取的配置目录 |

部分 `patches/` 子目录仅有说明；其能力可能由 JS 后端或 Python 接入脚本提供。不能用该目录有无 `.patch` 判断功能是否存在。

## 构建链

```text
React JSX --npm run build--> content/agent-sidebar.bundle.js
Firefox pinned ref --bootstrap.sh--> upstream/
patches + additions --apply-patches.sh--> git apply --index + rsync + 指纹接入
                       apply-phase-b.py --> 解释器与 WebIDL 追踪接入
                       build.sh --> upstream/obj-*/dist/
                       package.sh --> dist/ 中的安装包
```

完整命令见 [README 的源码构建](../README.md#源码构建)。`sync-additions.sh` 排除 JSX、开发测试、Node 依赖和 package 文件，只复制运行所需源文件及已生成的 bundle；它不替你编译 JSX，也不重新执行接入脚本。`build faster` 适合资源/JS 迭代，C++、WebIDL 与构建注册变更使用完整构建。

Phase B 脚本还在 Windows 入口设置 `MOZ_DISABLE_CONTENT_SANDBOX=1`，用于原生 trace 写盘。这是现有构建的实际行为，与指纹快照自身不放松沙箱的设计需区分。

## 运行分层

```text
React AgentPanel / 设置 / 环境管理
  -> host/AgentSession（父进程共享实例）
  -> host/FirefoxAgentRuntimeHost（Firefox Ports）
  -> runtime/AgentRuntime + AgentRuntimeCore + AgentTurnOrchestrator
  -> runtime/AgentLoop
     -> llm/LlmClient -> 协议、流解析、请求执行、Transport
     -> tools/ToolRouter
        -> backends/（JSWindowActor、HTTP observer、文件、进程、Gecko 探针）
        -> mcp/ + host/FirefoxMcpService（第三方服务）
```

Runtime 通过注入的 Ports 使用配置、会话存储、LLM、工具、计时与生命周期能力，不直接导入 Firefox 特权 API。UI 订阅父进程状态，关闭面板不会销毁任务；退出浏览器会进入关闭流程。详见 [Runtime 架构](agent-runtime.md) 和 [模块目录](../additions/browser/components/agent-sidebar/modules/README.md)。

`ToolRouter` 按可用后端注册内置工具，再按会话能力开关筛选。MCP 工具动态发现、命名与授权另由 MCP 层管理。内置探针针对 Firefox；外部 MCP 管理的浏览器不自动成为这些探针的目标。

## 状态、配置与产物

| 数据 | 当前存储/入口 |
|---|---|
| 命名模型配置、普通 API Key、显示与执行偏好 | `providers/ConfigStore`，Firefox `extensions.browser-agent.agent.*` prefs；普通 API Key 仍随 prefs 明文保存 |
| 订阅认证、MCP 凭据 | 对应认证/宿主适配器使用 Firefox Login Manager；不等同于普通 API Key 的存储路径 |
| 会话与统一事件日志 | `state/ConversationStore`，profile 下 `browser-agent-agent/` 数据目录 |
| 类型化记忆 | profile 数据目录的 `memory.sqlite`；工作目录 `ledger.md` 为可读镜像 |
| 脚本、分析结果与运行产物 | 会话工作目录；脚本语料可回退到 profile 数据目录的 `js/` |
| 多环境资料 | 默认 `~/.browser-agent/environments/`，每个环境有独立 profile 与配置；可用 `MOZ_FRX_ENVS_ROOT` 指定根目录 |
| 原生 trace | 按 PID 的 NDJSON；默认系统临时目录，环境启动可指定输出路径；查询可另存到工作目录 |

`BrandCompatibility` 保留旧品牌数据目录的兼容查找。文件工具有工作目录路径检查，但 `run_node` / `run_python` 是宿主子进程，工作目录不是操作系统级沙箱。

统一上下文由 `UnifiedContext` 保存事件、任务目标和压缩状态，`UnifiedTurnContext` 用同一预算处理跨轮投影与压缩；`MemoryContract`、`CompletionMemory` 和 Ledger 负责证据与记忆交接。旧 Notes 工具已移除。

相关说明：[能力与限制](features.md)、[环境管理](fingerprint-environment-manager.md)、[第三方 MCP](mcp-client.md)、[上游同步](upstream-sync.md)、[发布](distribution.md)。
