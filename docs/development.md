# 源码构建与开发

Windows 体验包对应标签 [`v0.24.1-web-reverse`](https://github.com/zhang-pre/browser-agent/tree/v0.24.1-web-reverse)。复现该版本时先切到这个标签；当前开发继续在 `feature/runtime` 分支进行。

仓库保存的是应用到 Firefox 源码树上的增量内容，主要代码位于 <code>additions/</code>。以下命令在仓库根目录的 Bash 环境运行，需要 Node.js/npm、Python 3、Git 和 rsync。首次构建先打包 React，再准备锁定版本的 Firefox 源码并接入原生追踪：

Rust 通过根目录的 `rust-toolchain.toml` 固定为 1.97.0，由 rustup 在本项目内选择。锁定的 Firefox 配置在 Rust 1.98 的新增 Linux target 下会报 `Don't know how to translate x86_64-pc-linux-gnu for rustc`；使用项目工具链即可，无需修改全局默认版本或清理对象目录。

~~~bash
npm --prefix additions/browser/components/agent-sidebar install
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/bootstrap.sh
bash scripts/apply-patches.sh
python3 scripts/apply-phase-b.py upstream

bash scripts/build.sh
bash scripts/package.sh
~~~

`apply-patches.sh` 应用 `.patch`、同步 additions 并运行指纹接入脚本；它不调用 `apply-phase-b.py`。后者接入 SpiderMonkey 解释器和 WebIDL 追踪，完整分析构建需单独执行。`build.sh` 首次调用 `mach bootstrap` 安装 Firefox 构建依赖。对象与原始包在 `upstream/obj-*/dist/`，`package.sh` 将匹配的安装包复制到根目录 `dist/`。

在 Ubuntu/Debian 上，希望安装后从应用菜单启动，可在编译完成后运行 `make package-deb`，生成带图标和独立 profile 的 `.deb` 安装包。安装、升级与便携包用法见 [Ubuntu 应用安装包](distribution.md#ubuntu-应用安装包)。

日常修改 JS、CSS 或资源时，同步增量文件后可执行 faster 构建；修改 JSX 需先重新打包：

~~~bash
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/sync-additions.sh

cd upstream
./mach build faster
~~~

修改 C++、WebIDL 或构建注册时使用完整 `./mach build`；修改接入脚本后还需对源码树执行对应脚本。不要在已打补丁的树上重复运行 `apply-patches.sh`，其 `git apply --index` 不保证重复应用成功。构建与平台限制见 [架构](architecture.md)、[发布流程](distribution.md)；测试入口见 [测试说明](../tests/README.md)。

修改浏览器品牌或 configure 配置后，也应执行常规 `./mach build` 再打包，可继续复用原对象目录。开发 profile 默认保存在对象目录中；执行 `make clean`、`mach clobber` 或删除对象目录前，必须退出浏览器并将完整数据备份到构建树之外，详见 [改名与已有数据](distribution.md#改名与已有数据)。

主要维护区域：

- <code>additions/browser/components/agent-sidebar/</code>：React 侧边栏、Runtime、LLM 适配、工具注册和 Firefox 后端。
- <code>additions/dom/base/</code>：指纹配置与 Navigator 相关接入。
- <code>additions/dom/bindings/</code>：WebAPI 边界观测。
- <code>additions/js/</code>：SpiderMonkey 层的 JSVMP 与执行轨迹能力。
- <code>.github/workflows/release.yml</code>：自动化构建和发布流程。

运行期的环境资料位于用户目录下的专用数据区域，不写入仓库或 Firefox 构建目录。

### 运行终端持续输出 JavaScript error

`JavaScript error: https://…` 表示浏览器加载的网页发生了 JavaScript 异常，并非编译错误。一些页面会主动循环触发异常；例如连续编号的 `Normal Error`、`TypeError`、`Getter Error`。如果页面正常而只有终端刷屏，关闭异常的终端转储即可，开发者工具仍会记录这些异常。

项目默认将 `browser.dom.window.dump.enabled` 设为 `false`。已有 profile 若保留了 `true`，可在 `about:config` 中改为 `false`；使用默认开发 profile 时，也可以运行：

~~~bash
cd upstream
./mach run --setpref browser.dom.window.dump.enabled=false
~~~

需要查看终端异常时，将该偏好改回 `true`。这个开关适用于普通构建；启用 `DEBUG` 或 `MOZ_ENABLE_JS_DUMP` 的构建会强制开启转储。页面卡死、加载失败或接口请求失败时，仍应通过开发者工具检查具体异常。

### 开发首页空白

如果 `./mach run` 打开后只有空白的 New Tab，而侧边栏与普通网页正常，检查开发 profile 是否残留了自动化偏好。在 `about:config` 中将以下两项重置为默认值，然后完整退出并重新启动浏览器：

- `browser.newtabpage.activity-stream.testing.shouldInitializeFeeds`：残留为 `false` 时会阻止首页初始化。
- `services.settings.server`：残留为 `data:,#remote-settings-dummy/v1` 时，远程附件请求会收到空响应，可能出现图标下载的 JSON 解析错误。

同时检查 profile 的 `user.js`，避免重启时重新写入上述测试值。默认开发 profile 位于 `upstream/obj-*/tmp/profile-default/`。自动化验证应使用独立临时 profile，避免影响日常 `./mach run` 的配置。

---

## 模块边界

~~~text
┌──────────────────────────── Web Reverse ────────────────────────────
│
│  React 侧边栏
│  ├─ 会话、模式、工作目录与流式状态
│  ├─ 指纹环境列表、配置编辑与进程状态
│  └─ Provider、模型与显示偏好
│
│  Firefox Host
│  ├─ AgentSession：进程级入口
│  └─ FirefoxAgentRuntimeHost：特权能力、生命周期与上下文适配
│
│  Agent Runtime
│  ├─ AgentRuntimeCore：状态、订阅、确认、取消与线程认领
│  ├─ AgentTurnOrchestrator：单轮编排、持久化、上下文与自动续跑
│  ├─ AgentLoop：模型调用与工具执行闭环
│  └─ UnifiedContext / UnifiedTurnContext：统一日志、任务目标与压缩预算
│
│  LLM Stack
│  ├─ LlmClient / LlmProtocol：稳定入口与协议转换
│  ├─ LlmStreamParser：SSE、文本、推理与工具参数增量
│  └─ LlmRequestExecutor / LlmTransport：请求、超时、重试与宿主网络
│
│  ToolRouter + Backends
│  ├─ 页面、网络、源码、文件、Cookie、扩展、Skills 与记忆
│  ├─ 环境管理、WebAPI、JSVMP、WASM 与白盒诊断
│  └─ MCP Manager / FirefoxMcpService：第三方工具、资源、提示词与授权
│
│  Gecko / SpiderMonkey
│  ├─ FrxFingerprintConfig：进程启动阶段加载指纹配置
│  ├─ JSVMP 与通用 JavaScript 执行轨迹
│  ├─ DOM/WebAPI binding 边界记录
│  └─ 浏览器真值与本地实现的控制流对照
└──────────────────────────────────────────────────────────────────────
~~~

最终交付通常包含两类结果：一套能够重复启动和管理的隔离浏览器环境，以及一份经过真实接口验证、可以脱离浏览器运行的 Node.js 或 Python 实现。
