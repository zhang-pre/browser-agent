import assert from 'node:assert/strict';
import { McpConfigStore, previewMcpImport } from '../modules/mcp/McpConfigStore.sys.mjs';
import { McpManager, mcpToolAlias } from '../modules/mcp/McpManager.sys.mjs';
import { ToolRouter } from '../modules/tools/ToolRouter.sys.mjs';
import { createBuiltinTools } from '../modules/tools/Tools.sys.mjs';
import { runAgentTurn } from '../modules/runtime/AgentLoop.sys.mjs';
const clone = x => structuredClone(x);
function profile(initial = null) {
  let data = initial, nextId = 0; const secrets = new Map();
  const store = new McpConfigStore({ read: async () => clone(data), write: async x => { data = clone(x); },
    readSecret: async id => clone(secrets.get(id)), writeSecret: async (id, value) => { secrets.set(id, clone(value)); },
    deleteSecret: async id => { secrets.delete(id); }, newId: () => `server_${++nextId}` });
  return { store, secrets, persisted: () => clone(data) };
}
const a = profile(), b = profile();
let config = await a.store.save({ name: 'local', command: 'node', args: ['server.js'], env: { API_KEY: 'SECRET_ENV' }, headers: { Authorization: 'SECRET_HEADER' }, enabled: true });
assert.deepEqual(await b.store.list(), []);
assert.equal((await a.store.credentials(config.id)).env.API_KEY, 'SECRET_ENV');
assert.ok(!JSON.stringify(await a.store.list()).includes('SECRET_'));
assert.ok(!JSON.stringify(a.persisted()).includes('SECRET_'));
assert.ok(!JSON.stringify(await a.store.exportConfig()).includes('SECRET_'));
await a.store.setPolicy(config.id, 'safe', 'allow'); await a.store.setPolicy(config.id, 'forbidden', 'deny');
config = await a.store.save({ ...config, args: ['changed.js'] });
assert.equal(config.policies.safe, undefined); assert.equal(config.policies.forbidden, 'deny');
const preview = previewMcpImport(JSON.stringify({ other: 1, mcpServers: { import: { command: 'node', enabled: true, disabled: false, env: { KEY: 'secret' }, unsupported: 4 } } }));
assert.equal(preview.servers[0].enabled, false); assert.equal(preview.warnings.length, 2);
assert.equal(preview.servers[0].unsupported, undefined);
const unsafe = profile({ version: 1, servers: [{ id: 'bad', name: 'bad', command: 'node', env: { KEY: 'secret' } }] });
await assert.rejects(unsafe.store.list(), /加密/);

const p = profile(), router = new ToolRouter();
let creations = 0;
const fixtures = new Map();
const schema = { type: 'object', properties: {} };
const tools = [{ name: 'echo', inputSchema: schema }, { name: 'wait', inputSchema: schema }, { name: 'picture', inputSchema: schema }, { name: 'error', inputSchema: schema }];
const manager = new McpManager({ store: p.store, router, createClient: async (cfg, secret, hooks) => {
  creations++;
  const fixture = { closed: false, closes: 0, calls: [], lists: 0, tools: clone(tools), hooks,
    async connect() { if (cfg.name === 'broken') throw new Error('SECRET_ENDPOINT_ERROR'); },
    async listTools() { this.lists++; return clone(this.tools); },
    async callTool(name, args, { signal }) {
      this.calls.push(name);
      if (name === 'wait') return new Promise((resolve, reject) => { if (signal.aborted) reject(new Error('cancelled')); else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); });
      if (name === 'picture') return { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], structuredContent: { value: 1 } };
      if (name === 'error') return { isError: true, content: [{ type: 'text', text: 'tool failed' }] };
      return { content: [{ type: 'text', text: String(args.value || 'echo') }] };
    },
    close() { this.closed = true; this.closes++; },
  };
  fixtures.set(cfg.id, fixture); return fixture;
} });
const good = await manager.save({ name: 'good', command: 'node', enabled: true });
const broken = await manager.save({ name: 'broken', command: 'missing', enabled: true });
await Promise.all([manager.prepare(), manager.prepare()]);
assert.equal(creations, 2, 'concurrent preparation shares each connection');
assert.equal((await manager.list()).find(s => s.id === broken.id).status, 'error');
assert.ok(!JSON.stringify(await manager.list()).includes('SECRET_'));
const alias = name => mcpToolAlias(good.id, name);
assert.equal(router.names().length, 4);
assert.equal((await router.dispatch(alias('echo'), {})).denied, true, 'raw dispatch ask cannot run');
assert.equal((await router.dispatch(alias('echo'), { value: 'ok' }, { mcpApproved: alias('echo') })).data.content[0].text, 'ok');
await manager.setPolicy(good.id, 'echo', 'allow');
assert.equal((await router.dispatch(alias('echo'), {})).ok, true);
const image = await router.dispatch(alias('picture'), {}, { mcpApproved: alias('picture') });
assert.equal(image.media[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
assert.equal(image.data.structuredContent.value, 1); assert.equal(image.data._media, undefined);
assert.equal((await router.dispatch(alias('error'), {}, { mcpApproved: alias('error') })).ok, false);
await manager.setPolicy(good.id, 'wait', 'allow');
const waiting = router.dispatch(alias('wait'), {});
await manager.setPolicy(good.id, 'wait', 'deny');
assert.match((await waiting).error, /cancelled/);
assert.equal((await router.dispatch(alias('wait'), {}, { mcpApproved: alias('wait') })).denied, true);

const old = router.snapshot(), connected = fixtures.get(good.id);
connected.tools[0].inputSchema.properties = { changed: { type: 'string' } };
connected.hooks.onNotification({ method: 'notifications/tools/list_changed' });
await Promise.all([manager.prepare(), manager.prepare()]);
assert.equal(fixtures.get(good.id), connected); assert.equal(connected.closes, 0, 'refresh keeps shared connection');
assert.equal(connected.lists, 2, 'one refresh per concurrent turn');
assert.equal(router.getPermission(alias('echo')).policy, 'ask', 'schema change revokes allow');
assert.equal(router.getPermission(alias('wait')).policy, 'deny', 'deny survives refresh');
assert.equal((await old.dispatch(alias('echo'), {}, { mcpApproved: alias('echo') })).denied, true, 'old snapshot cannot route to changed tool');
// The notification callback must target the replacement entry on later refreshes.
connected.tools.push({ name: 'new-tool', inputSchema: schema });
connected.hooks.onNotification({ method: 'notifications/tools/list_changed' });
await manager.prepare(); assert.ok(router.has(alias('new-tool'))); assert.equal(connected.lists, 3);
await manager.setPolicy(good.id, 'echo', 'allow');
connected.closed = true;
assert.equal((await router.dispatch(alias('echo'), {})).denied, true);
assert.equal((await manager.list()).find(s => s.id === good.id).status, 'error');
await manager.prepare(); assert.notEqual(fixtures.get(good.id), connected, 'closed client reconnects');
assert.equal(router.getPermission(alias('echo')).policy, 'ask', 'reconnect schema change revokes prior allow');
const beforeDisable = router.snapshot();
await manager.setEnabled(good.id, false);
assert.equal((await beforeDisable.dispatch(alias('echo'), {}, { mcpApproved: alias('echo') })).denied, true);
assert.equal(router.has(alias('echo')), false);
await manager.test(good.id); assert.equal(router.has(alias('echo')), false, 'test disabled connection does not publish');
await manager.setEnabled(good.id, true); await manager.prepare(); assert.ok(router.has(alias('echo')));
const cleanPreview = await manager.previewImport(JSON.stringify({ mcpServers: { imported: { command: 'node', env: { KEY: 'SECRET_IMPORT' }, enabled: true } } }));
assert.ok(!JSON.stringify(cleanPreview).includes('SECRET_IMPORT'));
await manager.importConfig(JSON.stringify({ mcpServers: { imported: { command: 'node', env: { KEY: 'SECRET_IMPORT' }, enabled: true } } }));
assert.equal((await manager.list()).find(s => s.name === 'imported').enabled, false);
// An approval waiting behind an edit must not authorize the replacement server.
const staleApproval = router.snapshot();
const edit = manager.save({ ...(await p.store.list()).find(s => s.id === good.id), args: ['replacement.js'] });
const approve = staleApproval.approveAlways(alias('echo'));
await edit; await assert.rejects(approve, /变更|disabled/);
assert.notEqual(p.store.cached(good.id).policies.echo, 'allow');
manager.close(); assert.equal(router.names().length, 0);
console.log('MCP manager/config: isolation, credentials, import/export, policy reset, shared connections, refresh, snapshots, denial/cancel, results, failure isolation and lifecycle passed');

// HTTP has no background GET subscription: poll at turn boundaries without
// invalidating unchanged snapshots or cancelling another Agent's active call.
const hp = profile(), hr = new ToolRouter();
let listCount = 0, closeCount = 0, callSignal, finishCall;
let catalog = [{ name: 'long', inputSchema: { type: 'object', properties: {} } }];
const hm = new McpManager({ store: hp.store, router: hr, createClient: async () => ({
  closed: false, async connect() {}, async listTools() { listCount++; return clone(catalog); },
  callTool(name, args, { signal }) { callSignal = signal; return new Promise(resolve => { finishCall = resolve; }); },
  close() { closeCount++; this.closed = true; },
}) });
const hc = await hm.save({ name: 'http', transport: 'http', url: 'https://example.invalid/mcp', enabled: true });
await hm.prepare();
await hm.setPolicy(hc.id, 'long', 'allow');
const ha = mcpToolAlias(hc.id, 'long'), runningSnapshot = hr.snapshot();
const running = runningSnapshot.dispatch(ha, {});
// Same schema, different object key insertion order.
catalog = [{ inputSchema: { properties: {}, type: 'object' }, name: 'long' }];
await Promise.all([hm.prepare(), hm.prepare()]);
assert.equal(listCount, 2); assert.equal(closeCount, 0); assert.equal(callSignal.aborted, false);
assert.equal(runningSnapshot.getPermission(ha).policy, 'allow');
finishCall({ content: [{ type: 'text', text: 'finished' }] });
assert.equal((await running).ok, true);
await hm.prepare(); assert.equal(listCount, 3, 'each later HTTP turn polls');
catalog.push({ name: 'added', inputSchema: schema });
await hm.prepare(); assert.equal(hr.has(mcpToolAlias(hc.id, 'added')), true);
assert.equal(runningSnapshot.getPermission(ha).policy, 'deny', 'changed catalog invalidates old generation');
// Credential deletion can fail after the durable server deletion: always stop it.
hp.store.deleteSecret = async () => { throw new Error('SECRET_KEYSTORE_ERROR'); };
await assert.rejects(hm.remove(hc.id), /配置已删除.*凭证清理失败/);
assert.equal((await hp.store.list()).length, 0); assert.equal(hr.names().length, 0); assert.equal(closeCount, 1);
hm.close();
// A temporarily unavailable profile file does not permanently poison init().
const retry = profile(); let reads = 0;
retry.store.read = async () => { if (++reads === 1) throw new Error('temporarily unavailable'); return null; };
await assert.rejects(retry.store.list(), /temporarily/);
assert.deepEqual(await retry.store.list(), []); assert.equal(reads, 2);
console.log('MCP manager: unchanged shared snapshots, concurrent HTTP polling, delete cleanup and initialization retry passed');

// Regression: a Firefox navigation must never be presented as evidence from
// js-reverse's independent Chrome network queue. Verify the actual model/tool
// boundary, including empty successes, without making live site/model requests.
const bp = profile(), br = new ToolRouter();
let firefoxCalls = 0, chromeCalls = [];
br.registerAll(createBuiltinTools({ page: { navigate: async () => { firefoxCalls++; } } }));
const browserTools = ['select_page', 'new_page', 'navigate_page', 'list_network_requests', 'picture', 'error']
  .map(name => ({ name, inputSchema: schema, description: 'upstream description' }));
const bm = new McpManager({ store: bp.store, router: br, createClient: async cfg => ({
  closed: false,
  async connect() { return { serverInfo: { name: cfg.name === 'renamed browser' ? 'js-reverse' : 'unrelated' } }; },
  async listTools() { return browserTools; },
  async callTool(name) {
    chromeCalls.push(name);
    if (name === 'error') return { isError: true, content: [{ type: 'text', text: 'failed upstream' }] };
    if (name === 'picture') return { content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] };
    return { content: [{ type: 'text', text: 'No requests found.' }],
      structuredContent: { ok: true, data: { requests: [] } } };
  },
  close() { this.closed = true; },
}) });
const bc = await bm.save({ name: 'renamed browser', command: 'node', enabled: true });
const unrelated = await bm.save({ name: 'js-reverse', command: 'unrelated', enabled: true });
const packaged = await bm.save({ name: 'local package', command: 'node', args: ['C:\\tools\\node_modules\\js-reverse-mcp\\build\\src\\index.js'], enabled: false });
await bm.prepare();
const ba = name => mcpToolAlias(bc.id, name);
const descriptions = br.listSpecs().map(s => s.function);
assert.match(descriptions.find(s => s.name === 'page_navigate').description, /Firefox.*MCP/);
const networkDescription = descriptions.find(s => s.name === ba('list_network_requests')).description;
assert.match(networkDescription, /独立 Chrome\/Chromium/);
assert(networkDescription.includes(ba('select_page')));
assert(networkDescription.includes(ba('new_page')));
assert(networkDescription.includes(ba('navigate_page')));
assert.match(networkDescription, /Set-Cookie.*document.cookie/);
assert.match(networkDescription, /allowedRoots/);
assert(!descriptions.find(s => s.name === mcpToolAlias(unrelated.id, 'select_page')).description.includes('Chrome/Chromium'), 'display name alone does not classify a server');
const statuses = await bm.list();
assert.equal(statuses.find(s => s.id === packaged.id).executionContext.browser, 'Chrome/Chromium');
assert.equal(statuses.find(s => s.id === unrelated.id).executionContext.browser, undefined);
assert.equal(statuses.find(s => s.id === bc.id).executionContext.connection, 'local-process');
let modelCalls = 0;
const browserResult = await runAgentTurn({ router: br, messages: [], assist: true, maxRounds: 2, mcpAutoApprove: true,
  client: { async chat(messages, options) {
    if (modelCalls++ === 0) {
      assert(options.tools.find(t => t.function.name === ba('list_network_requests')).function.description.includes('Chrome/Chromium'));
      return { toolCalls: [{ id: 'network', type: 'function', function: { name: ba('list_network_requests'), arguments: '{}' } }] };
    }
    const evidence = JSON.parse(messages.findLast(m => m.role === 'tool').content);
    assert.equal(evidence.ok, true, 'empty network result remains a successful tool call');
    assert.equal(evidence.data.executionContext.browserContext, 'independent-of-firefox');
    assert.equal(evidence.data.executionContext.serverId, bc.id);
    assert.deepEqual(evidence.data.structuredContent.data.requests, []);
    assert.match(evidence.data.browserGuidance, /空结果先检查/);
    return { content: 'Check the Chrome target before interpreting empty evidence.' };
  } },
});
assert.equal(browserResult.toolCalls[0].env.ok, true);
assert.equal(firefoxCalls, 0);
assert.deepEqual(chromeCalls, ['list_network_requests']);
const chromeImage = await br.dispatch(ba('picture'), {}, { mcpApproved: ba('picture') });
assert.equal(chromeImage.media[0].dataUrl, 'data:image/png;base64,aGVsbG8=');
assert.equal(chromeImage.data.executionContext.browser, 'Chrome/Chromium');
assert.equal((await br.dispatch(ba('error'), {}, { mcpApproved: ba('error') })).ok, false);
bm.close();
console.log('MCP browser context: identity, renamed/package servers, Firefox separation, empty evidence through AgentLoop, images and errors passed');

// Selected directories augment only the local js-reverse launch. Reconnection
// invalidates stale snapshots/IDs, never replays a call, and leaves config alone.
const wp = profile(), wr = new ToolRouter(), launches = [], clients = [];
let finishBusy;
const wm = new McpManager({ store: wp.store, router: wr,
  resolveWorkspace: async root => { if (root === '/missing') throw Error('missing directory'); return root.replace('/link/', '/real/'); },
  createClient: async config => {
    launches.push(clone(config));
    const client = { closed: false, calls: [], async connect() { return { serverInfo: { name: config.name.startsWith('wrapped') ? 'js-reverse' : 'other' } }; },
      async listTools() { return [{name:'list_network_requests', inputSchema:schema}, {name:'evaluate_script', inputSchema:schema}, {name:'wait', inputSchema:schema}]; },
      async callTool(name,args) { this.calls.push({name,args}); if (name === 'wait') await new Promise(resolve=>{finishBusy=resolve;}); return {content:[{type:'text',text:'ok'}]}; },
      close() { this.closed = true; } };
    clients.push(client);return client;
  } });
const wc=await wm.save({name:'browser',enabled:true,command:'node',args:['/opt/js-reverse-mcp/build/src/index.js','--allowedRoots','/configured']});
const unrelatedLocal=await wm.save({name:'other',enabled:true,command:'node',args:['other.js']});
const remote=await wm.save({name:'wrapped remote',enabled:true,transport:'http',url:'https://example.invalid/mcp'});
await wm.prepare({workspaceRoot:'/link/project'});
assert.deepEqual(launches.find(c=>c.id===wc.id).args.slice(-4),['--allowedRoots','/configured','--allowedRoots','/real/project']);
assert.deepEqual(launches.find(c=>c.id===unrelatedLocal.id).args,['other.js']);
assert.equal(launches.find(c=>c.id===remote.id).args,undefined);
assert.deepEqual(wp.store.cached(wc.id).args,wc.args,'temporary roots do not mutate persisted config');
const count=launches.length;
await wm.prepare({workspaceRoot:'/link/project'});assert.equal(launches.length,count,'same canonical root keeps the connection');
const wa=n=>mcpToolAlias(wc.id,n);
await wm.setPolicy(wc.id,'list_network_requests','allow');
const oldConnection=(await wm.list()).find(s=>s.id===wc.id).executionContext.connectionId;
const stale=wr.snapshot();
await wm.prepare({workspaceRoot:'/second workspace'});
assert.equal(stale.getPermission(wa('list_network_requests')).policy,'deny');
assert.equal(wr.getPermission(wa('list_network_requests')).policy,'allow','host-added root does not reset tool consent');
const active=clients.at(-1), launch=launches.at(-1);
assert.equal(launch.id,wc.id);
assert.deepEqual(launch.args.slice(-4),['--allowedRoots','/real/project','--allowedRoots','/second workspace']);
const exported=await wr.dispatch(wa('list_network_requests'),{reqid:30,outputFile:'work/headers.json'},{workspaceRoot:'/second workspace'});
assert.equal(exported.ok,true);
assert.equal(active.calls.at(-1).args.outputFile,'/second workspace/work/headers.json');
assert.equal(active.calls.at(-1).args.reqid,30,'path adapter does not rewrite request IDs');
assert.notEqual(exported.data.executionContext.connectionId,oldConnection);
assert.equal(exported.data.executionContext.workspaceReconnect,true);
await wr.dispatch(wa('evaluate_script'),{localFilePath:'input.js',outputFile:'/configured/out.json'},{workspaceRoot:'/second workspace',mcpApproved:wa('evaluate_script')});
assert.deepEqual(active.calls.at(-1).args,{localFilePath:'/second workspace/input.js',outputFile:'/configured/out.json'});
await assert.rejects(wm.prepare({workspaceRoot:'/missing'}),/missing/);
await assert.rejects(wm.prepare({workspaceRoot:'relative'}),/绝对路径/);
const abortRoot=new AbortController();abortRoot.abort();
await wm.prepare({workspaceRoot:'/cancelled',signal:abortRoot.signal});assert(!wm.workspaceRoots.get(wc.id).has('/cancelled'));
await wm.setPolicy(wc.id,'wait','allow');
const busy=wr.dispatch(wa('wait'),{});
while(!finishBusy) await new Promise(r=>setTimeout(r,0));
await assert.rejects(wm.prepare({workspaceRoot:'/busy-new'}),/正在执行/);
assert.equal(active.closed,false,'directory change cannot kill an in-flight tool');
assert(!wm.workspaceRoots.get(wc.id).has('/busy-new'));
finishBusy();await busy;
await wm.prepare({workspaceRoot:'/busy-new'});
const wrapped=await wm.save({name:'wrapped',enabled:true,command:'node',args:['custom-wrapper.js']});
await wm.prepare({workspaceRoot:'/second workspace'});
assert.deepEqual(launches.filter(c=>c.id===wrapped.id).at(-1).args,['custom-wrapper.js','--allowedRoots','/second workspace'],'handshake identifies renamed/wrapped service');
await wm.save({...wp.store.cached(wc.id),args:['replacement.js']});assert(!wm.workspaceRoots.has(wc.id),'edited server does not inherit temporary roots');
wm.close();
console.log('MCP workspace: launch allowlist, canonical paths, unchanged connections/config/consent, relative files, stale snapshots, cancellation, active calls, wrappers and unrelated/HTTP services passed');
