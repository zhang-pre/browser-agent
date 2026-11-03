# Web Reverse Windows v0.24.1 候选包记录

生成日期：2026-10-31。平台：Windows x64。BuildID：`20261031120104`（UTC）。浏览器引擎版本：`153.0a1`。

产物位于 `dist/windows/20261031120104/`。此目录记录本地候选包的构建和验证结果；尚未上传 GitHub。

| 文件 | 大小（字节） | SHA256 |
| --- | ---: | --- |
| `web-reverse-v0.24.1-windows-x86_64.exe` | 121028794 | `703c2fcdc1e7db1e1d43b970e1ef29774f82e1cdd0585646616cda475ad2869f` |
| `web-reverse-v0.24.1-windows-x86_64.zip` | 186232690 | `7b154896aac9732baa746f6f05ef9c27836c9d27c65674e5e48c2318093b25c7` |

验证结果：

- 外层安装 EXE、内层 setup、浏览器、隐私浏览代理、桌面启动器和卸载辅助程序的 ProductName 均为 Web Reverse；外层图标四种尺寸与项目图标一致。
- Windows 原生启动、截图、品牌资源、侧栏入口和实际渲染的侧栏标题检查通过。
- 使用临时 profile 读取旧配置与旧会话，验证旧导入格式、文件读写、模型配置和会话的跨重启保存；保留原数据根目录，没有生成分离的新数据目录。
- SQLite 读写、去重、工作区隔离、保留规则和参数校验通过。
- 使用模拟模型验证 Agent 工具调用及自动继续；页面导航、点击和本地 HTTP 请求捕获通过。未进行真实模型服务调用。
- 内置 Node.js 24.22.2、npm 11.19.1、Python 3.14.10、pip 26.2.2，以及工作目录和脚本同目录模块导入检查通过。
- EXE 中的 2566 个应用文件与便携 ZIP 逐文件 SHA256 一致；本机报告同时绑定此 ZIP、EXE 和内层 setup 的哈希。

安装器显示值使用 Web Reverse；默认安装位置、内部注册键、App ID 和配置标识保留，以继续识别原 profile。本次验证使用临时目录，没有覆盖安装现有程序。

完整记录：[构建信息](BUILD-INFO.json)、[Windows 原生验证](WINDOWS-NATIVE-REPORT.json)、[文件属性](WINDOWS-FILE-PROPERTIES.json)、[安装载荷比对](INSTALLER-PAYLOAD-REPORT.json)。旧候选包记录保留在 [改名前的记录](../windows-v0.24.1/README.md)。构建步骤见[分发文档](../../distribution.md)。

源码基线：`234a7d4e421b7fdb79ffc611246489bebb23aeb7`；Firefox 上游：`cebc55aab4d2661d1f6c2d1526362947ec4016c1`。工作区改动由产物目录中的 SOURCE-CHANGES.patch 记录。此候选包尚未数字签名，沿用项目现有 Phase B 原生追踪配置。
