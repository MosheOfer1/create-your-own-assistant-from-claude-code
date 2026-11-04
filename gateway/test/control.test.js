import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { newToken, startControl } from '../src/control.js';

const APPROVE = fileURLToPath(new URL('../mcp/approve.js', import.meta.url));
const TOKEN = 'secret-token';
const closeAll = async ({ server }) => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); };

let control;
let approvalSeen;
let approvalAnswer = { allow: true };

before(async () => {
  control = await startControl({
    token: TOKEN,
    routes: {
      '/echo': (body) => ({ got: body }),
      '/nothing': () => undefined,
      '/boom': () => { throw new Error('exploded'); },
      '/approval': (body) => { approvalSeen = body; return approvalAnswer; },
    },
  });
});
after(() => closeAll(control));

const post = (route, { token = TOKEN, body = '{}', method = 'POST' } = {}) => fetch(`${control.url}${route}`, {
  method,
  headers: token == null ? {} : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: method === 'POST' ? body : undefined,
});

test('listens on 127.0.0.1 and newToken makes distinct hex tokens', () => {
  assert.match(control.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const a = newToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, newToken());
});

test('401 without a token or with a wrong one', async () => {
  assert.equal((await post('/echo', { token: null })).status, 401);
  assert.equal((await post('/echo', { token: 'wrong' })).status, 401);
  assert.equal((await post('/echo', { token: `${TOKEN}x` })).status, 401);
  assert.equal((await post('/nope', { token: 'wrong' })).status, 401); // auth is checked before the route
});

test('404 for an unknown route, a prototype name, or a GET', async () => {
  assert.equal((await post('/nope')).status, 404);
  assert.equal((await post('/constructor')).status, 404);
  assert.equal((await post('/__proto__')).status, 404);
  assert.equal((await post('/echo', { method: 'GET' })).status, 404);
});

test('200 with a JSON body for a route; an empty result is {}', async () => {
  const r = await post('/echo', { body: '{"a":[1,2]}' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await r.json(), { got: { a: [1, 2] } });
  assert.deepEqual(await (await post('/nothing')).json(), {});
  assert.deepEqual(await (await post('/echo', { body: '' })).json(), { got: {} });
});

test('a throwing handler or bad JSON gives 500 with allow false', async () => {
  const r = await post('/boom');
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { allow: false, error: 'exploded' });
  const bad = await post('/echo', { body: '{nope' });
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).allow, false);
});

// --- mcp/approve.js, the permission-prompt tool, spoken to like Claude Code does ---

function startApprove(env) {
  const child = spawn(process.execPath, [APPROVE], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let n = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const stop = () => { child.stdin.end(); child.kill(); };
  return { rpc, child, stop };
}

const ask = (rpc, input) => rpc('tools/call', { name: 'ask', arguments: { tool_name: 'Bash', input } });
const decision = (r) => JSON.parse(r.result.content[0].text);

test('approve.js end to end: initialize, tools/list, tools/call ask → allow', async () => {
  approvalAnswer = { allow: true };
  const p = startApprove({ ASSISTANT_CTL_URL: control.url, ASSISTANT_CTL_TOKEN: TOKEN });
  try {
    const init = await p.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'approve');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await p.rpc('tools/list');
    assert.deepEqual(list.result.tools.map((t) => t.name), ['ask']);
    assert.deepEqual(list.result.tools[0].inputSchema.required, ['tool_name', 'input']);

    const r = await ask(p.rpc, { command: 'npm test' });
    assert.deepEqual(decision(r), { behavior: 'allow', updatedInput: { command: 'npm test' } });
    assert.deepEqual(approvalSeen, { tool_name: 'Bash', input: { command: 'npm test' } });
  } finally { p.stop(); }
});

test('approve.js turns a deny, a timeout and an unreachable gateway into deny', async () => {
  const p = startApprove({ ASSISTANT_CTL_URL: control.url, ASSISTANT_CTL_TOKEN: TOKEN });
  const bad = startApprove({ ASSISTANT_CTL_URL: control.url, ASSISTANT_CTL_TOKEN: 'wrong' });
  const gone = startApprove({ ASSISTANT_CTL_URL: 'http://127.0.0.1:1', ASSISTANT_CTL_TOKEN: TOKEN });
  try {
    approvalAnswer = { allow: false, reason: 'owner' };
    assert.deepEqual(decision(await ask(p.rpc, {})), { behavior: 'deny', message: 'The owner denied this action.' });
    approvalAnswer = { allow: false, reason: 'timeout' };
    assert.deepEqual(decision(await ask(p.rpc, {})), { behavior: 'deny', message: 'The owner did not answer in time.' });
    approvalAnswer = { allow: false, message: 'custom' };
    assert.equal(decision(await ask(p.rpc, {})).message, 'custom');
    const wrong = decision(await ask(bad.rpc, {}));
    assert.equal(wrong.behavior, 'deny');
    assert.match(wrong.message, /gateway is unreachable: gateway answered 401/);
    const none = decision(await ask(gone.rpc, {}));
    assert.equal(none.behavior, 'deny');
    assert.match(none.message, /unreachable/);
  } finally { p.stop(); bad.stop(); gone.stop(); }
});

test('the MCP server answers ping, unknown tools and unknown methods', async () => {
  const p = startApprove({ ASSISTANT_CTL_URL: control.url, ASSISTANT_CTL_TOKEN: TOKEN });
  try {
    assert.deepEqual((await p.rpc('ping')).result, {});
    assert.match((await p.rpc('tools/call', { name: 'nope' })).error.message, /unknown tool nope/);
    assert.equal((await p.rpc('resources/list')).error.code, -32601);
  } finally { p.stop(); }
});
