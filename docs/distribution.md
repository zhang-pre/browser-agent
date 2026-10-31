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
| `scripts/package-linux-deb.py` | 将 Linux tar.xz 转为带菜单入口、图标、独立 profile 的 `.deb`，并生成 SHA256 校验文件 |
| `scripts/build-linux-arm64.sh`、`configs/mozconfig.linux-arm64` | 独立 Linux arm64 构建路径，不在 release 工作流矩阵中 |
| `scripts/repack-zh-cn.sh`、`verify-zh-cn-stage.sh` | 简体中文重打包与 stage 检查 |
| `scripts/macos-adhoc-sign-apps.sh`、`macos-verify-dmg.sh` | macOS ad-hoc 签名与包检查 |

没有承诺可下载的 patched-source 包；如果实际 Release 只有二进制，使用仓库构建路径。

### Ubuntu 应用安装包

已经编译完成时，在 Ubuntu/Debian 的仓库根目录执行（包括 WSL Ubuntu）：

```bash
make package-deb
```

此命令先运行 `mach package`，再生成 `dist/browser-agent-mcp_<引擎版本>+build<BuildID>_<架构>.deb`。它不重新编译 C++ 或构建 React；修改源码后应先完成相应构建。打包需要 Python 3.12+、`dpkg-dev`、`binutils`，不需要 root。支持在 amd64/arm64 主机上打包相同架构的浏览器；系统库依赖和最低版本由本机 `dpkg-shlibdeps` 从 ELF 产物计算，不能据此承诺兼容更老的 Ubuntu。

已有便携包时可以直接转换，避免重复打包：

```bash
python3 scripts/package-linux-deb.py dist/firefox-153.0a1.en-US.linux-x86_64.tar.xz
```

若 `dist/` 有多个 Linux tar.xz，必须指定具体输入；可用 `make package-deb LINUX_PACKAGE=/absolute/path/package.tar.xz`，或直接运行上述 Python 命令。`--output-dir` 可指定 `.deb` 输出目录。包版本取自实际产物中的 `application.ini`，不是当前源码的 Agent 版本。

安装时将以下路径换成实际输出文件名：

```bash
sudo apt install ./dist/browser-agent-mcp_<版本>_amd64.deb
browser-agent-mcp
```

安装后可以从应用菜单打开 **Browser Agent MCP**。程序文件在 `/opt/browser-agent-mcp/`，命令在 `/usr/bin/browser-agent-mcp`；默认 profile 在 `${XDG_CONFIG_HOME:-$HOME/.config}/browser-agent-mcp/profile`。可设置 `BROWSER_AGENT_PROFILE`，或显式传入 `-profile /absolute/path` 使用其他 profile。安装版设置独立的 Firefox remoting 名称，避免接入系统 Firefox 进程；不自动迁移开发 profile，也不自动设为系统默认浏览器。WSL 图形启动需要 WSLg 或可用的图形显示环境。

安装版禁用 Mozilla 自动更新，后续用新生成的 `.deb` 升级，保留定制内核与侧边栏。`run_node`、`npm_install`、`run_python` 等功能仍需要系统中的 Node.js/npm/Python；这些运行时不嵌入浏览器包。卸载使用 `sudo apt remove browser-agent-mcp`，用户 profile 会保留。

同时生成的 `firefox-*.tar.xz` 是便携包：解压后运行 `firefox/firefox`，需保留完整目录，不能只复制其中一个 ELF 可执行文件。便携包直接使用原始 Firefox 启动方式，不包含 `.deb` 的 profile 启动脚本或更新策略。

### Windows x64 安装包

在已准备 Firefox 源码树的 Linux/WSL 主机上，使用独立的 Windows 对象目录交叉编译，不复用 Linux 二进制：

```bash
sudo apt install msitools nsis libc6-i386 lib32gcc-s1 lib32stdc++6
rustup target add x86_64-pc-windows-msvc
make package-windows
```

`scripts/build-windows-x64.sh` 构建侧栏、同步 additions、执行原生接入脚本，随后使用 `configs/mozconfig.windows-x64` 下载 Windows SDK/工具链并编译、打包。默认使用 6 个编译任务，可通过 `BUILD_JOBS` 调整。首次编译会下载较大的工具链，耗时明显长于前端增量构建。

产物位于 `dist/windows/<BuildID>/`：

- `browser-agent-v<版本>-windows-x86_64.exe`：完整安装包，安装后从开始菜单打开 Firefox Reverse。
- 同名 `.zip`：便携包，完整解压后运行 `firefox/firefox.exe`。
- `SHA256SUMS`、`BUILD-INFO.json`、`README-WINDOWS.md`：校验值、构建来源与用户说明。
- 工作区存在未提交改动时，另附 `SOURCE-CHANGES.patch`，避免把候选包误标为完全对应某个提交。

Windows 配置显式启用 `--with-redist`，随应用携带 VC 运行库 DLL。包内还包括独立的 Node.js/npm 和 Python/pip，下载版本与 SHA256 固定在 `configs/windows-runtimes.json`。Agent 只为自身进程追加私有运行时目录，不修改系统 PATH；用户显式配置的解释器路径仍优先。Python 额外依赖默认落在当前工作目录的 `.python-packages`，也支持导入工作目录和脚本目录中的模块。

整理产物时会检查 ZIP 完整性、Windows x64 可执行文件、当前 AgentLoop/后端模块、新 logo 和运行时清单。原生 Windows 启动验证是单独步骤，不能用交叉编译成功替代。此构建不执行代码签名。GitHub 发布前应提交对应源码并记录原生验证结果。

此路径执行现有 Phase B 接入脚本，沿用其关闭 Windows 内容进程沙箱的行为，以允许原生追踪写入临时文件。候选包的用户说明会明确记录这一构建取舍。

本次产物的校验值与原生验证结果见 [Windows v0.24.1 候选包记录](releases/windows-v0.24.1/README.md)。

## 包验证

- `.github/workflows/validate-windows-package.yml` 是独立手动作业，输入候选 Release tag、SHA256、SourceStamp 和 BuildID，用 `scripts/verify-windows-package.py` 在 Windows 启动候选包并检查结果。
- Linux 包检查使用 `scripts/verify-linux-package.sh`。
- macOS 使用签名/DMG 验证脚本；签名检查不能替代原生功能测试。

不要把 Node 自测通过、某次历史平台验证或上传成功当作新候选包完成验收。测试层次见 [tests/README.md](../tests/README.md)，历史变更保留在 [CHANGELOG](../CHANGELOG.md)。
