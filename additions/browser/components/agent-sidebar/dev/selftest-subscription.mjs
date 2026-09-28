import assert from "node:assert/strict";
import { runAgentTurn } from "../modules/runtime/AgentLoop.sys.mjs";
import { createHash } from "node:crypto";
import { CredentialStore } from "../modules/providers/CredentialStore.sys.mjs";
import { ChatGptOAuth, CHATGPT_ENDPOINT, CHATGPT_PROVIDER_ID, OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI, createAuthorizationRequest, validateCallback } from "../modules/providers/ChatGptOAuth.sys.mjs";
import { SubscriptionAuth } from "../modules/providers/SubscriptionAuth.sys.mjs";
import { ChatGptSubscriptionProvider } from "../modules/providers/ModelProvider.sys.mjs";
import { ConfigStore } from "../modules/providers/ConfigStore.sys.mjs";
import { buildClientFromStore, isVisionModel } from "../modules/providers/providers.sys.mjs";
import { createLlmTransport } from "../modules/llm/LlmTransport.sys.mjs";
import { CodexStreamInterruptedError, readCodexStream } from "../modules/llm/CodexResponses.sys.mjs";

const token = (account, serial = 1) => "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account }, serial,
})).toString("base64url") + ".test";
const credential = (serial = 1, expires = 1000000) => ({
  type: "oauth", access_token: token("account-a", serial), refresh_token: "refresh-" + serial,
  account_id: "account-a", expires_at: expires,
});
const now = () => 1000;
function memoryStore(initial) {
  const map = new Map(initial ? [[CHATGPT_PROVIDER_ID, structuredClone(initial)]] : []);
  const store = new CredentialStore({
    async read(id) { return structuredClone(map.get(id) || null); },
    async write(id, value) { map.set(id, structuredClone(value)); },
    async delete(id) { map.delete(id); },
  });
  return { store, map };
}
function makeService(initial, overrides = {}) {
  const { store, map } = memoryStore(initial);
  const transport = createLlmTransport(overrides.transport);
  const service = new SubscriptionAuth({
    store, transport, now, oauth: overrides.oauth || { refresh: async () => credential(2) },
    listen: () => () => {}, openAuthorization: () => {}, ...overrides,
  });
  return { service, store, map };
}
function sse(events, { split = false, finalNewline = true } = {}) {
  const text = events.map(event => "data: " + JSON.stringify(event)).join("\r\n\r\n") +
    (finalNewline ? "\r\n\r\n" : "");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      if (split) for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
const message = text => ({ type: "message", content: [{ type: "output_text", text }] });
const completed = output => ({ type: "response.completed", response: {
  status: "completed", output,
  usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } },
} });
const events = [completed([message("你好")])];

// PKCE S256, random state, strict callback validation (including manual input).
const flow = await createAuthorizationRequest();
const other = await createAuthorizationRequest();
const url = new URL(flow.url);
assert.notEqual(flow.state, other.state);
assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(flow.verifier).digest("base64url"));
assert.equal(url.searchParams.get("client_id"), OAUTH_CLIENT_ID);
assert.equal(url.searchParams.get("redirect_uri"), OAUTH_REDIRECT_URI);
assert.equal(url.searchParams.get("scope"), "openid profile email offline_access");
const redirect = OAUTH_REDIRECT_URI + "?code=example&state=" + flow.state;
assert.equal(validateCallback(redirect, flow.state), "example");
for (const bad of [
  "example", redirect.replace("localhost", "evil.example"), redirect.replace("/auth/callback", "/wrong"),
  OAUTH_REDIRECT_URI + "?code=example", redirect + "&state=other", redirect + "&code=two",
  redirect.replace(flow.state, "wrong"), redirect + "&error=access_denied",
]) assert.throws(() => validateCallback(bad, flow.state));

// Token exchange, expiry and refresh-token rotation. Errors never echo secrets.
let tokenRequests = [];
const oauth = new ChatGptOAuth({ now, transport: createLlmTransport({
  fetch: async (address, init) => {
    tokenRequests.push({ address, init });
    return new Response(JSON.stringify({ access_token: token("account-a", tokenRequests.length),
      refresh_token: "rotated", expires_in: 3600 }));
  },
}) });
const exchanged = await oauth.exchange("code-secret", flow.verifier);
assert.equal(exchanged.expires_at, 3601000);
assert.equal(exchanged.account_id, "account-a");
assert.equal(tokenRequests[0].address, "https://auth.openai.com/oauth/token");
assert.equal(new URLSearchParams(tokenRequests[0].init.body).get("code_verifier"), flow.verifier);
assert.equal(tokenRequests[0].init.redirect, "error");
const refreshed = await oauth.refresh(exchanged);
assert.equal(refreshed.refresh_token, "rotated");
assert.equal(new URLSearchParams(tokenRequests[1].init.body).get("grant_type"), "refresh_token");
const withoutRotation = new ChatGptOAuth({ now, transport: createLlmTransport({
  fetch: async () => new Response(JSON.stringify({ access_token: token("account-a"), expires_in: 300 })),
}) });
assert.equal((await withoutRotation.refresh(credential())).refresh_token, "refresh-1");
for (const response of [
  () => new Response("refresh-secret", { status: 400 }),
  () => new Response(JSON.stringify({ access_token: "secret", refresh_token: "refresh-secret", expires_in: 3600 })),
  () => new Response(JSON.stringify({ access_token: token("account-a"), expires_in: -1, refresh_token: "refresh-secret" })),
]) {
  const broken = new ChatGptOAuth({ transport: createLlmTransport({ fetch: async () => response() }) });
  await assert.rejects(broken.refresh(credential()), error => !JSON.stringify(error).includes("refresh-secret") && !error.message.includes("secret"));
}

// Login callback, status redaction, duplicate login, cancellation and manual fallback.
let callback;
let closed = 0;
let opened;
let loginNotice;
const logged = makeService(null, {
  oauth: { exchange: async code => { assert.equal(code, "authorized"); return credential(); } },
  listen: receive => { callback = receive; return () => closed++; },
  openAuthorization: address => { opened = address; },
});
const logging = logged.service.login({ onAuth: notice => { loginNotice = notice; } });
while (!opened) await new Promise(resolve => setTimeout(resolve, 0));
await assert.rejects(logged.service.login(), /正在进行/);
assert.throws(() => callback(OAUTH_REDIRECT_URI + "?code=authorized&state=wrong"), /state/);
callback(OAUTH_REDIRECT_URI + "?code=authorized&state=" + new URL(opened).searchParams.get("state"));
assert.throws(() => callback(redirect), /没有等待/);
const status = await logging;
assert.equal(status.loggedIn, true);
assert.equal(closed, 1);
assert.equal(loginNotice.manual, false);
assert.equal(JSON.stringify(await logged.service.status()).includes("access_token"), false);
await logged.service.logout();
assert.equal((await logged.service.status()).loggedIn, false);
const manual = makeService(null, {
  listen: () => { throw new Error("port in use"); },
  openAuthorization: () => {},
  oauth: { exchange: async () => credential() },
});
await manual.service.login({ onAuth: notice => {
  assert.equal(notice.manual, true);
  manual.service.completeLogin(OAUTH_REDIRECT_URI + "?code=x&state=" + new URL(notice.url).searchParams.get("state"));
} });
const cancelled = makeService(null);
await assert.rejects(cancelled.service.login({ onAuth: () => cancelled.service.cancelLogin() }), /取消/);
assert.equal((await cancelled.service.status()).loggedIn, false);

// Concurrent requests refresh only once and persist the new refresh token.
let refreshes = 0;
const shared = makeService(credential(1, 0), { oauth: { refresh: async () => {
  refreshes++;
  await new Promise(resolve => setTimeout(resolve, 5));
  return credential(2);
} } });
const credentials = await Promise.all(Array.from({ length: 12 }, () => shared.service.getCredential()));
assert.equal(refreshes, 1);
assert.ok(credentials.every(item => item.refresh_token === "refresh-2"));
assert.equal((await shared.store.read(CHATGPT_PROVIDER_ID)).refresh_token, "refresh-2");
await shared.service.getCredential({ rejectedAuthorization: "Bearer " + credential(1).access_token });
assert.equal(refreshes, 1, "stale 401 must not double-refresh a newly rotated token");
await shared.service.getCredential({ rejectedAuthorization: "Bearer " + credential(2).access_token });
assert.equal(refreshes, 2);
let releaseRefresh;
const race = makeService(credential(1, 0), { oauth: { refresh: () => new Promise(resolve => { releaseRefresh = resolve; }) } });
const inflight = race.service.getCredential();
while (!releaseRefresh) await new Promise(resolve => setTimeout(resolve, 0));
const logout = race.service.logout();
releaseRefresh(credential(2));
await inflight; await logout;
assert.equal((await race.service.status()).loggedIn, false, "logout must not be undone by a refresh");
const failure = makeService(credential(1, 0), { oauth: { refresh: async () => { throw new Error("temporary failure"); } } });
await assert.rejects(failure.service.getCredential(), /temporary/);
assert.equal((await failure.store.read(CHATGPT_PROVIDER_ID)).refresh_token, "refresh-1");
await failure.service.logout();
await assert.rejects(failure.service.getCredential(), /登录/);

// Persist errors fail the request and do not report a successful login.
const unavailableStore = new CredentialStore({
  read: async () => null, write: async () => { throw new Error("disk locked"); }, delete: async () => {},
});
const diskFailure = makeService(null, {
  store: unavailableStore, oauth: { exchange: async () => credential() },
});
await assert.rejects(diskFailure.service.login({ onAuth: notice => diskFailure.service.completeLogin(
  OAUTH_REDIRECT_URI + "?code=x&state=" + new URL(notice.url).searchParams.get("state"),
) }), /disk locked/);

// End-to-end client -> provider -> transport -> Responses parsing, with 401 recovery.
const config = new ConfigStore();
config.createModelProfile({ provider: CHATGPT_PROVIDER_ID, model: "gpt-5.6-sol", apiKey: "must-not-persist" });
assert.equal(config.getActiveModelProfile().apiKey, "");
const liveAuth = makeService(credential());
let requests = [];
const transport = { fetch: async (address, init) => {
  requests.push({ address, init });
  return requests.length === 1 ? new Response("unauthorized", { status: 401 }) : sse(events);
}, delay: async () => {} };
const client = buildClientFromStore(config, { subscriptionAuth: liveAuth.service, transport });
assert.equal(client.apiKey, "");
assert.equal(client.contextWindowTokens, 272000);
assert.equal(isVisionModel(client.model), true);
const result = await client.chat([{ role: "system", content: "system rules" }, { role: "user", content: "hello" }]);
assert.equal(result.content, "你好");
assert.equal(result.usage.input_tokens, 12);
assert.equal(requests.length, 2);
assert.equal(requests[0].address, CHATGPT_ENDPOINT);
assert.equal(requests[0].init.headers.Authorization, "Bearer " + credential().access_token);
assert.equal(requests[1].init.headers.Authorization, "Bearer " + credential(2).access_token);
assert.equal(requests[1].init.headers["ChatGPT-Account-Id"], "account-a");
assert.equal(requests[1].init.redirect, "error");
const body = JSON.parse(requests[1].init.body);
assert.equal(body.instructions, "system rules");
assert.equal(body.stream, true);
assert.equal(body.store, false);
assert.equal(body.temperature, undefined);
assert.equal(body.max_tokens, undefined);
await assert.rejects(new ChatGptSubscriptionProvider(liveAuth.service).authorize({
  url: "https://evil.example/codex/responses", init: {},
}), /官方/);
assert.throws(() => buildClientFromStore(config, { baseUrl: "https://evil.example" }), /自定义端点/);
let failures = 0;
const unauthorized = buildClientFromStore(config, { subscriptionAuth: liveAuth.service, transport: {
  fetch: async () => { failures++; return new Response("access-token-secret", { status: 401 }); },
} });
await assert.rejects(unauthorized.chat([{ role: "user", content: "hello" }]), error => error.status === 401 && error.body === null);
assert.equal(failures, 2, "persistent 401 must not loop forever");
const abort = new AbortController();
abort.abort();
await assert.rejects(client.chat([{ role: "user", content: "hello" }], { signal: abort.signal }));
assert.equal(requests.length, 2);

// Tool/image history, tools definition, and reasoning stream callbacks.
const tool = { type: "function_call", call_id: "call_1", name: "page_info", arguments: '{"x":1}' };
const replay = JSON.parse(client.buildRequest([
  { role: "system", content: "rules" },
  { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", function: { name: "page_info", arguments: '{"x":1}' } }] },
  { role: "tool", tool_call_id: "call_1", content: "result" },
], { tools: [{ type: "function", function: { name: "page_info", parameters: { type: "object", properties: {} } } }],
  reasoningEffort: "high", cacheKey: "session-a" }).init.body);
assert.equal(replay.input[0].content[1].type, "input_image");
assert.deepEqual(replay.input[1], tool);
assert.equal(replay.input[2].call_id, "call_1");
assert.equal(replay.input[2].type, "function_call_output");
assert.equal(replay.tools[0].strict, false);
assert.equal(replay.tools[0].name, "page_info");
assert.equal(replay.reasoning.effort, "high");
let deltas = "", reasoning = "";
const streamed = await readCodexStream(sse([
  { type: "response.reasoning_summary_text.delta", delta: "thinking" },
  { type: "response.output_text.delta", delta: "你好" },
  { type: "response.output_item.done", output_index: 1, item: tool },
  completed([message("你好"), tool]),
], { split: true, finalNewline: false }), {
  onDelta: value => { deltas += value; }, onReasoning: value => { reasoning += value; },
});
assert.equal(deltas, "你好");
assert.equal(reasoning, "thinking");
assert.equal(streamed.toolCalls[0].function.arguments, '{"x":1}');
assert.equal(streamed.finishReason, "tool_calls");

// Codex may send the complete items before a compact terminal response.
// An empty/partial terminal output must never erase an already delivered call.
for (const output of [undefined, [], [message("starting")]]) {
  const compact = await readCodexStream(sse([
    { type: "response.output_item.done", output_index: 0, item: message("starting") },
    { type: "response.output_item.done", output_index: 1, item: tool },
    completed(output),
  ], { split: true }));
  assert.equal(compact.toolCalls.length, 1, "terminal output erased streamed tool call");
  assert.equal(compact.content, "starting");
  assert.equal(compact.finishReason, "tool_calls");
}

await assert.rejects(readCodexStream(sse([{ type: "response.output_text.delta", delta: "partial" }])), /响应流.*中断/);
await assert.rejects(readCodexStream(sse([{ type: "response.failed" }])), /失败/);
await assert.rejects(readCodexStream(sse([{ type: "response.incomplete" }])), /未完成/);
const callbackFailure = await readCodexStream(sse([
  { type: "response.output_text.delta", delta: "x" }, ...events,
]), { onDelta: () => { throw new Error("UI unavailable"); } });
assert.equal(callbackFailure.content, "你好");

// Identity merge deduplicates full terminal output and preserves partial output.
const identifiedTool = { ...tool, id: "fc_test" };
const identifiedMessage = { ...message("starting"), id: "msg_test" };
for (const terminalType of ["response.completed", "response.done"]) {
  const merged = await readCodexStream(sse([
    { type: "response.output_item.done", output_index: 0, item: identifiedMessage },
    { type: "response.output_item.done", output_index: 1, item: identifiedTool },
    { ...completed([identifiedTool]), type: terminalType },
  ]));
  assert.equal(merged.toolCalls.length, 1);
  assert.equal(merged.content, "starting");
}
await assert.rejects(readCodexStream(sse([
  { type: "response.output_item.done", output_index: 0, item: tool },
  { type: "response.done", response: { status: "failed", output: [] } },
])), /失败/);

// Full Runtime -> subscription client -> SSE -> dispatch -> tool-result replay.
let rounds = 0, dispatched = 0;
const loopClient = buildClientFromStore(config, { subscriptionAuth: liveAuth.service, transport: {
  fetch: async (_address, init) => {
    const sent = JSON.parse(init.body);
    assert.equal(sent.tools[0].name, "page_info");
    rounds++;
    if (rounds === 1) return sse([
      { type: "response.output_text.delta", delta: "starting" },
      { type: "response.output_item.done", output_index: 0, item: identifiedMessage },
      { type: "response.output_item.done", output_index: 1, item: identifiedTool },
      completed([]),
    ], { split: true });
    assert.equal(rounds, 2, "must not drift or keep retrying after a tool response");
    assert.ok(sent.input.some(item => item.type === "function_call_output" &&
      item.call_id === "call_1" && item.output.includes("test-page")));
    return sse([completed([message("已完成测试")])]);
  },
} });
const loopResult = await runAgentTurn({
  client: loopClient, messages: [{ role: "user", content: "Inspect the test page" }],
  maxRounds: 3, assist: true,
  router: {
    listSpecs: () => [{ type: "function", function: {
      name: "page_info", parameters: { type: "object", properties: { x: { type: "number" } } },
    } }],
    needsConfirm: () => false,
    dispatch: async (name, args) => {
      assert.equal(name, "page_info");
      assert.deepEqual(args, { x: 1 });
      dispatched++;
      return { ok: true, data: { title: "test-page" } };
    },
  },
});
assert.equal(dispatched, 1);
assert.equal(rounds, 2);
assert.equal(loopResult.stopReason, "final");
assert.equal(loopResult.content, "已完成测试");

// Firefox's reader error must be distinguished from an API/protocol rejection.
function brokenStream(partial = false, abortSignal = null) {
  let reads = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (partial && reads++ === 0) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      } else {
        abortSignal?.abort();
        controller.error(new TypeError("Error in input stream"));
      }
    },
  }));
}
let brokenAttempts = 0;
// Use ordinary timers for the request watchdog, while keeping test retries short.
const makeBrokenClient = fetch => buildClientFromStore(config, {
  subscriptionAuth: liveAuth.service, transport: {
    fetch,
    setTimeout: (fn, ms) => setTimeout(fn, ms < 2000 ? 0 : ms),
    clearTimeout,
  },
});
brokenAttempts = 0;
const recovered = await makeBrokenClient(async () =>
  ++brokenAttempts < 3 ? brokenStream() : sse(events)
).chat([{ role: "user", content: "hello" }]);
assert.equal(recovered.content, "你好");
assert.equal(brokenAttempts, 3);
brokenAttempts = 0;
await assert.rejects(makeBrokenClient(async () => {
  brokenAttempts++; return brokenStream();
}).chat([{ role: "user", content: "hello" }]), error =>
  error instanceof CodexStreamInterruptedError && !error.partial && /继续/.test(error.message));
assert.equal(brokenAttempts, 3, "reader failures must have a bounded retry budget");
brokenAttempts = 0;
let partialText = "";
await assert.rejects(makeBrokenClient(async () => {
  brokenAttempts++; return brokenStream(true);
}).chat([{ role: "user", content: "hello" }], { onDelta: text => { partialText += text; } }),
  error => error instanceof CodexStreamInterruptedError && error.partial);
assert.equal(brokenAttempts, 1, "partial output must not be silently replayed");
assert.equal(partialText, "partial");
brokenAttempts = 0;
await assert.rejects(makeBrokenClient(async () => {
  brokenAttempts++; return sse([{ type: "response.failed" }]);
}).chat([{ role: "user", content: "hello" }]), /失败/);
assert.equal(brokenAttempts, 1, "server rejection is not a reader failure");
const streamAbort = new AbortController();
brokenAttempts = 0;
await assert.rejects(makeBrokenClient(async () => {
  brokenAttempts++; return brokenStream(false, streamAbort);
}).chat([{ role: "user", content: "hello" }], { signal: streamAbort.signal }), /aborted/);
assert.equal(brokenAttempts, 1, "user cancellation must not retry");

// Existing API-key providers still use their endpoint, key and JSON format.
const keyProfile = config.createModelProfile({ provider: "deepseek", apiKey: "key-a", model: "deepseek-v4-flash" });
let keyRequest;
const keyClient = buildClientFromStore(config, { transport: { fetch: async (address, init) => {
  keyRequest = { address, init };
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
} } });
assert.equal((await keyClient.chat([{ role: "user", content: "hello" }])).content, "ok");
assert.equal(keyRequest.init.headers.Authorization, "Bearer key-a");
assert.match(keyRequest.address, /api.deepseek.com/);
assert.ok(JSON.parse(keyRequest.init.body).messages);
assert.equal(config.getModelProfile(keyProfile.id).apiKey, "key-a");
console.log("ChatGPT subscription: PKCE, storage, refresh races, login, 401, Responses, tools, abort and API-key coexistence OK");
