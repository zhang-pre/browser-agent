# 构建产物与发布

发布自动化位于本仓库 [release.yml](../.github/workflows/release.yml)，不要求另取私有 build 仓库。工作流是实现事实；仓库当前可见性和某个 Release 是否已发布不能从源码判断。

## 发布工作流

仅通过 `workflow_dispatch` 手动触发，输入 `release_tag`（项目版本形如 `v0.24.1`）和可选 `build_all`。推 tag 不自动运行。

- `create-release` 创建/更新草稿；tag 含 `-` 时标记 prerelease。
- `build-mac` 使用自托管 runner，复用固定位置的已准备 Firefox 树。检查锁定基线与 Agent 父级注册，构建 React bundle、同步 additions，分别在 arm64/x86_64 对象目录构建与打包，并验证架构及 DMG 签名。
- macOS 资产命名为 `browser-agent-<tag>-macos-arm64.dmg` 和 `browser-agent-<tag>-macos-x86_64.dmg`。arm64 的 `mozconfig.mac` 来自预备树，Intel 配置在 `configs/mozconfig.macos-x64`。
- `build_all=true` 才启用托管 Windows/Linux 从零构建，作业设置 `continue-on-error: true`。上传使用 mach 原始包名；失败不阻止 macOS 作业。

自托管作业依赖已经打好原生接入的树，并不重新执行所有 Python 接入脚本。可选 Windows/Linux 路径目前也没有 React bundle 构建和 Phase B 接入步骤，不能据该作业存在就认定完整分析能力已经验收。发布前应核对实际包内资源与原生记录。

当前工作流不生成 patched-source tarball、`SOURCES.md` 或每个安装包的 SHA256 文件，也不自动把草稿转成正式发布。早期文档中的这些项目属于未实现的发布设想。

## 本地构建与打包

从仓库源码构建的完整步骤见 [README](../README.md#源码构建)。主要产物位置：

| 路径/脚本 | 作用 |
|---|---|
| `upstream/obj-*/dist/` | mach 构建与打包输出 |
| `scripts/package.sh` | 调用 `mach package`，复制匹配的 `firefox-*` tar.xz/dmg/zip/exe/deb 到根目录 `dist/`；可用 `DIST_DIR` 覆盖 |
| `scripts/build-linux-arm64.sh`、`configs/mozconfig.linux-arm64` | 独立 Linux arm64 构建路径，不在 release 工作流矩阵中 |
| `scripts/repack-zh-cn.sh`、`verify-zh-cn-stage.sh` | 简体中文重打包与 stage 检查 |
| `scripts/macos-adhoc-sign-apps.sh`、`macos-verify-dmg.sh` | macOS ad-hoc 签名与包检查 |

没有承诺可下载的 patched-source 包；如果实际 Release 只有二进制，使用仓库构建路径。

## 包验证

- `.github/workflows/validate-windows-package.yml` 是独立手动作业，输入候选 Release tag、SHA256、SourceStamp 和 BuildID，用 `scripts/verify-windows-package.py` 在 Windows 启动候选包并检查结果。
- Linux 包检查使用 `scripts/verify-linux-package.sh`。
- macOS 使用签名/DMG 验证脚本；签名检查不能替代原生功能测试。

不要把 Node 自测通过、某次历史平台验证或上传成功当作新候选包完成验收。测试层次见 [tests/README.md](../tests/README.md)，历史变更保留在 [CHANGELOG](../CHANGELOG.md)。
