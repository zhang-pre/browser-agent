import React, { useEffect, useState } from "react";

const EMPTY = { timeoutMs: 120000, name: "", transport: "stdio", command: "", args: "[]", cwd: "", url: "", secrets: "" };
const STATUS = { connected: "已连接", connecting: "连接中", disconnected: "未连接", disabled: "已停用", error: "连接失败", idle: "未连接" };

function jsonObject(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}不是有效的 JSON 对象`); }
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.values(value).some(v => typeof v !== "string")) {
    throw new Error(`${label}须为字符串键值对 JSON 对象`);
  }
  return value;
}

/** All configuration is scoped to the current Firefox profile by the injected service. */
export default function McpSettings({ mcp }) {
  const [servers, setServers] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState(null);
  const [exportText, setExportText] = useState("");
  const [deleteId, setDeleteId] = useState(null);

  useEffect(() => {
    let active = true;
    mcp.list().then(items => { if (active) setServers(items); }).catch(e => { if (active) setError(e.message || String(e)); });
    return () => { active = false; };
  }, [mcp]);

  async function action(fn, success = "") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      setServers(await mcp.list());
      setMessage(success);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(server) {
    setForm(server ? { ...EMPTY, ...server, args: JSON.stringify(server.args || []), secrets: "" } : { ...EMPTY });
    setError("");
    setMessage("");
  }
  const field = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

  async function save() {
    await action(async () => {
      const config = { name: form.name.trim(), transport: form.transport, enabled: !!form.enabled, timeoutMs: Number(form.timeoutMs) };
      if (!config.name) throw new Error("请填写服务名称");
      if (form.id) config.id = form.id;
      else config.enabled = false;
      if (form.transport === "stdio") {
        config.command = form.command.trim();
        if (!config.command) throw new Error("请填写启动命令");
        config.args = JSON.parse(form.args || "[]");
        if (!Array.isArray(config.args) || config.args.some(a => typeof a !== "string")) throw new Error("启动参数须为字符串 JSON 数组");
        config.cwd = form.cwd.trim();
        if (form.secrets.trim()) config.env = jsonObject(form.secrets, "环境变量");
      } else {
        config.url = form.url.trim();
        if (!/^https?:\/\//i.test(config.url)) throw new Error("服务地址须以 http:// 或 https:// 开头");
        if (form.secrets.trim()) config.headers = jsonObject(form.secrets, "请求头");
      }
      await mcp.save(config);
      setForm(null);
    }, "配置已保存。新服务需要手动启用。");
  }

  return (
    <section className="settings-pane__section" aria-label="第三方 MCP 服务">
      <div className="settings-pane__section-title">第三方 MCP 服务</div>
      <p className="settings-pane__hint">当前浏览器 profile 的全部会话共享已启用工具。请自行准备本地服务及运行环境；命令在浏览器所在系统执行。第三方服务操作的浏览器可能与当前 Firefox 不同；js-reverse 使用独立 Chrome/Chromium。</p>
      <div className="settings-pane__actions">
        <button type="button" disabled={busy} onClick={() => edit(null)}>添加服务</button>
        <button type="button" disabled={busy} onClick={() => action(async () => {})}>刷新状态</button>
        <button type="button" disabled={busy} onClick={() => action(async () => setExportText(JSON.stringify(await mcp.exportConfig(), null, 2)))}>导出配置</button>
      </div>
      {error && <p role="alert" className="settings-pane__error">{error}</p>}
      {message && <p role="status" className="settings-pane__saved">{message}</p>}
      {busy && <p role="status" className="settings-pane__hint">正在处理…</p>}
      {!servers.length && <p className="settings-pane__hint">尚未添加 MCP 服务。</p>}
      {servers.map(server => (
        <section className="settings-pane__section" key={server.id} aria-label={server.name}>
          <strong>{server.name}</strong>
          <p className="settings-pane__hint">{server.transport === "stdio" ? "本地命令" : "远程 HTTP"} · {STATUS[server.status] || server.status || "未连接"}</p>
          {server.executionContext?.browser && <p className="settings-pane__hint">操作目标：{server.executionContext.browser}（独立于当前 Firefox）</p>}
          {!!server.executionContext?.workspaceRoots?.length && <p className="settings-pane__hint">本次运行已加入的工作目录：{server.executionContext.workspaceRoots.join("、")}。新增目录会重连服务，需重新采集请求。</p>}
          <label className="settings-pane__field settings-pane__field--check">
            <input type="checkbox" checked={!!server.enabled} disabled={busy} onChange={e => action(() => mcp.setEnabled(server.id, e.target.checked))} />启用服务
          </label>
          {server.error && <p className="settings-pane__error">{server.error}</p>}
          <div className="settings-pane__actions" style={{ flexWrap: "wrap" }}>
            <button type="button" disabled={busy} onClick={() => edit(server)}>编辑</button>
            <button type="button" disabled={busy} onClick={() => action(() => mcp.test(server.id), "连接测试已结束，请查看服务状态。")}>测试连接（会启动）</button>
            <button type="button" disabled={busy || !server.enabled} onClick={() => action(() => mcp.reconnect(server.id))}>重连</button>
            <button type="button" disabled={busy} onClick={() => setDeleteId(server.id)}>删除</button>
          </div>
          {deleteId === server.id && <div className="settings-pane__actions">
            <span>删除配置并断开服务？</span>
            <button type="button" disabled={busy} onClick={() => action(async () => { await mcp.remove(server.id); setDeleteId(null); })}>确认删除</button>
            <button type="button" disabled={busy} onClick={() => setDeleteId(null)}>取消</button>
          </div>}
          <details>
            <summary>工具策略（{(server.tools || []).length}）</summary>
            <p className="settings-pane__hint">全自动模式自动放行“询问”；其他模式等待授权。“禁止”在所有模式下生效。</p>
            {(server.tools || []).map(tool => <label className="settings-pane__field" key={tool.name}>
              <span style={{ overflowWrap: "anywhere" }}>{tool.name}</span>
              {tool.description && <span className="settings-pane__hint">{tool.description}</span>}
              <select aria-label={`${tool.name} 的授权策略`} value={tool.policy || "ask"} disabled={busy} onChange={e => action(() => mcp.setPolicy(server.id, tool.name, e.target.value))}>
                <option value="ask">询问</option><option value="allow">允许</option><option value="deny">禁止</option>
              </select>
            </label>)}
            {!server.tools?.length && <p className="settings-pane__hint">连接服务后显示发现的工具。</p>}
          </details>
          <details><summary>连接日志</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto" }}>{(server.logs || []).map(log => typeof log === "string" ? log : JSON.stringify(log)).join("\n") || "暂无日志"}</pre></details>
        </section>
      ))}
      {form && <fieldset disabled={busy} style={{ minWidth: 0 }}>
        <legend>{form.id ? "编辑服务" : "添加服务"}</legend>
        <label className="settings-pane__field">服务名称<input type="text" value={form.name} onChange={e => field("name", e.target.value)} /></label>
        <label className="settings-pane__field">连接方式<select value={form.transport} onChange={e => setForm(previous => ({ ...previous, transport: e.target.value, secrets: "" }))}><option value="stdio">本地命令（stdio）</option><option value="http">远程 HTTP</option></select></label>
        <label className="settings-pane__field">调用超时（毫秒）<input type="number" min="1000" max="1800000" value={form.timeoutMs} onChange={e => field("timeoutMs", e.target.value)} /></label>
        {form.transport === "stdio" ? <>
          <label className="settings-pane__field">启动命令<input type="text" value={form.command} placeholder="例如 npx 或可执行文件绝对路径" onChange={e => field("command", e.target.value)} /></label>
          <label className="settings-pane__field">启动参数（JSON 数组）<textarea rows={3} value={form.args} onChange={e => field("args", e.target.value)} spellCheck={false} /></label>
          <label className="settings-pane__field">工作目录（可选）<input type="text" value={form.cwd} onChange={e => field("cwd", e.target.value)} /></label>
        </> : <label className="settings-pane__field">服务地址<input type="url" value={form.url} placeholder="https://example.com/mcp" onChange={e => field("url", e.target.value)} /></label>}
        <label className="settings-pane__field">{form.transport === "stdio" ? "环境变量" : "请求头"}（JSON 对象）<textarea rows={3} value={form.secrets} onChange={e => field("secrets", e.target.value)} autoComplete="off" spellCheck={false} placeholder={form.transport === "stdio" ? '{"API_KEY":"…"}' : '{"Authorization":"Bearer …"}'} /></label>
        <p className="settings-pane__hint">凭证加密保存，不回填显示。留空保留原值；填写 JSON 将替换该组凭证，填写 {"{}"} 清空。修改命令、地址或凭证会重置此服务的持久授权。</p>
        <div className="settings-pane__actions"><button type="button" onClick={save}>保存服务</button><button type="button" onClick={() => setForm(null)}>取消</button></div>
      </fieldset>}
      <details>
        <summary>导入 MCP 配置</summary>
        <label className="settings-pane__field">粘贴 mcpServers JSON<textarea rows={7} disabled={busy} value={importText} spellCheck={false} onChange={e => { setImportText(e.target.value); setPreview(null); }} /></label>
        <button type="button" disabled={busy || !importText.trim()} onClick={() => action(async () => setPreview(await mcp.previewImport(importText)))}>预览导入</button>
        {preview && <div>
          <p className="settings-pane__hint">以下服务将以停用状态导入，不执行启动命令。凭证不会出现在预览中。</p>
          <ul>{(preview.servers || []).map((server, i) => <li key={i}>{server.name} · {server.transport === "stdio" ? "本地命令" : "远程 HTTP"}</li>)}</ul>
          {(preview.warnings || []).map((warning, i) => <p className="settings-pane__error" key={i}>{typeof warning === "string" ? warning : JSON.stringify(warning)}</p>)}
          <button type="button" disabled={busy || !preview.servers?.length} onClick={() => action(async () => { await mcp.importConfig(importText); setImportText(""); setPreview(null); }, "已导入。请检查配置并手动启用服务。")}>确认导入</button>
        </div>}
      </details>
      {exportText && <label className="settings-pane__field">导出配置（不含凭证，可全选复制）<textarea readOnly rows={8} value={exportText} onFocus={e => e.target.select()} /><button type="button" onClick={() => setExportText("")}>收起导出</button></label>}
    </section>
  );
}
