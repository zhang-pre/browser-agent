import React, { useEffect, useRef, useState } from "react";

export default function ChatGptLogin({ auth }) {
  const [account, setAccount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const [callback, setCallback] = useState("");
  const [error, setError] = useState("");
  const controller = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    auth?.status().then(value => {
      if (mounted.current) setAccount(value);
    }).catch(() => {
      if (mounted.current) setError("无法读取登录状态，请重试");
    });
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [auth]);

  async function login() {
    setBusy(true); setError(""); setLink(null); setCallback("");
    const operation = new AbortController();
    controller.current = operation;
    try {
      const result = await auth.login({
        signal: operation.signal,
        onAuth: value => { if (mounted.current) setLink(value); },
      });
      if (mounted.current) setAccount(result);
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (controller.current === operation) controller.current = null;
      if (mounted.current) { setBusy(false); setLink(null); setCallback(""); }
    }
  }

  async function logout() {
    setError("");
    try { setAccount(await auth.logout()); }
    catch { setError("退出登录失败，请重试"); }
  }

  function submitCallback() {
    try { auth.completeLogin(callback); setCallback(""); setError(""); }
    catch (e) { setError(e.message); }
  }

  return <section className="settings-pane__section">
    <div className="settings-pane__section-title">ChatGPT Subscription</div>
    <span className="settings-pane__hint">
      {account?.loggedIn ? `已登录 · ${account.accountId}${account.expired ? "（下次请求自动刷新）" : ""}` : "尚未登录"}
    </span>
    <div className="settings-pane__actions">
      <button type="button" disabled={busy || !auth} onClick={login}>{account?.loggedIn ? "重新登录" : "登录 ChatGPT"}</button>
      {busy && <button type="button" onClick={() => controller.current?.abort()}>取消登录</button>}
      {account?.loggedIn && !busy && <button type="button" onClick={logout}>退出登录</button>}
    </div>
    {busy && link && <>
      <p className="settings-pane__hint">
        {link.manual ? "本机回调端口不可用。完成登录后，请粘贴完整回调地址。" : "请在打开的浏览器标签页完成登录；若没有自动返回，可粘贴完整回调地址。"}
        <a href={link.url} target="_blank" rel="noreferrer">打开登录页面</a>
      </p>
      <label className="settings-pane__field">
        回调地址
        <input type="password" autoComplete="off" value={callback}
          placeholder="http://localhost:1455/auth/callback?..."
          onChange={e => setCallback(e.target.value)} />
      </label>
      <button type="button" disabled={!callback.trim()} onClick={submitCallback}>完成登录</button>
    </>}
    {error && <div className="settings-pane__error">{error}</div>}
    <p className="settings-pane__hint">当前浏览器 profile 内的订阅模型配置共用此账号。凭据由 Firefox 登录存储加密保存，不写入模型配置或会话。</p>
  </section>;
}
