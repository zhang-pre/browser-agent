# patches/agent-ui/

把 Agent 侧边栏**挂载进 Firefox chrome** 的补丁集。源文件在 [`additions/browser/components/agent-sidebar/`](../../additions/browser/components/agent-sidebar/README.md)，本目录的 patch 负责让 Firefox 加载并显示它。方案见 [`docs/agent-sidebar.md`](../../docs/agent-sidebar.md)。

## 关系

```
patches/agent-ui/         ← 改 upstream，注册 sidebar 入口 + 把 additions 挂进 omni.ja
additions/.../agent-sidebar/  ← 提供 React/ESM 源文件（不改 upstream）
```

## 补丁清单

| 补丁 | 作用 | 状态 |
|---|---|---|
| `0001-register-agent-sidebar.patch` | 注册 Agent 侧栏和资源 | 已实现 |
| `0002-keep-sidebar-launcher-at-top.patch` | 保持入口位于侧栏顶部 | 已实现 |
| `0003-package-locale-default.patch` | 打包默认语言配置 | 已实现 |
| `0004-settle-extension-startup-on-quit.patch` | Firefox 过早退出时结束隐藏扩展窗口的初始化等待 | 已移植，待真实浏览器验证 |

`0004` 移植 Mozilla [4cf4f28e](https://github.com/mozilla-firefox/firefox/commit/4cf4f28e4a29a167957dd021a4d7227d952d0078) 对 [Bug 2051934](https://bugzilla.mozilla.org/show_bug.cgi?id=2051934) 的修复。可用 `node scripts/tests/extension-shutdown.mjs /path/to/patched-gecko` 执行类级回归测试；真实 Firefox 启动和退出仍需单独验证。

## 当前维护边界

- 注册点由 `0001` 指向 `SidebarController` 及构建清单，内容 URL 为 `chrome://browser/content/agent-sidebar/panel.html`。旧 A1 交接保留在 [HANDOFF.md](HANDOFF.md)，不再作为当前实施计划。
- React bundle 由 esbuild 生成，经 `jar.mn` 进入浏览器资源包；修改 JSX 后先构建再同步 additions。
- Firefox 宿主命令使用 `Subprocess.sys.mjs`；LLM 网络由 Host 注入 Transport，不依赖 Node `child_process`。
- Node/Python 使用目标机安装，路径可在侧栏设置中覆盖。
- 原生 JSVMP/WebAPI 接入由 `scripts/apply-phase-b.py` 单独执行，不由本目录的 UI patch 完成。探针路径、PID 与健康检查见 [原生能力](../../docs/agent-native-capabilities.md)。
- Firefox 基线锁定为 `cebc55aab4d2661d1f6c2d1526362947ec4016c1`；变更基线须同时适配补丁、Python 接入与 Firefox 后端，见 [上游同步](../../docs/upstream-sync.md)。
