# Cookie 与脚本

本目录没有 CookieService 或 ScriptLoader C++ 补丁；当前能力由侧栏 JS 后端提供。

- `cookies` 在 `Backends.sys.mjs` 中调用 Firefox `Services.cookies`，支持 list/set/remove，包括 httpOnly 数据。它不记录每次 Cookie 读写来源、栈或第三方流向。
- `ScriptsBackend.sys.mjs` 用顶层页面 `document.scripts` 和 Resource Timing 枚举外部脚本 URL，再通过特权 fetch 保存。支持 `scripts_list / scripts_save / scripts_capture_all`；不是完整调试器源码目录，不保证覆盖 eval/new Function/Worker/Service Worker。
- 默认脚本语料位于 profile 数据目录 `browser-agent-agent/js/`；`scripts_save(toWorkspace:true)` 保存到会话工作目录供本地执行。以返回的路径、分页/完整性信息为准。

没有自动将所有编译脚本落为 `<sha256>.js` 的后台采集器。更多边界见 [功能清单](../../docs/features.md)。
