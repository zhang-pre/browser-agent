# 代理配置

当前代理能力位于 `EnvironmentBackend._proxyUserPrefs`，将每环境 `proxy.json` 转为 profile 的 Firefox `network.proxy.*` 首选项；本目录没有 Necko 路由扩展补丁。

支持的默认类型包括 direct、system、auto、PAC，以及手动 HTTP/HTTPS/SOCKS4/SOCKS5；可设置协议专用 host/port、no_proxy_for、SOCKS 远程 DNS，以及 `fallback_on_failure=false` 对应的禁止直连回退。保存后重开环境使启动配置完整生效。

`settings/proxy.example.json` 是历史参考，其中 `rules` 的域名/URL 正则路由和 `username/password` 自动代理认证没有消费实现。不要复制这些字段后假定已经生效；规则路由可通过显式 PAC 配置完成。

浏览器不会自动读取仓库中的 `settings/proxy.json`。实际配置入口是环境管理 UI 或 `env_read_config / env_write_config(type="proxy")`，见 [环境管理](../../docs/fingerprint-environment-manager.md)。
