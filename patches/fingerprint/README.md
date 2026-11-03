# 指纹配置

本目录没有独立 `.patch`；接入由 `scripts/apply-fingerprint-config.py` 对上游实施，`apply-patches.sh` 会调用它。主要源码为 `additions/dom/base/FrxFingerprintConfig.*`、`FrxFingerprintSeed.h`、NavigatorUAData 及离线音频转换头文件。

环境管理器保存每环境配置，同步到 profile；父进程加载后向子进程提供快照。浏览器不会自动把仓库 `settings/fingerprint.json` 当成全局入口，也不保证所有配置实时热更新。

新环境采用 `native-consistent`，保留原生 UA/显示/GPU 等边界，提供有实际消费者的语言、时区、渲染与可选离线音频设置。旧环境继续兼容；是否启用某字段取决于策略与消费者，不等于每次启动随机化所有字段。

详见 [环境管理](../../docs/fingerprint-environment-manager.md)、[原生一致策略](../../docs/native-fingerprint-consistency.md)。
