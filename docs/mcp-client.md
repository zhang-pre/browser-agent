# 第三方 MCP 客户端

内置 Agent 可以连接第三方 MCP 服务并调用其工具。入口为侧边栏 **设置 → 第三方 MCP 服务**。这项能力与“外部 AI 通过 MCP 操作浏览器”方向相反：这里由浏览器作为 MCP 客户端。

## 支持范围

- 本地 `stdio` 服务，或远程 **Streamable HTTP** 服务。
- 协议握手支持 `2025-11-25`、`2025-06-18`、`2025-03-26`。
- 工具发现、调用、工具策略以及文本和受支持图片结果。
- 远程无认证，或手动设置 Token / 请求头。
- 配置、凭证、授权按 Firefox profile 隔离。同一 profile 中全部会话共享已启用工具，不需要逐会话选择。

首版不提供包安装、升级、商店、OAuth 登录、旧版独立 SSE transport、资源与提示词入口或 HTTP 事件恢复。Windows 和 Linux 是目标平台；本文不表示已完成真实 Firefox 双平台端到端验收。

## 添加服务

1. 自行准备服务和依赖，例如 Node.js、Python 及 MCP 服务包。确认它们在 Firefox 所在系统中可用。
2. 在 MCP 设置中选择“添加服务”，填写名称及连接方式。
3. 保存配置。新服务默认停用，不会因保存或导入而自动启动。
4. 可主动点击“测试连接（会启动）”。测试本地服务会启动其进程；测试停用服务不会向 Agent 开放工具。
5. 检查工具策略，手动启用服务。当前 profile 下一次运行 Agent 时，会连接已启用服务并发现工具，随后复用连接。

“刷新状态”用于读取最新连接状态；“重连”用于重新建立连接。单个服务连接失败不阻止其他工具运行。连接日志不保留原始服务 stderr 或协议错误文本，以避免凭证随诊断输出暴露。

### 本地服务

- **启动命令**：可执行文件名或绝对路径，只填命令本身。
- **启动参数**：字符串 JSON 数组，例如 `["/absolute/path/server.mjs"]`；每个参数分别填写。
- **工作目录**：可选的本机目录。
- **环境变量**：字符串键值对 JSON 对象。包括非密钥项在内，整个 `env` 集合通过 Firefox Login Manager 保存，不写入普通配置。

命令直接运行，不经过 shell，不支持在命令栏写 `cd … && …`、管道或重定向。Windows 的 `npx` 会尝试解析为 Node.js 加相邻的 `node_modules/npm/bin/npx-cli.js`；任意 `.cmd` / `.bat` 启动器不受支持，请改用可执行文件或明确指定解释器及参数。

Windows Firefox 使用 Windows 路径和命令；Linux Firefox 使用 Linux 路径和命令，不会自动跨 Windows / WSL 执行。

### 远程服务

填写实际的 Streamable HTTP MCP 地址，例如 `https://mcp.example.com/mcp`。`headers` 为字符串键值对 JSON 对象，例如：

```json
{"Authorization": "Bearer YOUR_TOKEN"}
```

整个请求头集合均通过 Firefox Login Manager 保存。协议所需的请求头由客户端管理，不能通过表单覆盖。需要浏览器跳转 OAuth 登录的服务不在首版范围内。

## 导入与导出

“导入 MCP 配置”接受以下形式的 JSON：

```json
{
  "mcpServers": {
    "local-service": {
      "command": "node",
      "args": ["/absolute/path/server.mjs"],
      "cwd": "/absolute/path/workspace",
      "env": {
        "SERVICE_TOKEN": "REPLACE_WITH_YOUR_TOKEN"
      }
    },
    "remote-service": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

示例路径和地址是占位内容，需替换为已准备好的服务。Windows 路径可以使用正斜线，例如 JSON 参数数组 `["C:/mcp/server.mjs"]`。

先点击“预览导入”，查看服务名称、类型及未知字段警告，再确认导入。**所有导入服务均为停用状态**，配置中的启用标记不触发启动。同名服务不会被静默覆盖，须先重命名或删除原配置。

编辑凭证时不会回填已有值：留空表示保留原集合，填写 JSON 表示替换整组，填写 `{}` 表示清空。导出配置不包含 `env` 和 `headers` 中的值，迁移后需重新填写。

**密钥应放在 `env` 或 `headers`，不要放在 `args` 或 URL 查询参数中。** 导出会保留参数和地址，无法自动识别藏在其中的密钥。普通服务名称、命令、参数、目录和地址也不属于加密凭证字段。

## 工具授权

| 策略 | 全自动模式 | 其他模式 |
|---|---|---|
| 允许 | 直接调用 | 直接调用 |
| 询问（默认） | 当次自动放行 | 暂停该会话，等待授权 |
| 禁止 / 服务停用 | 拒绝调用 | 拒绝调用 |

非全自动模式提供“仅允许本次”和“始终允许此工具”。持久允许对当前 profile 的所有会话生效；全自动模式自动放行不会把策略永久改为允许。

后台会话等待授权时，重新打开侧边栏可处理；其他会话继续运行。切换执行模式不会追溯批准已挂起的请求，取消任务会同时取消待授权请求。

修改命令、参数、工作目录、地址或凭证后，需要重新确认之前的持久允许；明确禁止的策略保留。工具与稳定服务 ID 绑定，删除后重新添加同名服务不会继承旧授权。

## 运行中变更与故障

新增工具和配置更新从下一轮 Agent 执行生效；停用服务或禁止工具会立即阻止后续调用。已发出的调用尝试取消，但**取消不是回滚**：服务可能已经写入文件、发送请求或执行其他操作。

断线后可重连，客户端不会自动重放执行结果未知的工具调用，以免同一动作执行两次。浏览器退出时关闭连接并清理本地服务进程。

遇到问题时，先在设置页刷新状态、检查命令路径 / 服务地址和凭证，再主动测试连接。若服务只能通过 OAuth、旧版 SSE 或需要客户端资源 / 提示词支持，请更换其兼容端点或等待后续支持。


## 验证记录

2026-09-28 的验证结果：

- Linux 完整 Node 自测 38 项通过，侧边栏 esbuild 构建通过。
- Linux 真实 xpcshell：原生 stdio 工具发现、UTF-8 调用、stderr 分离、子进程关闭，以及 Firefox fetch 对本地 Streamable HTTP 服务的工具发现与调用通过。
- Linux 独立测试 profile：真实 Firefox Login Manager 凭证保存与读取、列表和导出不包含密钥、普通 JSON 不包含密钥、配置和凭证删除通过。仅使用新建的 checkout `.tmp` 子目录，没有访问用户 profile。
- Windows Node Subprocess 适配器接入官方 `@modelcontextprotocol/server-filesystem@2026.8.31`（SDK 1.30.1）：发现 14 个工具，`list_allowed_directories`、`read_text_file` 成功。
- DeepWiki 2.14.3 远程 HTTP：发现 3 个工具，`read_wiki_structure` 读取公开仓库 `modelcontextprotocol/servers` 成功。两项第三方服务验证均协商为协议 `2025-11-25`。

**Windows 原生 Firefox 及设置页 GUI 尚未验收。** Windows Node 适配器测试不等同于 Firefox 原生宿主测试；Linux xpcshell 通过也不等同于完整侧边栏视觉与交互验收。

### 复现 Linux 原生测试

将 `CHECKOUT` 改为仓库的绝对路径。以下命令在 Linux shell 中执行，需要已有的 Firefox 构建产物及 Python 3；不会触发构建或安装：

```sh
CHECKOUT=/absolute/path/to/browser-agent
BIN="$CHECKOUT/upstream/obj-x86_64-pc-linux-gnu/dist/bin"
LD_LIBRARY_PATH="$BIN" \
MOZ_HEADLESS=1 \
MOZ_DISABLE_CONTENT_SANDBOX=1 \
MOZ_DISABLE_SOCKET_PROCESS=1 \
MCP_TEST_ROOT="$CHECKOUT" \
timeout 40 "$BIN/xpcshell" -g "$BIN" -a "$BIN/browser" \
  -f "$CHECKOUT/additions/browser/components/agent-sidebar/dev/selftest-mcp-firefox.js"
```

`MOZ_DISABLE_SOCKET_PROCESS=1` 与上游 xpcshell 测试框架默认设置一致，避免独立 shell 卡在 socket 子进程启动等待。默认仅验证传输，不注册用户 profile。

同时验证真实凭证存储时，先确保 checkout 中有 `.tmp` 目录，再在命令的环境变量中加入：

```sh
MCP_TEST_PROFILE="$CHECKOUT/.tmp/mcp-native-profile-unique"
```

测试要求此目录尚不存在、是 `.tmp` 的直接子目录且名称以 `mcp-` 开头，否则拒绝执行。每次使用新的名称；目录保留供检查。测试会注册该目录为独立 profile，并在结束时执行与上游 harness 相同的 profile 关闭流程。`MCP_TEST_PYTHON` 可以指定 Python 3 可执行文件绝对路径，默认 `/usr/bin/python3`。