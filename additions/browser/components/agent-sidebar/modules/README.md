# Agent 模块目录

按职责组织源码；运行流程见 [Runtime 架构](../../../../../docs/agent-runtime.md)。

| 目录 | 职责 | 主要入口 |
|---|---|---|
| `runtime/` | 平台无关运行时、状态内核、Ports、执行循环与应用编排 | AgentRuntime、AgentTurnOrchestrator、AgentLoop |
| `llm/` | 模型请求、协议转换、SSE、重试、Transport、思考等级和 Usage | LlmClient |
| `providers/` | Provider 元数据、模型配置、Client 构造与侧栏字号偏好 | providers、ConfigStore、SidebarTypography |
| `state/` | 会话持久化、旧数据迁移、统一日志与 token 预算压缩 | ConversationStore、ConversationMigration、UnifiedContext、UnifiedTurnContext |
| `tools/` | 工具声明、注册和派发 | Tools、ToolRouter |
| `backends/` | Firefox/本机能力实现、Actor、工作目录、记忆、Skills、环境管理及原生指纹策略 | Backends、PageBackend、NativeFingerprintPolicy |
| `host/` | Firefox 特权适配和进程级 Runtime 装配 | AgentSession、FirefoxAgentRuntimeHost |

## 源码路径与安装路径

常规模块由父级 `moz.build` 中对应的
`EXTRA_JS_MODULES.agentsidebar.<目录>` 安装到同名子目录。例如：

- 源码：`modules/runtime/AgentRuntime.sys.mjs`
- Firefox：`resource:///modules/agentsidebar/runtime/AgentRuntime.sys.mjs`
- Node 自测：`../modules/runtime/AgentRuntime.sys.mjs`

所有调用方必须使用分组后的路径。旧的扁平 resource URL 已移除；
仓库外的自定义脚本也需迁移，例如 AgentSession 使用
`resource:///modules/agentsidebar/host/AgentSession.sys.mjs`。

## 后续开发

- 新增模块放入职责对应的目录，并在 `moz.build` 的对应分组按大小写无关顺序登记。
- 模块内部使用相对导入，UI/Actor 使用包含目录的 resource URL。
- 修改 JSX 后先运行侧边栏的 `npm run build`，再用项目根目录的
  `bash scripts/sync-additions.sh` 同步到 Firefox 源码树并构建。
- 项目根目录运行 `bash scripts/selftest-agent-tools.sh`，覆盖 Runtime 逻辑、
  模块清单及安装后导入链。

## 压缩与记忆交接

- `state/MemoryContract.sys.mjs` 是摘要和 Ledger 共用的结构化契约。摘要模型输出 JSON：
  `schemaVersion / summary / nextAction / facts / hypotheses / deadends / decisions / artifacts / observations`。
  每项包含 `text / status / evidenceIds`；不再解析 Markdown 标题。
- `fact` 必须显式 `verified` 且有证据；`deadend` 还必须有适用条件。
  产物包含路径及 hash/version。结构校验、日志覆盖校验不能证明结论真实。
- 日志证据入库后用 `threadId + eventId` 定位；外置工具结果的路径和版本从日志提取。
  改变结论通过 `supersedes` 关联旧记忆，旧证据仍保留。
- 压缩状态与 `unifiedContext.memoryOutbox` 在同一次会话保存中提交；
  SQLite 用事务和 `threadId:version` 回执保证重试不重复。失败保留待同步项并提示，
  下次启动本任务或生成检查点时重试；禁止改写到其他工作目录。
- 主库：profile 下 `firefox-reverse-agent/memory.sqlite` 的 `memory_v2` 和
  `memory_batches`；工作目录的 `ledger.md` 为可读镜像。
  旧 `mem` 表保留，历史事实迁移为未验证观察，历史失败路径也标为未验证。
  本次升级不会从旧 Markdown 摘要回填“已验证”记忆。

## 统一入口与完成兜底

- 模型仅使用 `remember / recall`；Notes 工具、后端和自动注入已移除。
  旧 `.frx-notes.ndjson` 文件保留原样，不读取、不迁移、不继续写入。
- 明确的过程事件要求及时 remember：确认入口、验证规则和关键实验、发现失败条件、
  形成影响路线的重要假设/决策、验证产物。没有按工具次数提醒或定期提取。
- recall 默认 `scope=current`；跨目录需 `scope=workspace + workspace` 或 `scope=all`。
  可按类型和状态筛选，结果包含来源工作目录；自动注入始终限于当前目录。
- `CompletionMemory.sys.mjs` 在有实质工具执行的正常结束后检查：
  当前目录没有可用的已验证记录才提取；已有记录即跳过，未验证观察不阻止检查。
  手动取消、普通纯聊天不启动新提取；检查过的日志不会因没有事实而被反复提取。
- 先保存展示最终答复，界面另显记忆整理状态。整理失败或停止不把已完成任务变成失败/取消。
  `thread.memoryCompletion` 保存 pending job、固定日志范围、任务状态快照、提取结果和 checkedThrough。
  下次继续同一任务、同一工作目录时重试；无后台定时重试。
- 从原始持久化日志按预算分块提取，不读取旧思考内容，不改变压缩状态。
  唯一的提取工具 `read_memory_evidence` 只读当前块中事件引用的归档文件；
  每块最多四段、每段最多 2048 字节，完整请求（含工具、思考回灌及输出预留）均检查预算。
  证据读取保留版本和字节范围，不执行网站请求或重新跑实验。
- 共享 MemoryContract 校验，已验证提取记录必须有工具证据；结构有效不代表事实一定正确。
  SQLite 回执使用 `threadId:completion:through`，与压缩批次隔离；镜像写入失败也会提示重试。
  无足够证据允许保存零条已验证记忆。
