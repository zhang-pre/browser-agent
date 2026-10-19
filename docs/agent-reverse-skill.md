# 逆向 Skill 与运行时提示词

当前内置 Skill 正文在 [content/skill-reverse.md](../additions/browser/components/agent-sidebar/content/skill-reverse.md)，由 `SkillBackend` 提供。本文维护 Skill 的接入关系，不再复制一份容易滞后的方法论正文。

- `skill_list` 发现内置、用户或工作区 Skill，`skill_get` 按需读取正文，`skill_read_resource` 读取其资源；未指定名称时仍兼容内置逆向 Skill。
- 实际基础提示词与执行流程由 `AgentLoop`、`AgentTurnOrchestrator` 和会话配置组合，不能把旧草案中的建议当作所有模式的硬性步骤。
- `localToolsEnabled=false` 时不提供 Skill 工具/目录、旧阶段门或记忆注入，使用 `LocalCapabilityPolicy` 中的提示词；普通操作通过 MCP，原生深度工具另有 Firefox 目标和健康检查流程。
- 记忆统一使用 `remember / recall`。旧 Notes 工具和自动注入已移除，旧文件不迁移。事实、失败条件和产物按 [记忆契约](../additions/browser/components/agent-sidebar/modules/README.md#压缩与记忆交接) 记录。
- 网络、脚本和原生追踪的实际限制见 [功能清单](features.md)，当前建议工作流见 [逆向 SOP](agent-reverse-sop.md)。例如 `net_get` 不提供 body，不能按旧草案直接从它获得完整请求模板。

更新方法论时同时核对工具注册、能力筛选和后端的真实返回字段。文档可描述分析策略，不能把配置成功、猜测或历史结论当成本次执行证据。
