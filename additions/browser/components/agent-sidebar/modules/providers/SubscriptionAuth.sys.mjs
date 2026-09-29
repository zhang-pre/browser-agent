import {
  CHATGPT_PROVIDER_ID, createAuthorizationRequest, validateCallback,
} from "./ChatGptOAuth.sys.mjs";

export class SubscriptionAuth {
  constructor({ store, oauth, transport, crypto = globalThis.crypto, listen, openAuthorization, now = () => Date.now() }) {
    Object.assign(this, { store, oauth, transport, crypto, listen, openAuthorization, now });
    this.pendingLogin = null;
  }

  async status() {
    const credential = await this.store.read(CHATGPT_PROVIDER_ID);
    return credential ? {
      loggedIn: true, accountId: credential.account_id,
      expiresAt: credential.expires_at, expired: credential.expires_at <= this.now(),
    } : { loggedIn: false };
  }

  async login({ onAuth = () => {}, signal } = {}) {
    if (this.pendingLogin) throw new Error("ChatGPT 登录正在进行");
    signal?.throwIfAborted();
    const controller = this.transport.createAbortController();
    const pending = { controller, flow: null, accept: null };
    this.pendingLogin = pending;
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = this.transport.setTimeout(cancel, 5 * 60 * 1000);
    let close = () => {};
    try {
      pending.flow = await createAuthorizationRequest(this.crypto);
      controller.signal.throwIfAborted();
      const redirect = new Promise((resolve, reject) => {
        pending.accept = resolve;
        controller.signal.addEventListener("abort", () => reject(new Error("ChatGPT 登录已取消或超时")), { once: true });
      });
      // Attach a handler before opening the browser; synchronous host errors
      // must not leave the redirect promise unhandled.
      redirect.catch(() => {});
      let manual = false;
      try { close = this.listen(url => this.completeLogin(url)); }
      catch { manual = true; }
      onAuth({ url: pending.flow.url, manual });
      await this.openAuthorization(pending.flow.url);
      const code = await redirect;
      const credential = await this.oauth.exchange(code, pending.flow.verifier, controller.signal);
      controller.signal.throwIfAborted();
      await this.store.modify(CHATGPT_PROVIDER_ID, () => {
        controller.signal.throwIfAborted();
        return credential;
      });
      return { loggedIn: true, accountId: credential.account_id, expiresAt: credential.expires_at };
    } finally {
      close();
      this.transport.clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (this.pendingLogin === pending) this.pendingLogin = null;
    }
  }

  completeLogin(url) {
    const pending = this.pendingLogin;
    if (!pending?.accept || pending.controller.signal.aborted) throw new Error("没有等待中的 ChatGPT 登录");
    const code = validateCallback(url, pending.flow.state);
    const accept = pending.accept;
    pending.accept = null;
    accept(code);
  }

  cancelLogin() {
    this.pendingLogin?.controller.abort();
  }

  async logout() {
    this.cancelLogin();
    await this.store.delete(CHATGPT_PROVIDER_ID);
    return { loggedIn: false };
  }

  async getCredential({ signal, rejectedAuthorization } = {}) {
    return this.store.modify(CHATGPT_PROVIDER_ID, async current => {
      signal?.throwIfAborted();
      if (!current) throw new Error("请先在设置中登录 ChatGPT Subscription");
      const rejected = rejectedAuthorization === `Bearer ${current.access_token}`;
      if (!Number.isFinite(current.expires_at) || current.expires_at <= this.now() + 60000 || rejected) {
        const updated = await this.oauth.refresh(current, signal);
        // A refresh can rotate the token. Persist a successful exchange even
        // if its caller cancelled meanwhile, so the old token is never reused.
        return updated;
      }
      return undefined;
    });
  }
}
