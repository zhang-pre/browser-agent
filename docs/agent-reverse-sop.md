# Agent 逆向 SOP

这是与当前工具实现对应的通用流程。完整工具表见 [README](../README.md#内置工具)，本地能力开关见 [侧边栏](agent-sidebar.md)。内置运行时 Skill 的实际正文位于 `additions/browser/components/agent-sidebar/content/skill-reverse.md`；本文不是自动注入的 Skill 副本。

## 明确现场和验收

记录目标页面、接口、待分析字段、允许的操作与期望产物。区分「在 Node/Python 中加载原载荷的可运行版本」与「不依赖原载荷的独立算法版本」，按用户验收要求推进。

本地常规开启时可用 `recall` 读取当前工作目录已有记忆，再验证其适用性。关闭时普通页面/网络/源码操作依赖已连接 MCP，不能照搬不可见的本地工具名。Firefox 原生探针与 MCP 服务管理的浏览器是不同现场。

## 定位请求和生成代码

1. 先确认页面与目标请求，开启捕获后触发一次。
2. `net_list / net_get` 可取得 URL、方法、状态、请求/响应头及尽力获取的发起栈。**不包含请求或响应正文**；需要正文时从有相应能力的 MCP/调试工具或明确的页面调用点另取。
3. `scripts_list` 按分页列外部脚本，`scripts_save / scripts_capture_all` 保存可抓取的源码，再用 `code_search / find_param_entry` 查线索。不会自动覆盖所有 eval/Worker 代码。
4. 参数名搜不到不能证明没有生成逻辑，可能是动态拼接。根据缺失证据选择运行时调用、闭包、网络或原生观察，而不是重复全量搜索。

## 按证据需要选择观测

普通混淆可用页面/调试工具查看函数、参数与闭包。JSVMP 可结合 dispatcher 拆解、反汇编和有限动态 trace；WASM 可用 probe、WAT 与分支对照。`hook_inject` 是页面注入，`signer_trace / closure_read` 使用调试通道，不能统一称为不可检测的 C++ 操作。

Firefox 原生观测流程：

1. `deep_target` 确认 targetId、documentId、PID、ready，必要时 `deep_run` 加载目标并再次确认。
2. 开启窄范围 `jsvmp_trace` 或 `webapi_trace`，触发一次目标行为。
3. `deep_health` 检查当前 PID 的本次新增记录，随后查询、保存和停止。
4. 没有新增记录时，仅作一次有依据的目标/PID/过滤条件修正再试；仍失败则记录限制并换路线。导航更换 PID 需要重开观测。

JSVMP 追踪限制 JIT，会影响时序；源码复制到磁盘不意味着已经在目标页面执行。现有离线脚本位于 `content/tools/*.cjs`，优先通过 `jsvmp_split_dispatcher / jsvmp_disassemble / wasm_probe / wasm_disasm / whitebox_diff` 等包装工具调用。

## 构建可验证产物

先还原请求模板及必要输入，在工作目录建立最小可运行版本，用真实接口结果验证。Cookie/令牌等外部输入需说明来源、时效与依赖；不能将浏览器临时生成签名当成脱离浏览器的实现。

根据用户要求继续提取独立算法，用浏览器/原载荷结果做对照，保留输入、输出、环境与验证条件。HTTP 状态成功不等于业务结果有效，需核对预期数据。失败实验仅排除已测试的输入和环境，不应扩大为整条路线不可能。

## 产物与记忆

大源码、trace、WAT 和字节码先落盘，再用分段读取或脚本提取摘要。调用结果给出的路径和完整性信息应保留；被截断的结果不能当完整证据。

本地常规开启时，关键事实、失败条件、假设、决策与产物用 `remember` 及时保存；默认 `recall` 仅当前目录。verified 事实须有证据，失败条件须写适用范围，产物须有路径和 hash/version。旧 `notes_add / notes_get` 已移除。

结束时报告已确认的生成入口、输入与依赖、产物路径、验证结果，以及仍未确认的部分。详细记忆契约见 [模块说明](../additions/browser/components/agent-sidebar/modules/README.md#压缩与记忆交接)。
