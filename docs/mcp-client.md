# 第三方 MCP 客户端

内置 Agent 可以连接第三方 MCP 服务并调用其工具。入口为侧边栏 **设置 → 第三方 MCP 服务**。这项能力与“外部 AI 通过 MCP 操作浏览器”方向相反：这里由浏览器作为 MCP 客户端。

## 支持范围

- 本地 `stdio` 服务，或远程 **Streamable HTTP** 服务。
- 协议握手支持 `2025-11-25`、`2025-06-18`、`2025-03-26`。
- 工具发现、调用、工具策略以及文本、结构化结果和受支持图片结果；保留资源链接、嵌入资源和音频内容块（音频不自动转录）。
- 服务握手的 `instructions` 作为第三方参考说明注入每轮动态上下文，附带工具原名与客户端别名映射；不覆盖用户要求或授权策略。
- 服务声明对应能力时，自动提供资源列表、URI 模板列表、资源读取和提示词列表/读取工具，沿用同一套服务授权策略；提示词作为工具结果返回，不自动执行。
- 本地 stdio 服务可请求标准 `roots/list` 并收到目录变化通知；只暴露宿主实际选择并验证过的工作目录。远程 HTTP 不接收本机目录。
- 活跃工具调用中的基础文本 sampling，以及表单 elicitation；请求和结果通过当前会话的确认面板处理。
- 远程无认证，或手动设置 Token / 请求头。
- 配置、凭证、授权按 Firefox profile 隔离。同一 profile 中全部会话共享已启用工具，不需要逐会话选择。

首版不提供包安装、升级、商店、OAuth 登录、旧版独立 SSE transport 或 HTTP 事件恢复。Windows 和 Linux 是目标平台；本文不表示已完成真实 Firefox 双平台端到端验收。

## js-reverse 的浏览器归属

Firefox 是 Agent 宿主；js-reverse MCP 的操作目标是独立 Chrome/Chromium。
连接时根据服务握手身份或 js-reverse-mcp 启动包识别，工具说明与返回的
`executionContext` 会标注目标浏览器、服务 ID 和连接方式。普通 MCP 不推测浏览器。
仅修改显示名称不会把任意服务识别成 Chrome。

使用 js-reverse 分析时，先调用该服务的 `select_page` 检查 URL；空白页用其
`new_page` 打开目标。开启采集后需要重放时，用同一服务的 `navigate_page`
刷新。不要用内置 Firefox `page_navigate` 触发，再到 Chrome 查网络；页面、
Cookie、请求 ID 和断点不共享。`cookieName` 查询响应 Set-Cookie，不覆盖页面
`document.cookie` 写入。空结果须先检查目标与采集时机。

本地 `fs_*`、Node/Python 和记忆工具仍可共同使用。每轮执行前，客户端将会话
选定的现有工作目录解析为本机真实路径，为本地 js-reverse 自动追加
`--allowedRoots <目录>`；保留手动配置的允许目录，不修改持久服务配置和授权策略。
网络导出、脚本保存、截图及 evaluate 的输入/输出文件参数中，相对路径按本会话
工作目录解析，不再落到 MCP 安装目录。服务仍校验真实路径，越界和符号链接检查不变。

js-reverse 当前通过启动参数读取白名单，新增目录需要重启其 MCP 进程，网络队列、
请求 ID 和断点可能丢失，须重新选择页面、采集后再导出；结果包含连接 ID 和重连提示。
重复使用同一目录不会重启。服务执行其他工具期间不强行重启，会提示等待后重试。
同一 Firefox profile 共享服务，因此本次浏览器运行期间选过的目录也共享；重启
Firefox 或编辑服务配置会清除此临时目录集合，下次按所选目录重新加入。
远程 HTTP 或其他 MCP 服务不注入 js-reverse 专用参数，不自动变更远端权限。

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

遇到问题时，先在设置页刷新状态、检查命令路径 / 服务地址和凭证，再主动测试连接。若服务只能通过 OAuth、旧版 SSE 或需要尚未支持的高级客户端能力，请更换其兼容端点或等待后续支持。



## 超时、错误与服务反向请求

默认连接/调用超时为 **120000 毫秒**，设置页可按服务调整为 1000–1800000 毫秒。
导入/导出配置支持 `timeoutMs`。stdio 请求和 HTTP 传输使用同一配置，避免 HTTP 层
提前切断长调用。超时不自动重放，已发生的远端副作用不会回滚。

JSON-RPC 错误返回错误码、消息及有界的附加诊断；工具执行错误保留服务的结构化
错误类别和可重试标记。已配置的环境变量和请求头凭证会脱敏，连接日志仍不保存原始 stderr。
`evaluate_script` 的说明补充了 Hook 恢复规则：执行报错不会撤销此前的页面修改。

standard roots 与 js-reverse 的 `--allowedRoots` 同时存在：前者是协议发现信息，
后者是该服务实际执行的文件访问校验；roots 通知本身不是文件系统沙箱。同一 profile
本次浏览器运行中选过的本地目录共用，编辑/删除服务或重启浏览器清除对应临时集合。

- Sampling：只将服务此次显式提供的文本交给当前模型，不附带聊天历史、其他服务内容或工具。
  输入须人工批准，生成结果须再次批准才回传；即使 Agent 处于全自动模式也不跳过这两步。
  输出预算上限 8192 tokens；不声明 sampling tools/context 能力，不支持图像/音频 sampling。
- Elicitation：显示服务消息及字段表单，校验基础类型、必填项、枚举和范围。
  用户可提交、拒绝或取消；不声明 URL elicitation，不自动打开服务提供的链接。
- 反向请求仅绑定到该连接唯一的活跃工具调用；无活跃调用或多会话同时调用造成归属不明时，
  返回明确错误。取消、超时和连接关闭会撤销等待中的确认，不把回答发往其他会话。
- Streamable HTTP 支持当前 POST 响应流中的反向请求；尚无独立 GET 事件流或断线事件恢复。

协议参考：[Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)、
[Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)、
[Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)。

## 2026-10-03 补齐验证

- `selftest-mcp-extensions.mjs`：资源/提示词、分页、说明注入、roots 通知、配置超时、
  错误脱敏、反向请求归属、拒绝/取消和 HTTP 响应流内回调。
- Firefox 原生 xpcshell：目录校验、stdio 工具调用、服务发起 roots 请求及客户端应答、
  新模块在打包产物中加载、HTTP 工具调用。
- 当前安装的 js-reverse 4.0.5 + 独立隔离 Chrome + 本地测试页：网络抓取和目录导出，
  脚本发现/检索/读取、代码断点命中、暂停帧读取、移除断点/恢复和 evaluate 均成功；
  WebSocket 工具入口调用成功，本测试没有产生 WebSocket 消息，不等同于帧采集验收。
- Sampling 的真实模型付费请求以及浏览器侧表单人工交互尚未端到端验收；基础回调路径由回归测试覆盖。

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
