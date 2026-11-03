# 网络请求分析

当前由 `additions/browser/components/agent-sidebar/modules/backends/NetworkBackend.sys.mjs` 实现。本目录没有 Necko C++ 补丁。

父进程订阅 `http-on-modify-request` 与普通/缓存/合并响应观察者，用通道关联请求和响应。`PageBackend` / `AgentEvalChild` 尝试补充内容侧发起栈；缺栈时仍可返回请求元信息。

工具为 `net_capture / net_list / net_get`。数据包含 URL、method、status、请求/响应头和可获得的 initiatorStack，使用有界内存缓冲（默认 3000 条），不是自动写入某个 `settings.trace.network_dir`。

不采集请求/响应 body，`captureBody:true` 明确拒绝；未注册 `net_intercept`，也不提供 WebSocket 帧/WebRTC DataChannel 采集。需要正文或其他网络证据时使用实际支持该能力的 MCP/调试工具并单独确认。见 [功能清单](../../docs/features.md)。
