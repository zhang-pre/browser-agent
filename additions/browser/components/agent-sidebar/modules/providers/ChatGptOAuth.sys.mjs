/* OAuth wire contract, independent of Firefox UI and credential storage. */
export const CHATGPT_PROVIDER_ID = "openai-chatgpt";
export const CHATGPT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function createAuthorizationRequest(crypto = globalThis.crypto) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: OAUTH_REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "browser-agent",
  }).toString();
  return { verifier, state, url: url.href };
}

export function validateCallback(value, state) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请粘贴完整的 OAuth 回调 URL"); }
  const expected = new URL(OAUTH_REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname ||
      url.username || url.password || url.hash) {
    throw new Error("OAuth 回调地址不匹配");
  }
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
    throw new Error("OAuth state 不匹配，请使用本次登录的回调地址");
  }
  if (url.searchParams.has("error")) throw new Error("ChatGPT 登录被拒绝，请重新登录");
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0]) throw new Error("OAuth 回调缺少 authorization code");
  return codes[0];
}

export function accountIdFromToken(token) {
  try {
    const payload = token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")), c => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof id === "string" && id && !/[\r\n]/.test(id)) return id;
  } catch {}
  throw new Error("ChatGPT token 缺少 account ID，请重新登录");
}

export class ChatGptOAuth {
  constructor({ transport, now = () => Date.now() }) {
    this.transport = transport;
    this.now = now;
  }

  async token(parameters, { signal, previous } = {}) {
    signal?.throwIfAborted();
    const controller = this.transport.createAbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = this.transport.setTimeout(abort, 30000);
    try {
      let response;
      try {
        response = await this.transport.fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, ...parameters }).toString(),
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        signal?.throwIfAborted();
        throw new Error("ChatGPT 认证请求失败或超时，请检查网络后重试");
      }
      if (!response.ok) {
        // Never surface the token response body or OAuth codes in logs/UI.
        throw new Error(response.status === 400 || response.status === 401
          ? "ChatGPT 授权已失效，请重新登录"
          : `ChatGPT 认证服务暂时不可用（HTTP ${response.status}）`);
      }
      let data;
      try { data = await response.json(); } catch { throw new Error("ChatGPT 认证响应格式无效"); }
      if (typeof data?.access_token !== "string" || !data.access_token ||
          !Number.isFinite(data.expires_in) || data.expires_in <= 0 ||
          !Number.isFinite(this.now() + data.expires_in * 1000) ||
          typeof (data.refresh_token ?? previous?.refresh_token) !== "string" ||
          !(data.refresh_token ?? previous?.refresh_token)) {
        throw new Error("ChatGPT 认证响应缺少有效 token 或过期时间");
      }
      return {
        type: "oauth",
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? previous.refresh_token,
        expires_at: this.now() + data.expires_in * 1000,
        account_id: accountIdFromToken(data.access_token),
      };
    } finally {
      this.transport.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  exchange(code, verifier, signal) {
    return this.token({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: OAUTH_REDIRECT_URI,
    }, { signal });
  }

  refresh(credential, signal) {
    return this.token({
      grant_type: "refresh_token", refresh_token: credential.refresh_token,
    }, { signal, previous: credential });
  }
}
