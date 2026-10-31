# 测试入口与覆盖范围

实际测试在 `additions/browser/components/agent-sidebar/dev/` 和 `scripts/tests/`，以及 `scripts/selftest-fingerprint-config.py`。本目录没有早期规划的 fingerprint/proxy/jsvmp 等集成测试子目录。

## 常规回归

在仓库根目录、具备 Node.js/npm 与 Bash 的开发环境运行：

```bash
npm --prefix additions/browser/components/agent-sidebar install
bash scripts/selftest-agent-tools.sh
```

脚本先构建侧栏 bundle，再执行 `SELFTESTS` 数组里的 Node 自测，最后检查产品名与品牌资源。每个数组项经 `scripts/tests/register-product-name.mjs` loader 启动。覆盖 Runtime、模型请求/流、会话/统一上下文、记忆、工具路由、MCP、环境及安装清单等；清单以脚本为准，不代表 `dev/` 下每个自测都会被执行。

这些测试默认不请求真实模型，不启动 Firefox UI。少数 MCP 测试使用本地 fixture/子进程，需要相应本机运行条件。

## 额外定向测试

以下文件已存在，但当前不在主脚本的 `SELFTESTS` 中，可单独执行。命令中的 `node` 路径和工作目录需按开发环境调整。

```bash
node --import ./scripts/tests/register-product-name.mjs additions/browser/components/agent-sidebar/dev/selftest-local-capabilities.mjs
node --import ./scripts/tests/register-product-name.mjs additions/browser/components/agent-sidebar/dev/selftest-native-health.mjs
node --import ./scripts/tests/register-product-name.mjs additions/browser/components/agent-sidebar/dev/selftest-deep-runtime.mjs
node --import ./scripts/tests/register-product-name.mjs additions/browser/components/agent-sidebar/dev/selftest-backend-evidence.mjs
```

单独的 LLM 请求构造检查是 `node additions/browser/components/agent-sidebar/dev/selftest-llm.mjs`，默认 dry-run；`--live` 才发真实请求，使用 `DEEPSEEK_API_KEY` 环境变量。

## 原生配置与音频

```bash
FRX_UPSTREAM_DIR=/path/to/gecko python3 scripts/selftest-fingerprint-config.py
c++ -std=c++17 -Wall -Wextra -Werror -I additions/dom/media/webaudio \
  scripts/tests/offline-audio-transform.cpp -o /tmp/frx-offline-audio-test
/tmp/frx-offline-audio-test
```

指纹测试用窄 XPCOM/pref stubs 和上游 JsonCpp 编译实际 reader；需要 C++ 工具链和可用上游树。它不能替代完整 Gecko ABI、跨进程、Windows 与实际浏览器验收。

## 真实 Firefox 与安装包

- MCP stdio/HTTP、roots 与凭据测试：`dev/selftest-mcp-firefox.js`，启动方式及隔离 profile 要求见 [MCP 文档](../docs/mcp-client.md#复现-linux-原生测试)。
- 订阅本地认证/存储 smoke：`python3 scripts/tests/selftest-subscription-firefox.py --binary /path/to/firefox`，使用临时 profile，不做真实账号登录或付费模型请求。
- 扩展退出修复：`node scripts/tests/extension-shutdown.mjs /path/to/patched-gecko`，是类级回归，仍需实际启动/退出检查。
- Linux 包：`bash scripts/verify-linux-package.sh <amd64|arm64> <package.tar.xz>`。
- Windows 候选包：`.github/workflows/validate-windows-package.yml` 调用 `verify-windows-package.py`，校验指定包的 hash、SourceStamp、BuildID 和原生行为。
- macOS：`macos-verify-dmg.sh` 检查包内签名/架构，详见 [发布流程](../docs/distribution.md)。

测试使用独立临时 profile，避免把自动化 prefs 写入日常开发 profile。Node mock 通过、文件存在、trace start 成功均不等于当前包采集成功；原生追踪应在目标页面触发后确认本次新增记录。
