# JSVMP 原生追踪

当前实现是 `additions/js/src/vm/JsvmpTraceCore.cpp/.h`，由 `scripts/apply-phase-b.py` 接入 `Interpreter.cpp` 与构建清单。本目录没有 `.patch`；早期 `additions/js/xpconnect/src/JsvmpTraceHook.cpp` 为 interrupt 路线源码，不是当前 Phase B 的接入方式。

## 执行与控制

`JSVMP_TRACE_OPCODE` 在解释器执行点记录 SpiderMonkey opcode；记录不是直接还原后的虚拟机语义。采集参数、locals、环境链、返回值与虚拟 PC 要结合过滤和目标设置，离线 dispatcher 工具再负责语义分析。

启动参数包括 `MOZ_JSVMP_TRACE`、`MOZ_JSVMP_TRACE_SCRIPT`、`MOZ_JSVMP_TRACE_FILE`、`MOZ_JSVMP_TRACE_LIMIT`，以及 `MOZ_JSVMP_DUMP_*` / `MOZ_JSVMP_VPC_*`。运行期由 `JsvmpBackend` 写控制文件，工具入口是 `jsvmp_trace / jsvmp_status / jsvmp_query`。字段与动作以 `Tools.sys.mjs` 和核心解析代码为准，不使用 TOML。

默认输出 `/tmp/browser-agent-jsvmp-b.ndjson.<pid>`；Windows 用 TEMP/TMP。显式文件基路径仍按进程追加 PID。记录包括 `_meta`、`_script`、opcode、`_args`、`_locals`、`_ret` 等；`sid` 是进程内脚本指针，重启后不可复用。

## 实际限制

- 开启时把 JIT warm-up 阈值限制到解释器；已有热代码可能需重载。它会改变性能和时序，不承诺反调试不可见。
- 当前使用文件写入，不是规划中的 lock-free ring buffer + 后台 writer。
- 没有通用 `goto`、`skip`、`set_return` 或 TOML Hook DSL，也没有实现全 JIT 层逐 opcode 追踪。
- `start` 成功只表示配置写入。先 `deep_target` 确认目标，触发后用 `deep_health(engine="jsvmp")` 确认本次新增记录；导航改变 PID 后需重新设置。

离线工具是 `content/tools/dispatcher_split.cjs`、`dispatcher_probe.cjs` 和 `disassemble.cjs`，由 `jsvmp_split_dispatcher / jsvmp_disassemble` 包装调用。完整使用见 [原生能力](../../docs/agent-native-capabilities.md) 与 [逆向 SOP](../../docs/agent-reverse-sop.md)。
