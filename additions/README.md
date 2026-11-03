# additions

按 Firefox 源码树相对路径维护的覆盖/新增文件。除新增模块外，这里也包含品牌资源和 `security/sandbox/common/SandboxUtils.sys.mjs` 等同路径覆盖文件，不能一概视为纯新增。

```text
additions/
  browser/branding/unofficial/       品牌与图标
  browser/components/agent-sidebar/  UI、Runtime、模型、MCP 与后端
  dom/base/                         指纹配置、种子与 NavigatorUAData
  dom/bindings/                     WebAPI 追踪核心
  dom/media/webaudio/               离线音频转换
  dom/webidl/                       NavigatorUAData IDL
  js/src/vm/                       解释器追踪核心
  js/xpconnect/src/                早期 interrupt hook
  security/sandbox/common/         SandboxUtils 覆盖
```

`apply-patches.sh` 调用 `sync-additions.sh` 复制本目录，并运行指纹接入脚本；Phase B 追踪接入需单独执行。同步排除 README、node_modules、dev、JSX、package 文件和 `.gitignore`，因此修改 JSX 后须先运行侧栏 `npm run build`。

上游已有文件的接入点由 `.patch` 和 `scripts/apply-*.py` 维护。新增模块需同时登记构建与资源清单。完整流程见 [架构](../docs/architecture.md) 和 [源码构建](../README.md#源码构建)。
