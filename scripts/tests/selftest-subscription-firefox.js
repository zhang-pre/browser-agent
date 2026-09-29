const done = arguments[arguments.length - 1];
(async () => {
  const { subscriptionAuth: auth } = ChromeUtils.importESModule("resource:///modules/agentsidebar/host/FirefoxSubscriptionAuth.sys.mjs");
  const { CHATGPT_PROVIDER_ID, OAUTH_REDIRECT_URI } = ChromeUtils.importESModule("resource:///modules/agentsidebar/providers/ChatGptOAuth.sys.mjs");
  const { agentSession } = ChromeUtils.importESModule("resource:///modules/agentsidebar/host/AgentSession.sys.mjs");
  if (!agentSession) throw new Error("Runtime composition failed");
  if (arguments[0] === "restart") {
    const status = await auth.status();
    if (!status.loggedIn || status.accountId !== "native-test-account") throw new Error("Credential did not survive restart");
    await auth.logout();
    if ((await auth.status()).loggedIn) throw new Error("Logout did not remove credential");
    return { persistedAcrossRestart: true, logout: true };
  }
  let callbackError = "";
  const originalComplete = auth.completeLogin.bind(auth);
  auth.completeLogin = value => { try { return originalComplete(value); } catch (error) { callbackError = error.message; throw error; } };
  let exchanges = 0;
  let refreshes = 0;
  const token = "e30." + btoa(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "native-test-account" },
  })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") + ".test";
  auth.oauth.transport.fetch = async (url, init) => {
    if (url !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected auth request");
    if (new URLSearchParams(init.body).get("grant_type") === "refresh_token") refreshes++;
    else exchanges++;
    return new Response(JSON.stringify({ access_token: token, refresh_token: "native-refresh-secret-" + refreshes, expires_in: 3600 }));
  };
  let ready;
  const notice = new Promise(resolve => { ready = resolve; });
  auth.openAuthorization = () => {};
  const login = auth.login({ onAuth: ready });
  login.catch(() => {});
  try {
    const { url, manual } = await notice;
    if (manual) throw new Error("Native loopback server failed to bind");
    const state = new URL(url).searchParams.get("state");
    const bad = await fetch(OAUTH_REDIRECT_URI + "?code=test&state=wrong");
    if (bad.status !== 400) throw new Error("Invalid state accepted");
    const callback = await fetch(OAUTH_REDIRECT_URI + "?code=native-code&state=" + state);
    if (callback.status !== 200) throw new Error("Native callback failed: " + callback.status + " " + callbackError);
    const status = await login;
    if (!status.loggedIn || exchanges !== 1) throw new Error("Native exchange failed");
    const entries = Services.logins.findLogins("chrome://browser-agent", null, "ChatGPT Subscription OAuth");
    if (entries.length !== 1 || !entries[0].password.includes("native-refresh-secret")) throw new Error("LoginManager did not store tokens");
    await auth.store.modify(CHATGPT_PROVIDER_ID, current => ({ ...current, expires_at: 0 }));
    await Promise.all([auth.getCredential(), auth.getCredential(), auth.getCredential()]);
    if (refreshes !== 1) throw new Error("Concurrent native refresh duplicated");
    return { loopback: true, rejectedBadState: true, loginManager: true, concurrentRefresh: true, runtimeComposition: true };
  } finally {
    auth.cancelLogin();
  }
})().then(done, error => done({ error: error.message, stack: error.stack }));
