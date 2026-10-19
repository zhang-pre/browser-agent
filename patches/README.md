# patches

`scripts/apply-patches.sh` 按以下顺序遍历模块，用 `git apply --index` 应用其中的 `.patch`；没有补丁的目录会跳过。

1. `property-trace`
2. `network-analysis`
3. `cookie-js-analysis`
4. `fingerprint`
5. `proxy`
6. `jsvmp-trace`
7. `agent-ui`
8. `branding`

当前 `.patch` 文件位于 `agent-ui/` 和 `branding/`。其他模块说明对应的功能可能已经在 additions 的 JS 后端或 Python 接入脚本实现，并不表示都在等待开发。

补丁之后，脚本调用 `sync-additions.sh` 和 `apply-fingerprint-config.py`。JSVMP/WebAPI 原生追踪还需单独执行 `python3 scripts/apply-phase-b.py upstream`；它不在 `apply-patches.sh` 调用链内。

## 维护

文件命名为 `NNNN-short-description.patch`。在专用上游开发树提交后可用 `git format-patch` 生成补丁，但仓库脚本只应用 diff，不重放提交元数据。已应用树上不要重复执行整套 `git apply --index`。

新增补丁目录还需更新应用顺序；当前编译与升级入口见 [源码构建](../README.md#源码构建)、[上游同步](../docs/upstream-sync.md)。
