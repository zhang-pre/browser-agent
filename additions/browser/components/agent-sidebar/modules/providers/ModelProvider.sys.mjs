import { LlmError } from "../llm/LlmProtocol.sys.mjs";
import { CHATGPT_ENDPOINT } from "./ChatGptOAuth.sys.mjs";

/**
 * ModelProvider contract:
 * authorize(request, {signal, rejectedAuthorization}) -> authenticated request.
 * canRefreshAuth declares whether one HTTP 401 recovery attempt is supported.
 * Protocol conversion and Runtime's chat interface are independent of auth.
 */
export class ApiKeyModelProvider {
  canRefreshAuth = false;

  constructor({ apiKey, protocol }) {
    this.apiKey = apiKey;
    this.protocol = protocol;
  }

  async authorize(request, { signal } = {}) {
    signal?.throwIfAborted();
    if (!this.apiKey) throw new LlmError("chat: apiKey is empty — 请在设置中填写 API Key");
    return {
      ...request,
      init: {
        ...request.init,
        headers: {
          ...request.init.headers,
          Authorization: `Bearer ${this.apiKey}`,
          ...(this.protocol === "anthropic" ? { "x-api-key": this.apiKey } : {}),
        },
      },
    };
  }
}

export class ChatGptSubscriptionProvider {
  canRefreshAuth = true;

  constructor(auth) {
    this.auth = auth;
  }

  async authorize(request, options = {}) {
    if (request.url !== CHATGPT_ENDPOINT) throw new Error("ChatGPT Subscription 仅允许使用官方 Codex endpoint");
    if (!this.auth) throw new Error("ChatGPT 认证服务尚未初始化");
    const credential = await this.auth.getCredential(options);
    options.signal?.throwIfAborted();
    return {
      ...request,
      init: {
        ...request.init,
        credentials: "omit",
        redirect: "error",
        headers: {
          ...request.init.headers,
          Authorization: `Bearer ${credential.access_token}`,
          "ChatGPT-Account-Id": credential.account_id,
          "OpenAI-Beta": "responses=experimental",
          originator: "browser-agent",
        },
      },
    };
  }
}
