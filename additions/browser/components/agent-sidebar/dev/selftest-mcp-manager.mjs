import assert from 'node:assert/strict';
import { McpConfigStore, previewMcpImport } from '../modules/mcp/McpConfigStore.sys.mjs';
import { McpManager, mcpToolAlias } from '../modules/mcp/McpManager.sys.mjs';
import { ToolRouter } from '../modules/tools/ToolRouter.sys.mjs';
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
