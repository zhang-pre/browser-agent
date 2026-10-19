# 当前状态与后续工作

本页以当前源码为准，替代早期 Phase 0–8 计划。已存在的实现不再列为待开发；以下状态不代表本次重新完成了全平台编译或真实站点验收。

## 已有实现

| 范围 | 源码入口 |
|---|---|
| 锁定上游、补丁与增量构建 | `bootstrap.sh`、`apply-patches.sh`、`sync-additions.sh`、两个 Python 接入脚本 |
| 侧栏与父进程 Agent | React `content/`、`modules/runtime/`、`modules/host/` |
| 流式多协议与模型配置 | `modules/llm/`、`modules/providers/`，包含订阅认证适配 |
| 统一上下文与类型化记忆 | `UnifiedContext`、`UnifiedTurnContext`、`MemoryContract`、`CompletionMemory`、`LedgerBackend` |
| 内置工具和第三方 MCP | `Tools`、`ToolRouter`、`modules/mcp/`、`FirefoxMcpService` |
| JSVMP / WebIDL 原生观测 | `JsvmpTraceCore`、`WebApiTraceCore`、`apply-phase-b.py` |
| 本地离线分析与执行 | `content/tools/*.cjs`、`WorkspaceBackend` |
| 环境管理和原生一致指纹 | `EnvironmentBackend`、`NativeFingerprintPolicy`、`FrxFingerprintConfig` |
| 回归与发布入口 | `scripts/selftest-agent-tools.sh`、`.github/workflows/release.yml`、包验证脚本 |

功能边界见 [features.md](features.md)，工具名称以注册表为准。

## 尚未具备或需单独推进

- 内置网络请求/响应 body 采集、改包、WebSocket 帧和 WebRTC DataChannel 捕获。
- 调试器级完整运行时源码目录，以及 Cookie 写入来源审计。
- 完整 Screen/DPR/viewport 显示模拟、跨 OS/Chromium 身份；原生一致策略刻意保留原生边界。
- 早期设想的 TOML Hook DSL、任意 `goto/skip/set_return`、全 JIT 层逐 opcode 追踪及后台无锁 writer。
- MCP 独立 GET 事件流/断线恢复、URL elicitation 等当前未声明的能力，详见 [支持范围](mcp-client.md)。

这些是当前缺口或边界，未指定承诺日期。实际开发顺序应由任务需求决定。

## 构建与验证工作

发布工作流已有自托管 macOS 双架构构建与可选实验性 Windows/Linux 作业，手动触发，不由 tag 自动发布。它不包含自动上传 patched-source tarball 或统一校验和的步骤。Linux arm64 有独立脚本，不在该工作流矩阵中。

升级基线需验证 `.patch` 和 Python 接入脚本、完整 Gecko 构建、原生探针实际产出，以及环境与 MCP 的平台行为。Node mock 自测不能替代这些检查；具体命令见 [测试说明](../tests/README.md)。历史验证记录保留在相应专题和 [CHANGELOG](../CHANGELOG.md)，不将当时结论冒充当前构建结果。
