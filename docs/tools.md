# 内置工具

工具由 [Tools.sys.mjs](../additions/browser/components/agent-sidebar/modules/tools/Tools.sys.mjs) 统一声明，当前共 69 项。声明仅在所需后端存在时注册；会话的「本地常规」开关还会筛选模型可见的工具。连接 MCP 后发现的第三方工具另行加入，不计入此表。

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

`net_get` 仅返回请求/响应元信息与可获得的调用栈，不采集 body；脚本工具枚举顶层页面外部脚本，不是完整运行时源码目录。原生观测需通过 `deep_health` 确认本次新增记录。`notes_add / notes_get` 已移除，记忆统一使用 `remember / recall`。具体边界见 [功能清单](features.md)。
