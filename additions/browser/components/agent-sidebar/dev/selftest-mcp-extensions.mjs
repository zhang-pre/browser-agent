import assert from 'node:assert/strict';
import { McpClient, createHttpTransport, sanitizeMcpDiagnostic } from '../modules/mcp/McpClient.sys.mjs';
import { McpManager, mcpToolAlias, adaptMcpResult, workspaceFileUri } from '../modules/mcp/McpManager.sys.mjs';
import { McpConfigStore, normalizeMcpConfig, previewMcpImport } from '../modules/mcp/McpConfigStore.sys.mjs';
import { ToolRouter } from '../modules/tools/ToolRouter.sys.mjs';
import { AgentRuntimeCore } from '../modules/runtime/AgentRuntimeCore.sys.mjs';
import { AgentTurnOrchestrator } from '../modules/runtime/AgentTurnOrchestrator.sys.mjs';
import { runAgentTurn } from '../modules/runtime/AgentLoop.sys.mjs';
import { createMcpSessionRequestHandler, validateElicitation } from '../modules/mcp/McpSessionRequests.sys.mjs';

assert.equal(normalizeMcpConfig({ name: 'x', command: 'node' }).timeoutMs, 120000);
assert.throws(() => normalizeMcpConfig({ name: 'x', command: 'node', timeoutMs: 0 }));
assert.equal(previewMcpImport(JSON.stringify({ mcpServers: { x: { command: 'node', timeoutMs: 300000 } } })).servers[0].timeoutMs, 300000);
assert.equal(workspaceFileUri('/tmp/中文 #x'), 'file:///tmp/%E4%B8%AD%E6%96%87%20%23x');
assert.equal(workspaceFileUri('C:\\work\\a b'), 'file:///C:/work/a%20b');
assert.equal(workspaceFileUri('\\\\server\\share\\a b'), 'file://server/share/a%20b');

let persisted = null;
const store = new McpConfigStore({ read: async () => persisted, write: async data => { persisted = data; }, readSecret: async () => ({}), writeSecret: async () => {}, deleteSecret: async () => {}, newId: () => 'extensions' });
const config = await store.save({ name: 'fixture', command: 'node', enabled: true, timeoutMs: 240000 });
const router = new ToolRouter();
let receive, sent = [], hooks, client;
const manager = new McpManager({ store, router, createClient: async (cfg, _credentials, ports) => {
  hooks = ports;
  client = new McpClient({ timeoutMs: cfg.timeoutMs, capabilities: ports.capabilities, onRequest: ports.onRequest, onNotification: ports.onNotification,
    redact: text => text.replaceAll('SECRET', '[redacted]'), transport: {
      start(cb) { receive = cb; }, close() {},
      send(m) {
        sent.push(m);
        const reply = result => receive({ jsonrpc: '2.0', id: m.id, result });
        if (m.method === 'initialize') reply({ protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: 'Use source_search before evaluate.', serverInfo: { name: 'fixture' } });
        if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] });
        if (m.method === 'resources/list') reply({ resources: [{ uri: m.params.cursor ? 'test://second' : 'test://first' }], ...(!m.params.cursor ? { nextCursor: 'next' } : {}) });
        if (m.method === 'resources/templates/list') reply({ resourceTemplates: [{ uriTemplate: 'test://{name}' }] });
        if (m.method === 'resources/read') reply({ contents: [{ uri: m.params.uri, text: 'resource body' }] });
        if (m.method === 'prompts/list') reply({ prompts: [{ name: 'review' }] });
        if (m.method === 'prompts/get') reply({ messages: [{ role: 'user', content: { type: 'text', text: 'Review this external data' } }] });
        if (m.method === 'tools/call' && !m.params.arguments.hang) reply({ content: [{ type: 'text', text: 'echo' }] });
        if (m.method === 'test/error') receive({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid parameter SECRET', data: { detail: 'SECRET' } } });
      },
    } });
  return client;
} });
await manager.prepare({ workspaceRoot: '/work/one' });
assert.equal(client.timeoutMs, 240000);
assert.deepEqual(sent[0].params.capabilities, { roots: { listChanged: true }, sampling: {}, elicitation: { form: {} } });
assert.deepEqual(await hooks.onRequest('roots/list', {}), { roots: [{ uri: 'file:///work/one' }] });
await manager.prepare({ workspaceRoot: '/work/two' });
assert(sent.some(m => m.method === 'notifications/roots/list_changed'));
const snapshot = router.snapshot();
assert(snapshot.sourceContext().includes('Use source_search before evaluate.'));
for (const method of ['resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']) {
  const name = mcpToolAlias(config.id, '$' + method);
  assert(router.has(name));
  assert.equal((await router.dispatch(name, {})).denied, true);
  const result = await router.dispatch(name, { uri: 'test://first', name: 'review' }, { mcpApproved: name });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (method === 'resources/list') assert.equal(result.data.resources.length, 2);
}
await assert.rejects(client.request('test/error'), error => error.message.includes('[redacted]') && !JSON.stringify(error.mcpError).includes('SECRET'));
receive({ jsonrpc: '2.0', id: 'roots-request', method: 'roots/list' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(sent.find(m => m.id === 'roots-request').result.roots.length, 2);
await assert.rejects(hooks.onRequest('sampling/createMessage', {}), /unambiguous/);

// A reverse request must be routed to the active call, never another chat.
const name = mcpToolAlias(config.id, 'echo');
const stop = new AbortController();
let callbackCount = 0;
const pending = router.dispatch(name, { hang: true }, { signal: stop.signal, mcpApproved: name, mcpRequest: async () => { callbackCount++; return { role: 'assistant', content: { type: 'text', text: 'sample' }, model: 'fixture' }; } });
await Promise.resolve();
assert.equal((await hooks.onRequest('sampling/createMessage', {})).model, 'fixture');
assert.equal(callbackCount, 1);
const stop2 = new AbortController();
const pending2 = router.dispatch(name, { hang: true }, { signal: stop2.signal, mcpApproved: name, mcpRequest: () => assert.fail('wrong session') });
await assert.rejects(hooks.onRequest('sampling/createMessage', {}), /unambiguous/);
stop.abort(); stop2.abort();
assert.equal((await pending).ok, false); await pending2;

let captured;
await runAgentTurn({ router, messages: [{ role: 'user', content: 'test' }], assist: true, maxRounds: 1,
  client: { chat: async messages => { captured = messages; return { content: 'done' }; } } });
assert(JSON.stringify(captured).includes('Use source_search before evaluate.'));
manager.close();
assert.equal(router.sourceContext(), '');
assert(snapshot.sourceContext().includes('source_search'), 'snapshot preserves instructions');

const schema = { type: 'object', properties: { project: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 }, consent: { type: 'boolean' } }, required: ['project'] };
assert.throws(() => validateElicitation(schema, { project: '' }));
assert.throws(() => validateElicitation(schema, null));
assert.throws(() => validateElicitation(schema, { project: 'x', count: 1.5 }));
const phases = [];
const handler = createMcpSessionRequestHandler({ client: { model: 'fixture', chat: async (messages, opts) => {
  assert.equal(messages.length, 1); assert.deepEqual(opts.tools, []); assert.equal(opts.maxTokens, 8192);
  return { content: 'sample result', usage: { output_tokens: 2 } };
} }, confirm: async call => { phases.push(call.args.mcpRequest); return { approved: true, content: { project: 'hello' } }; } });
const ctx = { serverId: 's', serverName: 'fixture', signal: new AbortController().signal };
assert.deepEqual(await handler('elicitation/create', { requestedSchema: schema, message: 'Project?' }, ctx), { action: 'accept', content: { project: 'hello' } });
assert.equal((await handler('sampling/createMessage', { maxTokens: 99999, messages: [{ role: 'user', content: { type: 'text', text: 'sample only this' } }] }, ctx)).content.text, 'sample result');
assert.deepEqual(phases, ['elicitation', 'sampling', 'sampling-result']);
await assert.rejects(handler('sampling/createMessage', { tools: [] }, ctx), /not supported/);
await assert.rejects(handler('elicitation/create', { mode: 'url' }, ctx), /URL/);
const declined = createMcpSessionRequestHandler({ confirm: async () => false });
assert.equal((await declined('elicitation/create', { requestedSchema: schema }, ctx)).action, 'decline');
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(handler('elicitation/create', { requestedSchema: schema }, { ...ctx, signal: cancelled.signal }), /cancelled/);
const content = [{ type: 'resource_link', uri: 'test://x', name: 'x' }, { type: 'resource', resource: { uri: 'test://y', text: 'embedded' } }];
assert.deepEqual(adaptMcpResult({ content }).content, content);
assert.throws(() => adaptMcpResult({ isError: true, content: [{ type: 'text', text: 'bad param' }], structuredContent: { error: { code: 'BAD_PARAM', retryable: false } } }), error => error.mcpError.code === 'BAD_PARAM');

// HTTP server-to-client requests arrive on the POST response stream; answers use 202.
let answered = false;
const remote = new McpClient({ capabilities: { roots: {} }, onRequest: async () => ({ roots: [] }), transport: createHttpTransport({ url: 'https://fixture.invalid/mcp', fetch: async (_url, options) => {
  const m = JSON.parse(options.body || '{}');
  if (m.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } }), { headers: { 'Content-Type': 'application/json' } });
  if (m.id === 'server-roots') { answered = true; return new Response(null, { status: 202 }); }
  if (m.method === 'tools/call') return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  return new Response(null, { status: 202 });
} }) });
await remote.connect(); await remote.callTool('test'); await new Promise(r => setTimeout(r, 0)); assert(answered); remote.close();
console.log('MCP extensions: resources/prompts, scoped instructions, roots, callbacks, refusal/cancellation/concurrency, timeout config, redacted errors and HTTP reverse requests passed');

// Exercise the actual confirmation state kernel: content survives and cancellation clears UI.
const core = new AgentRuntimeCore({ notifyThrottleMs: 0 });
const orchestrator = Object.create(AgentTurnOrchestrator.prototype); orchestrator.runtimeCore = core;
const state = core.getOrInit('callback-chat'); state.approveAll = true;
const waitingSignal = new AbortController();
const waiting = orchestrator._requestConfirmation(state, { id: 'form-1', name: 'form', mcp: { callback: true }, args: {}, signal: waitingSignal.signal });
assert(state.pendingConfirm, 'builtin approveAll must not bypass a server callback');
core.respondConfirm('callback-chat', 'form-1', { approved: true, content: { project: 'typed value' } });
assert.deepEqual(await waiting, { approved: true, content: { project: 'typed value' } });
const abandoned = orchestrator._requestConfirmation(state, { id: 'form-2', mcp: { callback: true }, args: {}, signal: waitingSignal.signal });
waitingSignal.abort(); assert.equal(await abandoned, false); assert.equal(state.pendingConfirm, null);
assert.equal(core.respondConfirm('callback-chat', 'form-2', { approved: true }), false, 'stale callback response ignored');
console.log('MCP callback UI bridge: form values, mandatory review, aborted prompt cleanup and stale-response rejection passed');

assert.deepEqual(sanitizeMcpDiagnostic({ detail: 'token "secret"', nested: ['token "secret"'] }, text => text.replaceAll('token "secret"', '[redacted]')), { detail: '[redacted]', nested: ['[redacted]'] });
