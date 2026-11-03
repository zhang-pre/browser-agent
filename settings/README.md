# 配置示例的适用范围

本目录不作为浏览器统一自动读取的配置入口。运行配置以侧栏设置、环境 JSON 与 profile 首选项为准。

| 示例 | 用途与限制 | 当前实现 |
|---|---|---|
| `agent.example.json` | A1 时期的 provider/request 设计样例，不是当前模型配置导入格式；其中模型、SSE 与协议阶段注释仅为历史记录 | `modules/providers/ConfigStore.sys.mjs` 的命名配置与 `providers.sys.mjs` |
| `fingerprint.example.json` | 历史字段/采集结构示例，包含 Chromium 身份且没有新策略声明；不适合作为新建 Firefox 原生一致环境的默认配置 | 环境管理器生成配置，`NativeFingerprintPolicy` 校验，`FrxFingerprintConfig` 消费 |
| `proxy.example.json` | `enabled/default/no_proxy_for` 等可参考；`rules` 路由与 username/password 自动认证尚未实现 | `EnvironmentBackend._proxyUserPrefs` |
| `environment.example.json` | 目录与启动协议参考；实际默认值由源码定义，不从此 JSON 加载 | `EnvironmentBackend` |

上表的 `modules/` 指 `additions/browser/components/agent-sidebar/modules/`。新环境应从环境管理器创建，再导出/读取其实际配置；修改后重开环境。详见 [环境管理](../docs/fingerprint-environment-manager.md)、[原生一致策略](../docs/native-fingerprint-consistency.md) 与 [侧栏模型设置](../docs/agent-sidebar.md)。
