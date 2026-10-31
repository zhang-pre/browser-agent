# Windows v0.24.1 候选包记录

生成日期：2026-10-31。目标平台：Windows x64。BuildID：`20261031032223`（UTC）。

产物保存在 `dist/windows/20261031032223/`，EXE/ZIP 作为 GitHub Release 附件分发。此记录保存构建来源、校验值与实际验证结果。

| 文件 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| `browser-agent-v0.24.1-windows-x86_64.exe` | 120913577 | `a10993e3345b804b85d6e0fc47f80f47f19a145e9072f9f631b7294f55dd10e3` |
| `browser-agent-v0.24.1-windows-x86_64.zip` | 186232163 | `b44c61ab2816d8b4c0ba5271689c8e3992a47b7afedcea50a122b4d24539ddc4` |

包含新图标和全自动模式续跑修复，以及 VC 运行库、Node.js 24.22.2、npm 11.19.1、Python 3.14.10、pip 26.2.2。

验证结果：

- 原生 Windows 启动、页面渲染与正常退出通过。
- Ledger 读写、去重、工作区隔离、记录保留与参数校验通过。
- 包内 AgentLoop 自动续行回归通过，使用模拟模型响应验证工具调用流程。
- 通过应用后端执行内置 Node/npm、Python/pip，并验证工作目录和脚本同目录模块导入。
- 安装包与便携 ZIP 的 2,566 个文件逐一比较，内容一致。

完整记录见 [构建信息](BUILD-INFO.json)、[Windows 原生验证](WINDOWS-NATIVE-REPORT.json) 和 [安装包内容验证](INSTALLER-PAYLOAD-REPORT.json)。构建步骤见[分发文档](../../distribution.md)。

构建时源码基线为 `ab66b94ee9134d6d148bae95bef7871e3595feaa`，Firefox 上游为 `cebc55aab4d2661d1f6c2d1526362947ec4016c1`。包内 SourceStamp 保留构建时基线，随包的 `SOURCE-CHANGES.patch` 记录当时工作区变更；这些源码变更随后分开提交。

此候选包尚未代码签名、尚未上传 GitHub，沿用项目 Phase B 关闭 Windows 内容进程沙箱的原生追踪配置。
