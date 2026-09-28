import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { CredentialStore } from "../providers/CredentialStore.sys.mjs";
import { ChatGptOAuth } from "../providers/ChatGptOAuth.sys.mjs";
import { SubscriptionAuth } from "../providers/SubscriptionAuth.sys.mjs";
import { listenForOAuthCallback } from "./FirefoxOAuthCallback.sys.mjs";

const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", "nsILoginInfo", "init");

const ORIGIN = "chrome://browser-agent";
const REALM = "ChatGPT Subscription OAuth";

async function findLogin(id) {
  await Services.logins.initializationPromise;
  return Services.logins.findLogins(ORIGIN, null, REALM).find(login => login.username === id);
}

// Firefox's profile lock excludes competing processes. All windows share this
// parent-process module and CredentialStore's serialized read/refresh/write.
const store = new CredentialStore({
  async read(id) {
    const login = await findLogin(id);
    if (!login) return null;
    try {
      const data = JSON.parse(login.password);
      if (data.type !== "oauth" || typeof data.access_token !== "string" ||
          typeof data.refresh_token !== "string" || typeof data.account_id !== "string" ||
          !Number.isFinite(data.expires_at)) throw new Error();
      return data;
    } catch { throw new Error("ChatGPT 凭据存储无效，请退出登录后重新登录"); }
  },
  async write(id, credential) {
    const existing = await findLogin(id);
    const login = new LoginInfo(ORIGIN, null, REALM, id, JSON.stringify(credential), "", "");
    if (existing) Services.logins.modifyLogin(existing, login);
    else await Services.logins.addLoginAsync(login);
  },
  async delete(id) {
    const existing = await findLogin(id);
    if (existing) Services.logins.removeLogin(existing);
  },
});

const transport = {
  fetch: (...args) => globalThis.fetch(...args),
  createAbortController: () => new AbortController(),
  setTimeout, clearTimeout,
};

export const subscriptionAuth = new SubscriptionAuth({
  store,
  oauth: new ChatGptOAuth({ transport }),
  transport,
  listen: listenForOAuthCallback,
  openAuthorization(url) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win?.gBrowser) throw new Error("请先打开浏览器窗口");
    const tab = win.gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    win.gBrowser.selectedTab = tab;
  },
});

Services.obs.addObserver(() => subscriptionAuth.cancelLogin(), "quit-application-granted");
