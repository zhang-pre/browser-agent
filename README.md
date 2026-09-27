<div align="center">

# browser-agent-mcp

**面向网页算法分析的 Firefox 内置 Agent 与隔离环境工具链**

从浏览器内核观测、网络请求定位到 Node.js / Python 独立实现，项目将分析、验证和交付串成一条可持续执行的工作流；同时提供按 profile 与进程隔离的浏览器环境管理能力。

[项目仓库](https://github.com/zhang-pre/browser-agent-mcp) · [快速开始](#快速开始) · [协作方式](#worker--director-协作) · [工具清单](#68-项内置工具) · [源码构建](#源码构建)

</div>

---

## 项目定位

网页请求中的 sign、token、设备特征或风控字段，往往不是固定值，而是由混淆 JavaScript、JSVMP 字节码、WASM 模块以及浏览器状态共同计算。要把这类请求迁移到浏览器之外，分析者不仅要找到生成入口，还需要复原运行上下文，并用真实接口响应验证结果。

browser-agent-mcp 将这些环节放进 Firefox 侧边栏中的常驻 Agent。它可以连续完成网络流量记录、代码检索、内核探针观测、运行环境重建、脚本生成和接口回放，最终产出能够在 Node.js 或 Python 中独立执行的实现。

项目还包含指纹环境管理器。每个环境绑定自己的 Firefox profile、浏览器进程与 Marionette 端口，Cookie、缓存、站点存储和配置分别持久化；创建、导入、编辑、启动和销毁均可从侧边栏或工具接口完成。

这里的核心差异不是“让 AI 操作网页”，而是让分析探针进入 SpiderMonkey 与 Gecko：签名函数参数、JSVMP 指令轨迹、WASM import 边界以及浏览器与本地复刻之间的分支偏差，都可以在 C++ 层采集。由于不依赖页面脚本中的 monkey patch，普通反射与常见反调试逻辑更难干扰观测结果。

## 两个任务同时运行（并发 MVP）

每个任务使用一个**独立 Firefox 环境进程、profile 和 Marionette 端口**。普通“新建窗口”或新标签页仍可能属于同一个父进程，不能用来隔离任务。

1. 在环境管理器里先配置并依次打开环境 A、B，确认它们使用不同 profile 和端口。
2. 在 A 自己的侧栏创建会话、选择已存在的工作目录 A；在 B 自己的侧栏选择另一个目录 B，分别启动任务。无需 Orchestrator 或自动调度。
3. 任务期间不要手动浏览、切页、导航、打开调试器或修改环境配置。日常浏览请使用另一个浏览器（例如 Chrome）。两个任务也不要使用相同的本地服务端口或外部共享文件。

运行规则：

- 一个 Firefox **进程生命周期只服务一个会话和一个工作目录**；同一会话可以多轮继续。第二个会话、重入运行、准备期间的工具直调直接拒绝，不排队。阶段暂停仍保留目录占用。
- 同一 OS 用户下，工作目录经过真实路径规范化；相同目录、父子目录、符号链接别名冲突直接拒绝。登记库在 `~/.firefox-reverse/worker-claims.sqlite`，进程退出后才回收占用；无法确认进程已退出时保守拒绝。不要在环境运行时移动、重新链接工作目录或清理登记库。
- 手动停止、页面工具执行超时或本地执行超时后，必须关闭并重启该环境，再继续原会话。仅关闭侧栏不算重启；profile、对话和文件保留，原页面内存状态不会恢复。
- MVP 不支持任务留下后台进程、守护服务或 detached 子进程。运行提示已声明此限制，执行工具负责回收直接管理的子进程；这不是针对任意 shell 行为的系统沙箱。后台服务需用户在任务之外管理。若操作系统强杀或崩溃导致 Firefox 来不及清理，请先确认其子进程已退出，再复用工作目录。
- Agent 不能通过环境管理工具启动、修改或关闭其他环境；在开始前手动完成配置。UI 环境管理操作仍由用户负责，不要在任务期间改动运行环境。
- Git 请手动准备独立 clone 或不同分支的 worktree；不自动创建、合并 worktree。不要同时对共享 Git 元数据执行 `reset`、`gc`、删除分支或改写公共引用。需要这些操作时先停止相关环境。

Runtime、ToolRouter、网络采集、脚本语料和 Debugger 仍在各自进程内共享；安全边界是**独立进程 + 专用 profile + 独立目录**。浏览器二进制和只读源码可以共享，API 账号的速率配额仍需两个任务共同遵守。本次验证覆盖 Linux 的同机多进程；不承诺跨机器、Windows/WSL 混跑或网络文件系统上的目录互斥。

验证入口：`node additions/browser/components/agent-sidebar/dev/selftest-worker-concurrency.mjs`；构建后执行 `python3 scripts/test-worker-concurrency.py --rounds 30`。后者使用临时 profile、本地测试页面和确定性模型替身，不消耗模型 API 额度。

## 能力概览

| 能力域 | 提供的能力 |
|---|---|
| 自主任务执行 | 父进程 Agent 可持续调用 68 项工具，侧边栏关闭、重载或切换标签页不会终止任务 |
| 内核级分析 | 覆盖签名入口、闭包值、JSVMP 指令、WASM 边界、WebAPI 使用情况以及执行分支对比 |
| 双模型协作 | worker 负责高频工具操作，director 负责阶段规划、审阅结论和调整方向 |
| 环境隔离 | 每个环境独占 profile、进程和 Marionette 端口，并支持指纹配置的生成、导入与维护 |
| 模型接入 | 支持 DeepSeek、GLM、Kimi、MiniMax、Qwen、Claude、OpenAI，以及兼容 OpenAI 或 Anthropic 协议的端点 |
| 本地状态管理 | 会话、命名模型配置、工作产物、阶段笔记和 SQLite 记忆均在本机保存 |
| 扩展与 Skills | 可发现用户或工作区 Skill，并通过 Firefox 原生 AddonManager 管理 AMO 扩展 |

---

## 快速开始

### 1. 打开侧边栏

启动浏览器，点击右上角的 browser-agent-mcp 星光入口。若入口未显示，先通过地址栏附近的侧栏按钮展开浏览器侧栏。

### 2. 建立模型配置

在 Agent 面板右上角打开设置，新建一个命名配置并填写 Provider、API Key、模型与思考等级。同一 Provider 可以保存多套账号或端点，切换后从下一轮请求开始生效。

低复杂度目标可以优先使用速度快、成本低的模型；遇到大型站点、长上下文或复杂控制流时，建议改用能力更强的模型，减少重复探索。

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

## 68 项内置工具

工具由 <code>Tools.sys.mjs</code> 统一声明，下面的数量与当前注册表一致。

| 分类 | 工具接口 | 用途 |
|---|---|---|
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
| Skills 与记忆（7） | <code>skill_list skill_get skill_read_resource notes_add notes_get remember recall</code> | 发现和读取 Skill、记录阶段信息并维护跨会话知识 |
| 指纹环境（18） | <code>env_current env_current_process env_read_current_process_config env_write_current_process_config env_reset_current_process_default env_list env_status env_create env_update env_open env_close env_read_config env_write_config env_generate_fingerprint env_capture_fingerprint env_import_fingerprint env_import env_delete</code> | 查询主进程与当前环境，维护生命周期，并读写、生成、采集或导入指纹配置 |

---

## 源码构建

仓库保存的是应用到 Firefox 源码树上的增量内容，主要代码位于 <code>additions/</code>。首次构建需要先准备锁定版本的 Firefox 源码：

~~~bash
bash scripts/bootstrap.sh
bash scripts/apply-patches.sh

cd upstream
./mach build
./mach package
~~~

日常开发不需要反复应用完整补丁。修改 <code>additions/</code> 后同步增量文件，再执行 faster 构建：

~~~bash
bash scripts/sync-additions.sh

cd upstream
./mach build faster
~~~

主要维护区域：

- <code>additions/browser/components/agent-sidebar/</code>：React 侧边栏、Runtime、LLM 适配、工具注册和 Firefox 后端。
- <code>additions/dom/base/</code>：指纹配置与 Navigator 相关接入。
- <code>additions/dom/bindings/</code>：WebAPI 边界观测。
- <code>additions/js/</code>：SpiderMonkey 层的 JSVMP 与执行轨迹能力。
- <code>.github/workflows/release.yml</code>：自动化构建和发布流程。

运行期的环境资料位于用户目录下的专用数据区域，不写入仓库或 Firefox 构建目录。

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
│  └─ AgentLoop：模型调用与工具执行闭环                                     │
│                                                                           │
│  LLM Stack                                                                │
│  ├─ LlmClient / LlmProtocol：稳定入口与协议转换                           │
│  ├─ LlmStreamParser：SSE、文本、推理与工具参数增量                        │
│  └─ LlmRequestExecutor / LlmTransport：请求、超时、重试与宿主网络         │
│                                                                           │
│  ToolRouter + Backends                                                    │
│  ├─ 页面、网络、源码、文件、Cookie、扩展、Skills 与记忆                   │
│  └─ 环境管理、WebAPI、JSVMP、WASM 与白盒诊断                             │
│                                                                           │
│  Gecko / SpiderMonkey                                                     │
│  ├─ FrxFingerprintConfig：进程启动阶段加载指纹配置                        │
│  ├─ JSVMP 与通用 JavaScript 执行轨迹                                     │
│  ├─ DOM/WebAPI binding 边界记录                                           │
│  └─ 浏览器真值与本地实现的控制流对照                                      │
└───────────────────────────────────────────────────────────────────────────┘
~~~

最终交付通常包含两类结果：一套能够重复启动和管理的隔离浏览器环境，以及一份经过真实接口验证、可以脱离浏览器运行的 Node.js 或 Python 实现。
