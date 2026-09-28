# Pi provider 分析与 ChatGPT Subscription 接入

分析基于本地 Pi 仓库提交 `acaa253cc8e3f159e6100b6f3874861b1f0bfc99`。下面的链接固定到该提交，避免把旧版 Pi 的全局 API registry 设计与本版本混淆。本项目没有引入或复制 Pi 源码，仅参考职责划分与 HTTP 协议约定。

## 1. Pi 的 provider、model 与认证分层

| 层 | 关键实现 | 职责 |
| --- | --- | --- |
| Provider | `packages/ai/src/models.ts` 的 `Provider`、`createProvider` | 定义 id/name/baseUrl/headers/auth、getModels、可选 refreshModels/filterModels 和 stream/streamSimple |
| Models | 同文件 `createModels` | 注册 provider、按 provider/model ID 查询模型、解析请求时认证，并委派给对应 provider |
| ModelRuntime | `packages/coding-agent/src/core/model-runtime.ts` | 组合内置 provider、models.json 覆盖、扩展、模型目录缓存和可用模型快照 |
| ModelRegistry | `packages/coding-agent/src/core/model-registry.ts` | 供扩展使用的同步兼容门面；当前 coding-agent 内部主要使用 ModelRuntime |
| Auth | `packages/ai/src/auth/types.ts`、`resolve.ts` | 区分 API Key/OAuth 凭据，最终统一为 ModelAuth |
| CredentialStore | `packages/coding-agent/src/core/auth-storage.ts` | auth.json 的读取、受锁保护的更新与删除 |

[Provider / Models 源码](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/models.ts)；
[ModelRuntime](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/coding-agent/src/core/model-runtime.ts)；
[ModelRegistry](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/coding-agent/src/core/model-registry.ts)。

### Model registry

模型携带 id、provider、api、baseUrl、输入模态、上下文窗口、输出上限、推理等级映射、价格与兼容参数。provider 的 getModels 提供当前目录；动态 provider 通过 refreshModels 和 publish 更新目录及缓存。可用模型列表还要结合是否配置认证及 filterModels 过滤，不能把“目录中存在”理解为账号必然有权限。

Codex provider 将生成的模型目录与 `openai-codex-responses` 协议绑定。模型数据来自 `providers/data/openai-codex.json`，生成包装文件不承担 token 管理。

### API Key 与 OAuth 的区别

| 项目 | API Key | OAuth subscription |
| --- | --- | --- |
| 存储类型 | `{type:"api_key", key, env?}` | `{type:"oauth", access, refresh, expires, ...}` |
| 登录 | 输入 key；部分 provider 使用环境变量等 ambient auth | 交互授权，获得可续期凭据 |
| 请求时解析 | `apiKey.resolve({ctx, credential, signal})` | 先判断过期、刷新，再调用 `oauth.toAuth(credential)` |
| 刷新 | 通常无自动轮换 | `oauth.refresh` 返回新凭据，由 store 持久化 |
| 输出 | 两者均返回 ModelAuth：apiKey / headers / baseUrl | 同左，调用层不需要处理 OAuth 流程 |

重要区别是“认证方式”和“请求协议”是两个维度。OAuth 不是新的消息格式；Codex 恰好同时需要 OAuth 和特有 Responses endpoint。API Key provider 也可能使用 Responses 协议。

[认证接口](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/auth/types.ts)；
[请求时认证解析](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/auth/resolve.ts)。

### /login 与 auth.json

`interactive-mode.ts` 识别 `/login` 或 `/login <provider>`，选择 provider 和认证方式，创建登录对话框，将 prompt/notify/signal 交给 ModelRuntime.login，再进入 Models.login 和具体认证实现。登录完成后通过 CredentialStore.modify 保存凭据，并更新可用模型状态。UI 负责展示授权链接、设备码或手动输入；OAuth 实现负责协议。

auth.json 以 provider ID 为键，每个 provider 一条带 type 标记的凭据。本版本使用 proper-lockfile，在读—修改—写期间持有文件锁；目录首次创建权限为 0700，文件首次创建为 0600。它是受文件权限保护的 JSON，不是加密保险箱。

OAuth 请求时使用过期提前量（默认五分钟）。即使锁外判断即将过期，进入 modify 后仍重新读取、再次判断，以便复用其他请求或进程刚刷新的 token。refresh token 可能轮换，因此不能让两个调用同时用同一个旧 refresh token 请求刷新。logout 也通过同一存储序列化。

[交互登录](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/coding-agent/src/modes/interactive/interactive-mode.ts)；
[AuthStorage](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/coding-agent/src/core/auth-storage.ts)。

## 2. Pi OpenAI Codex 的具体调用链

### OAuth 登录

1. 生成 PKCE verifier、S256 challenge 和随机 state。
2. 打开 `https://auth.openai.com/oauth/authorize`，携带公共 client ID、scope、redirect_uri、state 和 challenge。
3. 浏览器登录后回到 `http://localhost:1455/auth/callback`。Pi 用 Node HTTP 监听 loopback，也允许手动输入；本项目手动输入必须是完整回调 URL 并验证 state。
4. 向 `https://auth.openai.com/oauth/token` POST 表单，使用 authorization_code、code_verifier 和相同 redirect_uri 换取 token。
5. 保存 access/refresh/expires，并从 access token 的 `https://api.openai.com/auth.chatgpt_account_id` claim 提取账号 ID。
6. 过期时用 refresh_token grant 交换并保存新凭据。

Pi 当前还实现了 device-code 登录。本次按用户要求实现浏览器 OAuth，没有添加设备码分支。JWT 解码用于取得路由账号 ID，不把本地解码当作签名验证；真正的认证由 OpenAI 服务完成。

公共 OAuth client ID 为 `app_EMoamEEZ73f0CkXaXp7hrann`，scope 为 `openid profile email offline_access`，无需嵌入 client secret。授权请求还带有 Pi 已使用的 `id_token_add_organizations`、`codex_cli_simplified_flow` 和 originator 参数。

[Pi Codex provider](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/providers/openai-codex.ts)；
[Pi Codex OAuth](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/auth/oauth/openai-codex.ts)。

### 从认证到模型请求

```text
Agent / ModelRuntime.stream
  → Models.applyAuth
  → Models.getAuth
  → resolveProviderAuth
  → CredentialStore.modify + OAuth.refresh（需要时）
  → OAuth.toAuth：apiKey = access token
  → Codex provider.stream
  → openai-codex-responses
  → POST https://chatgpt.com/backend-api/codex/responses
```

Pi 的 Codex OAuth toAuth 返回 access token。Codex 协议适配器再从 token 取得账号 ID，注入：

- `Authorization: Bearer <access_token>`
- `chatgpt-account-id: <account_id>`
- `originator`、客户端标识
- SSE 请求的 `OpenAI-Beta: responses=experimental`、Accept、Content-Type

请求体使用 input/instructions/tools，而不是 chat/completions 的 messages；Codex 请求要求 store:false、stream:true。Pi 还支持更完整的 Responses reasoning、WebSocket、缓存和重连，本项目本次仅实现 SSE 和当前 Runtime 所需的文本、图片、工具与用量。

[Codex 请求适配器](https://github.com/earendil-works/pi/blob/acaa253cc8e3f159e6100b6f3874861b1f0bfc99/packages/ai/src/api/openai-codex-responses.ts)。

官方文档确认了 ChatGPT 订阅登录和 API Key 按量访问是不同认证路径，浏览器登录会通过本机回调返回凭据；但这些文档描述的是 Codex 产品，并没有为本项目提供第三方 OAuth 集成的稳定性承诺。这里的具体 client ID、额外参数和 backend endpoint 来自所分析的 Pi 实现，后续服务变更需要跟进。[OpenAI 官方认证说明](https://developers.openai.com/codex/auth/)

## 3. 当前项目的实现

```text
AgentRuntime / AgentTurnOrchestrator（接口不变）
  → LlmClient.chat(messages, options)
  → LlmRequestExecutor
      → ModelProvider.authorize(request, {signal, rejectedAuthorization})
          ├─ ApiKeyModelProvider
          └─ ChatGptSubscriptionProvider
               → SubscriptionAuth
               → CredentialStore（串行读/刷新/写）
               → Firefox LoginManager（加密持久化）
      → LlmProtocol / CodexResponses
      → LlmTransport.fetch
      → 统一 ChatResult：content / reasoningContent / toolCalls / usage
```

| 文件（相对 agent-sidebar） | 作用 |
| --- | --- |
| modules/providers/ModelProvider.sys.mjs | 请求认证接口、API Key 与订阅实现；订阅 token 只允许发往固定 Codex endpoint |
| modules/providers/ChatGptOAuth.sys.mjs | PKCE、state 验证、token 交换和刷新；不依赖 Firefox |
| modules/providers/SubscriptionAuth.sys.mjs | 登录状态机、取消/超时、手动回调、提前一分钟刷新 |
| modules/providers/CredentialStore.sys.mjs | 注入存储 backend，序列化刷新、登录保存和退出 |
| modules/providers/SubscriptionModels.sys.mjs | 订阅模型候选目录、上下文与视觉元数据 |
| modules/host/FirefoxOAuthCallback.sys.mjs | IPv4/IPv6 loopback 回调，限时、限长并校验 Host |
| modules/host/FirefoxSubscriptionAuth.sys.mjs | LoginManager backend、打开浏览器标签、关闭浏览器时取消登录 |
| modules/llm/CodexResponses.sys.mjs | 消息、工具和图像转换；Responses SSE、终止事件、用量与失败处理 |
| content/ChatGptLogin.jsx | 登录、取消、退出、脱敏状态和手动回调界面 |

### 凭据与生命周期

本项目不复制 Pi 的 auth.json，也不读写 Codex/Pi 的现有登录文件。订阅 access_token / refresh_token / expires_at / account_id 保存在 Firefox LoginManager 的加密 password 字段，逻辑键为 openai-chatgpt。模型 prefs 只保存模型选项，订阅配置强制不保存 apiKey。UI 只读取登录状态、账号 ID 和过期时间。

一个 Firefox profile 内的订阅模型配置共用一个 ChatGPT 账号；不同 Firefox profile 各自登录，退出会使该 profile 内所有订阅配置退出。这与现有 API Key 命名配置的独立密钥并存。若需要同一 profile 多个 ChatGPT 账号，可在后续增加显式 credential ID；本次没有隐式复用其他浏览器 profile 的账号。

所有窗口共享父进程单例。Firefox 本身的 profile 锁排除同一 profile 的其他进程，CredentialStore 序列化进程内操作。401 只允许一次认证刷新；若另一请求已更新 access token，则复用新 token，不重复刷新。刷新成功后先保存轮换凭据再发模型请求；保存失败会报告失败。退出与刷新串行，不会被迟到的刷新“复活”。

OAuth 服务的错误不回显 token 响应正文；订阅模型 HTTP 错误也不保留原始响应正文。模型请求固定 HTTPS endpoint，禁止重定向携带凭据到其他地址。普通 API Key provider 的端点、配置和协议保留。

### Responses 适配边界

system/developer 消息变为 instructions；用户文本/图片变为 input_text/input_image；assistant 工具调用和工具结果分别变为 function_call/function_call_output。流式完成后返回现有 Runtime 的 toolCalls，工具调度器不需要识别 OAuth。

即使调用者没有 onDelta，Codex HTTP 请求仍使用 SSE，再汇总成同样的 ChatResult。缺少 response.completed、response.failed 或 incomplete 都作为失败处理，不把截断工具调用交给 Runtime 执行。当前重放可见文本与工具历史，不保存加密 reasoning item，也未实现 WebSocket transport。

候选模型列表不是账户可用性保证，支持手动输入模型 ID；本次没有猜测 Codex 的远程 models API，也没有拿订阅 token 调用通用 /v1/models。

## 4. 使用与验证

设置 → 新建模型配置 → 提供方选择 OpenAI ChatGPT Subscription → 登录 ChatGPT → 完成浏览器授权 → 选择模型 → 保存并使用。登录取消或五分钟未完成会关闭回调监听；1455 端口不可用时界面提供完整回调地址输入。OAuth token 请求有 30 秒超时。

开发构建：

```bash
npm --prefix additions/browser/components/agent-sidebar run build
bash scripts/sync-additions.sh
cd upstream
./mach build faster
./mach run
```

离线回归（不调用真实模型）：

```bash
bash scripts/selftest-agent-tools.sh
```

原生 Firefox 验证（需要已完成上述构建）：

```bash
python3 scripts/tests/selftest-subscription-firefox.py
# 其他构建路径可用 --binary /absolute/path/to/firefox
```

覆盖 PKCE/state、取消与手动回调、token 轮换、并发刷新、退出竞态、持久化失败、401 限次重试、授权端点限制、SSE 分片与截断、工具/图像转换和 API Key 共存。原生测试使用临时 profile 和模拟 token endpoint，验证真实 loopback 回调、LoginManager 落盘加密、重启后恢复与退出，以及 Runtime 宿主加载。

真实 ChatGPT 账户授权和线上模型调用仍需用户在设置中完成一次验证；本次没有使用个人凭据或消耗订阅额度。
