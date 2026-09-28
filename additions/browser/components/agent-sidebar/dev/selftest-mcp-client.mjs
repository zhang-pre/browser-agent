import assert from 'node:assert/strict';
import { McpClient, createJsonLineParser, createHttpTransport } from '../modules/mcp/McpClient.sys.mjs';
const init = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
let received = [], parseError;
const parser = createJsonLineParser(x => received.push(x), { onError: e => parseError = e });
parser.push('{"jsonrpc":"2.'); parser.push('0","id":1,"result":{}}\r\n{"jsonrpc":"2.0","method":"ping"}\n');
assert.equal(received.length, 2);
parser.push('secret not json\n'); assert.match(parseError.message, /Invalid MCP JSON/); assert.ok(!parseError.message.includes('secret'));
let sent = [], receive;
const client = new McpClient({ timeoutMs: 100, transport: {
  start(cb) { receive = cb; }, close() {},
  send(m) {
    sent.push(m);
    if (m.method === 'initialize') receive({ jsonrpc: '2.0', id: m.id, result: init });
    if (m.method === 'tools/list') receive({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: m.params.cursor || 'first' }], ...(m.params.cursor ? {} : { nextCursor: 'second' }) } });
    if (m.method === 'tools/call' && m.params.name === 'error-result') receive({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'bad' }] } });
  },
} });
await client.connect(); assert.equal(sent[1].method, 'notifications/initialized');
assert.deepEqual((await client.listTools()).map(t => t.name), ['first', 'second']);
assert.equal((await client.callTool('error-result')).isError, true);
await assert.rejects(client.callTool('timeout', {}, { timeoutMs: 5 }), /timed out/);
await new Promise(r => setTimeout(r, 0)); assert.ok(sent.some(m => m.method === 'notifications/cancelled'));
const abort = new AbortController(); const pending = client.callTool('hang', {}, { signal: abort.signal }); abort.abort();
await assert.rejects(pending, /cancelled/);
const closing = client.callTool('hang'); client.close(); await assert.rejects(closing, /closed/); assert.equal(client.pending.size, 0);

let requests = [], calls = 0;
const http = createHttpTransport({ url: 'https://fixture.invalid/mcp', timeoutMs: 100, fetch: async (url, options) => {
  requests.push(options);
  if (options.method === 'DELETE') return new Response(null, { status: 204 });
  const m = JSON.parse(options.body);
  if (m.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: init }), { headers: { 'Content-Type': 'application/json', 'MCP-Session-Id': 'fixture-session' } });
  if (!m.id) return new Response(null, { status: 202 });
  calls++;
  if (m.params.name === 'disconnect') return new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const data = `: keepalive\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '你好' }] } })}\r\n\r\n`;
  const bytes = new TextEncoder().encode(data);
  return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
} });
const remote = new McpClient({ transport: http, timeoutMs: 100 });
await remote.connect();
assert.equal(requests[1].headers.get('MCP-Session-Id'), 'fixture-session');
assert.equal(requests[1].headers.get('MCP-Protocol-Version'), '2025-11-25');
assert.equal((await remote.callTool('echo')).content[0].text, '你好');
await assert.rejects(remote.callTool('disconnect'), /not retried/); assert.equal(calls, 2);
remote.close(); await new Promise(r => setTimeout(r, 0)); assert.equal(requests.at(-1).method, 'DELETE');
const wrong = new McpClient({ transport: { start(cb) { this.cb = cb; }, send(m) { this.cb({ jsonrpc:'2.0', id:m.id, result:{...init,protocolVersion:'2099-01-01'} }); }, close() {} } });
await assert.rejects(wrong.connect(), /Unsupported MCP protocol/); assert.equal(wrong.closed, true);
console.log('MCP client: framing, negotiation, pagination, cancellation, timeout, close, HTTP JSON/SSE, session/version headers and no replay passed');
// Shutdown must settle even if an injected transport never finishes starting.
const stuck = new McpClient({ timeoutMs: 10000, transport: { start() { return new Promise(() => {}); }, close() {} } });
const starting = stuck.connect(); stuck.close();
await assert.rejects(starting, /closed/);
assert.equal(stuck.operations.size, 0);
let cursorReceive;
const cyclic = new McpClient({ transport: { start(cb) { cursorReceive = cb; }, close() {}, send(m) {
  if (m.method === 'initialize') cursorReceive({jsonrpc:'2.0',id:m.id,result:init});
  if (m.method === 'tools/list') cursorReceive({jsonrpc:'2.0',id:m.id,result:{tools:[],nextCursor:'repeat'}});
} } });
await cyclic.connect(); await assert.rejects(cyclic.listTools(), /pagination cursor/); cyclic.close();
let limitError;
createJsonLineParser(() => {}, { maxBufferChars: 3, onError: e => limitError = e }).push('secret');
assert.match(limitError.message, /size limit/);
console.log('MCP client: hung startup shutdown, pagination cycle and frame limit passed');
