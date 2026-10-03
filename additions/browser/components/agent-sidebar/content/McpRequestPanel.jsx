import React, { useState } from "react";
import { validateElicitation } from "../modules/mcp/McpSessionRequests.sys.mjs";

export default function McpRequestPanel({ pending }) {
  const args = pending.call.args;
  const fields = args.schema?.properties || {};
  const [values, setValues] = useState(() => Object.fromEntries(Object.entries(fields).filter(([, f]) => f.default !== undefined).map(([key, f]) => [key, f.default])));
  const [error, setError] = useState("");
  const set = (key, value) => setValues(previous => ({ ...previous, [key]: value }));
  const submit = () => {
    try {
      if (args.mcpRequest === "elicitation") validateElicitation(args.schema, values);
      pending.resolve({ approved: true, content: values });
    } catch (e) { setError(e.message); }
  };
  return <div className="agent-confirm">
    <strong>{pending.call.name}</strong>
    {args.mcpRequest === "elicitation" ? <>
      <p>{args.message}</p>
      {Object.entries(fields).map(([key, field]) => {
        const choices = field.enum || field.oneOf?.map(x => x.const);
        const multi = field.items?.enum || field.items?.anyOf?.map(x => x.const);
        return <label key={key} className="settings-pane__field">
          {field.title || key}{args.schema.required?.includes(key) ? " *" : ""}
          {field.description && <span>{field.description}</span>}
          {field.type === "boolean" ? <select value={values[key] === undefined ? "" : String(values[key])} onChange={e => set(key, e.target.value === "" ? undefined : e.target.value === "true")}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>
            : choices ? <select value={values[key] ?? ""} onChange={e => set(key, e.target.value)}><option value="">请选择</option>{choices.map((v, i) => <option key={v} value={v}>{field.enumNames?.[i] || field.oneOf?.[i]?.title || v}</option>)}</select>
            : field.type === "array" && multi ? <select multiple value={values[key] || []} onChange={e => set(key, Array.from(e.target.selectedOptions, x => x.value))}>{multi.map(v => <option key={v} value={v}>{v}</option>)}</select>
            : field.type === "array" ? <textarea placeholder="每行一项" value={(values[key] || []).join("\n")} onChange={e => set(key, e.target.value ? e.target.value.split("\n") : [])} />
            : <input type={["number", "integer"].includes(field.type) ? "number" : "text"} value={values[key] ?? ""} onChange={e => set(key, e.target.value === "" ? undefined : field.type === "string" ? e.target.value : Number(e.target.value))} />}
        </label>;
      })}
    </> : <>
      <p>{args.mcpRequest === "sampling" ? "此服务请求使用当前模型生成内容。以下内容将发送给模型。" : "生成已完成。批准后，以下结果会发送给该 MCP 服务。"}</p>
      <pre style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{args.text ?? JSON.stringify(args.messages, null, 2)}</pre>
    </>}
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={submit}>{args.mcpRequest === "elicitation" ? "提交" : "批准本次"}</button>
    <button type="button" onClick={() => pending.resolve({ approved: false, action: "decline" })}>拒绝</button>
    {args.mcpRequest === "elicitation" && <button type="button" onClick={() => pending.resolve({ approved: false, action: "cancel" })}>取消</button>}
  </div>;
}
