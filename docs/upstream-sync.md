# 上游同步与基线

当前 Firefox 基线为 `cebc55aab4d2661d1f6c2d1526362947ec4016c1`。`scripts/bootstrap.sh` 默认取此提交；发布工作流的 `FIREFOX_REV` 使用同一值。没有定时跟踪 main/ESR 的自动同步作业。

## 获取源码

在仓库根目录运行 `bash scripts/bootstrap.sh`。脚本执行 `git init`、`fetch --depth 1 origin <ref>` 和 detached checkout；可通过 `UPSTREAM_REPO`、`UPSTREAM_REF`、`UPSTREAM_DIR` 显式覆盖。

若目标目录已有 `.git`，脚本直接跳过，**不会切换到新的 UPSTREAM_REF**。`make reset` 仅清理现有树，不更新基线，还会删除该树的未跟踪文件和本地改动；不要把它当作自动升级命令。

## 在新目录验证升级

先保留当前源码树和对象目录，用一个尚不存在的目录验证候选 ref：

```bash
# 在仓库根目录执行；用实际候选提交替换 <candidate-ref>
UPSTREAM_REF=<candidate-ref> UPSTREAM_DIR=upstream-candidate bash scripts/bootstrap.sh
npm --prefix additions/browser/components/agent-sidebar install
npm --prefix additions/browser/components/agent-sidebar run build
UPSTREAM_DIR="$PWD/upstream-candidate" bash scripts/apply-patches.sh
python3 scripts/apply-phase-b.py upstream-candidate
UPSTREAM_DIR="$PWD/upstream-candidate" bash scripts/build.sh
```

验证目录、对象目录和 profile 应与日常开发隔离。`upstream-candidate/` 不是默认忽略路径，不要把它加入版本控制。

## 需要适配的入口

1. `patches/agent-ui/*.patch` 和 `patches/branding/*.patch`，由 `git apply --index` 顺序应用，不是 `git am`。
2. `scripts/apply-fingerprint-config.py`，由 `apply-patches.sh` 调用，依赖上游 C++/WebIDL/构建文件的文本锚点。
3. `scripts/apply-phase-b.py`，单独接入 Interpreter 与 WebIDL 追踪。
4. `additions/` 内的 Firefox API、resource URL、进程模型和 `moz.build` 注册。

`.patch` 不保证可重复应用；两个 Python 脚本有已应用检测，但上游锚点变化仍需处理。仅通过 patch 检查不证明 Firefox 能编译或探针能工作。

验证完成后再同步更新 bootstrap 的默认 ref 和工作流 `FIREFOX_REV`，保留源码/包版本对应关系。需运行 Node 回归、完整构建、目标平台的原生追踪、环境启动及 MCP 测试，见 [测试入口](../tests/README.md)。

新增补丁仍使用 `patches/<module>/NNNN-short-description.patch`；可在专门的上游开发树中提交变更后使用 `git format-patch` 导出。不要把已经带入的其他模块或生成产物混入补丁。
