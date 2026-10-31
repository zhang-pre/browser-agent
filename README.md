<div align="center">

# browser-agent-mcp

**面向网页算法分析的 Firefox 内置 Agent 与隔离环境工具链**

从浏览器内核观测、网络请求定位到 Node.js / Python 独立实现，项目将分析、验证和交付串成一条可持续执行的工作流；同时提供按 profile 与进程隔离的浏览器环境管理能力。

[项目仓库](https://github.com/zhang-pre/browser-agent-mcp) · [快速开始](#快速开始) · [协作方式](#worker--director-协作) · [工具清单](#内置工具) · [源码构建](#源码构建) · [第三方 MCP 接入](docs/mcp-client.md)

</div>

---

## 项目定位

网页请求中的 sign、token、设备特征或风控字段，往往不是固定值，而是由混淆 JavaScript、JSVMP 字节码、WASM 模块以及浏览器状态共同计算。要把这类请求迁移到浏览器之外，分析者不仅要找到生成入口，还需要复原运行上下文，并用真实接口响应验证结果。

browser-agent-mcp 将这些环节放进 Firefox 侧边栏中的常驻 Agent。它可以连续完成网络流量记录、代码检索、内核探针观测、运行环境重建、脚本生成和接口回放，最终产出能够在 Node.js 或 Python 中独立执行的实现。

项目还包含指纹环境管理器。每个环境绑定自己的 Firefox profile、浏览器进程与 Marionette 端口，Cookie、缓存、站点存储和配置分别持久化；创建、导入、编辑、启动和销毁均可从侧边栏或工具接口完成。

项目在 SpiderMonkey 解释器和 Gecko WebIDL 边界接入 C++ 探针，同时结合页面调试、脚本注入和本地 Node 分析。JSVMP/WebAPI 原生记录、签名与闭包调试、WASM 探测和分支对照分别使用不同机制；JSVMP 追踪会限制 JIT 并影响时序，不能将所有工具都理解为页面不可感知的内核采集。

## 能力概览

| 能力域 | 提供的能力 |
|---|---|
| 自主任务执行 | 父进程 Agent 持续执行模型与工具循环，侧边栏关闭或重载不会终止任务；工具目标由会话上下文传递 |
| 内核级分析 | 覆盖签名入口、闭包值、JSVMP 指令、WASM 边界、WebAPI 使用情况以及执行分支对比 |
| 双模型协作 | worker 负责高频工具操作，director 负责阶段规划、审阅结论和调整方向 |
| 环境隔离 | 每个环境独占 profile、进程和 Marionette 端口，并支持指纹配置的生成、导入与维护 |
| 模型接入 | 支持 DeepSeek、GLM、Kimi、MiniMax、Qwen、Claude、OpenAI，以及兼容 OpenAI 或 Anthropic 协议的端点 |
| 本地状态管理 | 会话、命名模型配置、工作产物、统一事件日志和 SQLite 类型化记忆均在本机保存 |
| 扩展与 Skills | 可发现用户或工作区 Skill，并通过 Firefox 原生 AddonManager 管理 AMO 扩展 |

---

## 快速开始

### 1. 打开侧边栏

启动浏览器，点击右上角的 browser-agent-mcp 星光入口。若入口未显示，先通过地址栏附近的侧栏按钮展开浏览器侧栏。

### 2. 建立模型配置

在 Agent 面板右上角打开设置，新建一个命名配置并填写 Provider、API Key、模型与思考等级。同一 Provider 可以保存多套账号或端点，切换后从下一轮请求开始生效。

低复杂度目标可以优先使用速度快、成本低的模型；遇到大型站点、长上下文或复杂控制流时，建议改用能力更强的模型，减少重复探索。

ChatGPT 订阅登录无需填写 API Key，请参阅 [Pi provider 分析与接入说明](docs/pi-provider-chatgpt-subscription.md)。

### 3. 选择执行节奏

创建新会话时选择一种模式：

- **全自动**：给出目标后由 Agent 连续推进，适合边界清晰、可以后台执行的任务。
- **AI 辅助**：Agent 在关键阶段暂停并给出候选方向，由用户或 director 决定下一步，适合复杂目标和教学场景。

### 4. 描述目标与验收条件

推荐同时给出页面、接口、动态字段和最终交付要求。例如：

~~~text
页面地址：https://example.com/list
目标接口：GET https://example.com/api/v1/list?page=1
待还原字段：请求头 X-Sign；同时关注时间戳、token 与设备信息
验收目标：
1. 生成可脱离浏览器运行的 Node.js 实现，并用真实接口返回值验证
2. 在可行时继续整理为不依赖原混淆载荷的纯算法版本
~~~

会话生成的脚本、还原代码、采集结果与分析笔记都会写入该会话绑定的工作目录。

对话页的「本地常规」默认开启；关闭会新建保留工作目录的干净会话，只保留 Firefox 深度分析与文件/执行支持工具，普通操作由已连接 MCP 提供。Firefox 与 MCP 管理的浏览器是不同目标，详见 [侧边栏说明](docs/agent-sidebar.md)。

---

## worker / director 协作

两种运行方式共享同一套工具和持久化数据，区别在于决策由谁驱动。

| 维度 | 全自动 worker | director 引导 |
|---|---|---|
| 推进方式 | worker 自行完成整条执行链 | worker 每完成一个阶段便交回结果 |
| 决策主体 | 当前模型自行规划 | 人类或独立强模型 director |
| 交互频率 | 仅在登录、验证码、业务选择或完成时停下 | 在入口确认、轨迹分析、上下文重建和实现验证等节点停下 |
| 推荐场景 | 目标明确、希望无人值守 | 保护复杂、需要审阅过程或控制模型成本 |

在双模型方案中，便宜且稳定的 worker 承担页面操作、网络读取、代码搜索和脚本执行；能力更强的 director 只消费阶段摘要，负责判断路线、发现偏航并下达下一阶段目标。这样可以把高频工具调用留给低成本模型，同时保留强模型在关键决策上的优势。

配套 MCP 项目使用同一品牌与仓库地址：[browser-agent-mcp](https://github.com/zhang-pre/browser-agent-mcp)。接入后，director 可以检查运行状态、创建工作目录、选择 AI 辅助模式、启动会话、读取阶段结果并继续派发方向。

长工具循环中的 worker 建议选择标准或快速档，例如 deepseek-v4-flash。推理档在连续工具调用场景中可能退化为只输出计划而不继续执行，因而更适合担任 director，而不是承担高频操作。

Windows 上若外部 AI 只显示 open_url，通常说明 MCP 尚未完成初始化。正常顶层入口应包含 frx_status、agent_tools 和 agent_call_tool；具体浏览器工具通过 agent_tools 枚举，再由 agent_call_tool 调度。

---

## 两阶段交付路径

分析过程按“先建立可验证结果，再逐步减少依赖”的顺序推进：

1. **可运行复刻**：在 Node.js 中补齐必要上下文，继续加载原始 JSVMP 或 WASM 载荷；以本地生成参数能够通过真实服务端校验为验收标准。
2. **独立算法实现**：从原载荷中提取核心计算过程，改写为普通代码，使最终实现不再依赖原始虚拟机或二进制模块。

JSVMP 路线提供指令记录、派发器拆分、字节解码和离线反汇编；WASM 路线提供 import 边界探测、WAT 反汇编以及执行分支诊断。两条路线都可以先交付可用版本，再根据需要继续推进白盒化。

---

## 内置工具

工具由 [Tools.sys.mjs](additions/browser/components/agent-sidebar/modules/tools/Tools.sys.mjs) 统一声明，当前共 69 项。声明仅在所需后端存在时注册；会话的「本地常规」开关还会筛选模型可见的工具。连接 MCP 后发现的第三方工具另行加入，不计入此表。

| 分类 | 工具接口 | 用途 |
|---|---|---|
| 原生目标与健康检查（3） | <code>deep_target deep_run deep_health</code> | 确认 Firefox 目标、文档与 PID，加载或触发目标，并检查本次观测是否产生新增记录 |
| 页面交互（9） | <code>page_navigate page_click page_scroll page_type page_eval page_screenshot page_elements page_info page_automation_scan</code> | 页面导航、输入点击、脚本执行、截图、元素读取及自动化特征检查 |
| 网络与入口（5） | <code>net_capture net_list net_get hook_inject find_param_entry</code> | 记录请求、查看详情与调用来源、在 document-start 阶段注入探针并定位动态字段 |
| 源码处理（4） | <code>code_search scripts_list scripts_save scripts_capture_all</code> | 检索语料或工作目录，枚举、采集并保存页面脚本 |
| 签名与闭包（2） | <code>signer_trace closure_read</code> | 从调试通道获取函数实参与闭包中的运行时值 |
| WebAPI 观测（2） | <code>webapi_trace webapi_query</code> | 记录并检索 Navigator、DOM、Canvas 等接口的读取行为 |
| JSVMP 分析（5） | <code>jsvmp_trace jsvmp_query jsvmp_status jsvmp_split_dispatcher jsvmp_disassemble</code> | 采集指令序列、查询状态、拆解派发器并执行离线反汇编 |
| 密码特征（1） | <code>crypto_scan</code> | 搜索 RC4、XXTEA、MD5/SHA、AES、SM4 和自定义 Base64 等常量模式 |
| WASM 分析（2） | <code>wasm_probe wasm_disasm</code> | 检查 import 调用边界并将模块转换为 WAT |
| 分支对照（1） | <code>whitebox_diff</code> | 比较浏览器执行与本地复刻的覆盖范围和控制流差异 |
| JavaScript 轨迹（1） | <code>js_trace</code> | 结合 AST 插桩与 Node.js 执行记录普通函数调用 |
| 执行与文件（8） | <code>run_node run_python npm_install fs_read fs_write fs_list fs_copy fs_mkdir</code> | 在受控工作目录运行程序、安装依赖并维护产物 |
| Cookie（1） | <code>cookies</code> | 通过原生 Cookie 管理器读写数据，包括 httpOnly 项 |
| Firefox 扩展（2） | <code>addons_query addons_manage</code> | 查询 AMO、查看安装状态并执行安装、启停、卸载或打开设置页 |
| Skills 与记忆（5） | <code>skill_list skill_get skill_read_resource remember recall</code> | 发现和读取 Skill，按工作目录保存、检索带状态和证据的类型化记忆 |
| 指纹环境（18） | <code>env_current env_current_process env_read_current_process_config env_write_current_process_config env_reset_current_process_default env_list env_status env_create env_update env_open env_close env_read_config env_write_config env_generate_fingerprint env_capture_fingerprint env_import_fingerprint env_import env_delete</code> | 查询主进程与当前环境，维护生命周期，并读写、生成、采集或导入指纹配置 |

`net_get` 仅返回请求/响应元信息与可获得的调用栈，不采集 body；脚本工具枚举顶层页面外部脚本，不是完整运行时源码目录。原生观测需通过 `deep_health` 确认本次新增记录。`notes_add / notes_get` 已移除，记忆统一使用 `remember / recall`。具体边界见 [功能清单](docs/features.md)。

---

## 源码构建

仓库保存的是应用到 Firefox 源码树上的增量内容，主要代码位于 <code>additions/</code>。以下命令在仓库根目录的 Bash 环境运行，需要 Node.js/npm、Python 3、Git 和 rsync。首次构建先打包 React，再准备锁定版本的 Firefox 源码并接入原生追踪：

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

在 Ubuntu/Debian 上，希望安装后从应用菜单启动，可在编译完成后运行 `make package-deb`，生成带图标和独立 profile 的 `.deb` 安装包。安装、升级与便携包用法见 [Ubuntu 应用安装包](docs/distribution.md#ubuntu-应用安装包)。

日常修改 JS、CSS 或资源时，同步增量文件后可执行 faster 构建；修改 JSX 需先重新打包：

~~~bash
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/sync-additions.sh

cd upstream
./mach build faster
~~~

修改 C++、WebIDL 或构建注册时使用完整 `./mach build`；修改接入脚本后还需对源码树执行对应脚本。不要在已打补丁的树上重复运行 `apply-patches.sh`，其 `git apply --index` 不保证重复应用成功。构建与平台限制见 [架构](docs/architecture.md)、[发布流程](docs/distribution.md)；测试入口见 [测试说明](tests/README.md)。

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
┌──────────────────────────── browser-agent-mcp ────────────────────────────┐
│                                                                           │
│  React 侧边栏                                                             │
│  ├─ 会话、模式、工作目录与流式状态                                        │
│  ├─ 指纹环境列表、配置编辑与进程状态                                      │
│  └─ Provider、模型与显示偏好                                              │
│                                                                           │
│  Firefox Host                                                             │
│  ├─ AgentSession：进程级入口                                              │
│  └─ FirefoxAgentRuntimeHost：特权能力、生命周期与上下文适配                │
│                                                                           │
│  Agent Runtime                                                            │
│  ├─ AgentRuntimeCore：状态、订阅、确认、取消与线程认领                    │
│  ├─ AgentTurnOrchestrator：单轮编排、持久化、上下文与自动续跑             │
│  ├─ AgentLoop：模型调用与工具执行闭环                                     │
│  └─ UnifiedContext / UnifiedTurnContext：统一日志、任务目标与压缩预算     │
│                                                                           │
│  LLM Stack                                                                │
│  ├─ LlmClient / LlmProtocol：稳定入口与协议转换                           │
│  ├─ LlmStreamParser：SSE、文本、推理与工具参数增量                        │
│  └─ LlmRequestExecutor / LlmTransport：请求、超时、重试与宿主网络         │
│                                                                           │
│  ToolRouter + Backends                                                    │
│  ├─ 页面、网络、源码、文件、Cookie、扩展、Skills 与记忆                   │
│  ├─ 环境管理、WebAPI、JSVMP、WASM 与白盒诊断                             │
│  └─ MCP Manager / FirefoxMcpService：第三方工具、资源、提示词与授权       │
│                                                                           │
│  Gecko / SpiderMonkey                                                     │
│  ├─ FrxFingerprintConfig：进程启动阶段加载指纹配置                        │
│  ├─ JSVMP 与通用 JavaScript 执行轨迹                                     │
│  ├─ DOM/WebAPI binding 边界记录                                           │
│  └─ 浏览器真值与本地实现的控制流对照                                      │
└───────────────────────────────────────────────────────────────────────────┘
~~~

最终交付通常包含两类结果：一套能够重复启动和管理的隔离浏览器环境，以及一份经过真实接口验证、可以脱离浏览器运行的 Node.js 或 Python 实现。

## 文档导航

- [架构与数据存储](docs/architecture.md) · [能力与限制](docs/features.md) · [当前状态与后续工作](docs/roadmap.md)
- [侧边栏](docs/agent-sidebar.md) · [Runtime](docs/agent-runtime.md) · [原生能力](docs/agent-native-capabilities.md)
- [环境管理](docs/fingerprint-environment-manager.md) · [原生一致指纹](docs/native-fingerprint-consistency.md) · [配置示例的适用范围](settings/README.md)
- [逆向 SOP](docs/agent-reverse-sop.md) · [测试入口](tests/README.md) · [上游同步](docs/upstream-sync.md) · [发布流程](docs/distribution.md)
