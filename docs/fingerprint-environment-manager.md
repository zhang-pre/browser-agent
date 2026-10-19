# 指纹环境管理

环境管理已由 `EnvironmentBackend.sys.mjs` 和 `EnvironmentPane.jsx` 实现。一个环境对应独立 Firefox profile、浏览器进程、Marionette 端口及配置目录；主浏览器进程另有「当前进程」配置入口。

## 数据目录

默认根目录为 `~/.browser-agent/environments/`。`MOZ_FRX_ENVS_ROOT` 可覆盖根目录，兼容 `FRX_ENVS_ROOT` 和旧品牌数据位置。环境 ID 限制为 1–64 位字母、数字、下划线或连字符，首位须为字母/数字。

```text
~/.browser-agent/environments/
  manifest.json
  .current-process/          # 主进程配置与元信息
  <id>/
    env.json
    fingerprint.json        # 管理器保存的配置
    proxy.json
    profile/
      user.js               # 启动首选项
      frx/
        fingerprint.json    # 同步给此 profile 的运行配置
        proxy.json
    captures/
    traces/
    control/runtime.json
    logs/
```

Cookie、站点存储、缓存与扩展随 profile 隔离。目录不存放在源码树或构建目录中；`settings/environment.example.json` 是结构参考，管理器不会自动读取它来设置默认值。

## 工具与生命周期

| 用途 | 工具 |
|---|---|
| 识别环境/主进程 | `env_current`、`env_current_process` |
| 主进程配置 | `env_read_current_process_config`、`env_write_current_process_config`、`env_reset_current_process_default` |
| 环境列表与状态 | `env_list`、`env_status` |
| 创建/改名/启动/关闭/删除 | `env_create`、`env_update`、`env_open`、`env_close`、`env_delete` |
| 配置读写与生成 | `env_read_config`、`env_write_config`、`env_generate_fingerprint` |
| 采集与导入 | `env_capture_fingerprint`、`env_import_fingerprint`、`env_import` |

`env_open` 同步配置到 profile、生成 `user.js`，以 `-marionette -remote-allow-system-access -no-remote -profile <path>` 启动独立进程。端口默认从 2828 开始、最多扫描 200 个候选，通过 prefs 与启动环境设置；不会按历史示例添加 `--marionette-port` 命令行参数。启动状态包含 PID、端口与 Marionette ready，默认最多等待 90 秒。

配置保存与运行时生效分开：编辑后重开环境才能保证新配置完整生效。关闭后才允许删除；`env_delete` 必须传 `confirm:true`，并递归删除整个环境目录再移除索引，**不是只从列表隐藏**。主进程恢复默认也有显式确认参数。

`env_import` 接收环境配置 JSON；指纹采集/导入处理配置与采集数据，不复制登录态。当前没有注册 `env_export`、`env_validate` 或 `.frxenv.zip` 整包导入/导出工具。

## 指纹策略

新环境默认 `consistency.mode=native-consistent`、`version=1`，默认中国大陆/简体中文。UA 与平台默认随实际 Firefox；显示几何、DPR 和 GPU 保持原生。语言、时区与 HTTP 头需一致，UA-CH/Chromium 身份和完整显示模拟不在新策略支持范围。

Canvas software 后端、WebGL MSAA、本机字体白名单和显式 Offline Audio seed 是已有消费者；不能把保存了任意 JSON 字段视为内核已实现。旧环境不自动迁移，新模式校验见 `NativeFingerprintPolicy`，详细行为见 [原生一致指纹策略](native-fingerprint-consistency.md)。

`FrxFingerprintConfig` 在父进程加载并向内容进程传递不可变快照。主进程与环境进程的配置分别管理，损坏的显式配置不会回退到另一个环境。环境启动传入 `MOZ_FRX_ENV_ID`、指纹/代理路径、trace/control 目录等；新策略使用 file-only 指纹启动并清除继承的旧 inline/token。

## 代理、采集与验证

代理配置由 `EnvironmentBackend._proxyUserPrefs` 转为 Firefox prefs，见 [代理说明](../patches/proxy/README.md)。`proxy.json` 不是独立的 Necko 按规则路由引擎。

采集用于记录当前页面可见的环境值，导入时按策略转换和校验。采到值不表示能在不同 OS、GPU 或字体资源下复现；禁用字段可以仅保留为元数据。

环境隔离、端口分配、原生配置校验有 Node/Python 自测；真实启动、进程继承、字体/图形与沙箱路径须在目标平台验证。入口见 [tests/README.md](../tests/README.md)。
