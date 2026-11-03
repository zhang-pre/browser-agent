# WebAPI / 属性观测

已实现能力名为 WebAPI trace：`additions/dom/bindings/WebApiTraceCore.cpp/.h`，由 `scripts/apply-phase-b.py` 修改 WebIDL `Codegen.py` 与相关 include/build 清单接入。本目录没有独立 `.patch`。

生成器在符合条件的非静态 method/getter 函数体中注入 RAII 记录，使用 `AutoTraceMethod` / `AutoTraceGetter` 采集接口成员、输入/返回等信息。不能把它表述为任意 JS 对象属性或所有 setter 的追踪。

Agent 通过 `WebApiBackend` 的 `webapi_trace / webapi_query` 控制与查询，可输出环境依赖清单及流程。默认 NDJSON 基路径为 `/tmp/browser-agent-webapi.ndjson`，按 PID 后缀分文件；Windows 使用 TEMP/TMP，环境启动可覆盖输出基路径。查询结果可落入会话工作目录的 `webapi/`。

先确认 Firefox 目标，开启后触发一次并用 `deep_health(engine="webapi")` 检查新增记录。设置成功或旧文件存在不证明本次观测有效。源码与构建边界见 [原生能力](../../docs/agent-native-capabilities.md)。
