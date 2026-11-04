import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { DEFAULTS, ROOT } from '../src/config.js';
import { createGateway, hooksOf, loadModules, moduleFile } from '../src/gateway.js';

test('a module from the private repo loads; a built-in name wins; a bad name is refused', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-repo-'));
  after(() => fs.rmSync(repoDir, { recursive: true, force: true }));
  const dir = path.join(repoDir, 'modules', 'my-thing');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default (config) => ({ prompt: `hi ${config.who}` });\n');
  fs.mkdirSync(path.join(repoDir, 'modules', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'modules', 'brain', 'index.js'), 'throw new Error("never loaded");\n');

  const [m] = await loadModules({ modules: { 'my-thing': { who: 'Dana' } }, repoDir });
  assert.equal(m.name, 'my-thing');
  assert.equal(m.prompt, 'hi Dana');
  assert.equal(moduleFile('brain', { repoDir }), path.join(ROOT, 'modules', 'brain', 'index.js'));
  assert.throws(() => moduleFile('../x', { repoDir }), /use a-z/);
  assert.throws(() => moduleFile('nope', { repoDir }), /no module "nope"/);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keepAlive = setInterval(() => {}, 1000); // Approvals timers are unref'd
const dirs = [];
const running = new Set();
after(async () => {
  clearInterval(keepAlive);
  for (const stop of running) await stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function waitFor(cond, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A real gateway on temp folders with a fake channel and a fake agent.
async function boot({ modules = [], run, state } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')));
  dirs.push(tmp);
  const config = { ...DEFAULTS, root: ROOT, dataDir: path.join(tmp, 'data'), agentCwd: path.join(tmp, 'home'), batchMs: 0, language: 'en', approvalTimeoutMin: 1 };
  fs.mkdirSync(config.dataDir);
  fs.mkdirSync(config.agentCwd);
  if (state) fs.writeFileSync(path.join(config.dataDir, 'state.json'), JSON.stringify(state));
  const channel = {
    sent: [],
    stopped: false,
    start(cb) { this.deliver = cb; },
    stop() { this.stopped = true; },
    async send(text) { this.sent.push(text); return `b${this.sent.length}`; },
    async react() {},
  };
  const agent = { calls: [], killed: false, async run(o) { agent.calls.push(o); return run ? run(o) : { text: 'pong', sessionId: 'S1', context: 1 }; }, kill() { agent.killed = true; } };
  let agentOpts;
  const gw = await createGateway({ config, channel, modules, log: () => {}, agentFactory: (o) => { agentOpts = o; return agent; } });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await gw.stop(); } };
  running.add(stop);
  const mcp = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'mcp.json'), 'utf8'));
  const { ASSISTANT_CTL_URL: url, ASSISTANT_CTL_TOKEN: token } = mcp.mcpServers.approve.env;
  const call = (route, body = {}, auth = token) => fetch(`${url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body) });
  const settle = async () => { for (let i = 0; i < 3; i++) { await gw.router.inflow; await gw.router.batch; await gw.router.queue; } };
  return { gw, config, channel, agent, agentOpts, mcp, call, settle, stop, tmp };
}

test('a message gets a reply', async () => {
  const g = await boot();
  g.channel.deliver({ id: 'm1', text: 'ping' });
  await waitFor(() => g.channel.sent.includes('pong'), 'the reply');
  assert.equal(g.agent.calls[0].prompt, 'ping');
  await g.settle();
  const saved = JSON.parse(fs.readFileSync(path.join(g.config.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.sessionId, 'S1');
});

test('the agent is built with the policy, the secret-read denies and the mcp config', async () => {
  const g = await boot({ modules: [{ name: 'm', allowed: ['mcp__m__get'], prompt: 'MODULE PROMPT' }] });
  assert.ok(g.agentOpts.allowedTools.includes('Read') && g.agentOpts.allowedTools.includes('mcp__m__get'));
  assert.ok(g.agentOpts.disallowedTools.includes(`Read(/${g.config.dataDir}/**)`));
  assert.deepEqual(g.agentOpts.promptExtra, ['MODULE PROMPT']);
  assert.equal(g.agentOpts.mcpConfig, path.join(g.config.dataDir, 'mcp.json'));
  assert.equal(fs.statSync(g.agentOpts.mcpConfig).mode & 0o777, 0o600);
});

test('module routes are reachable through the control API with the token from mcp.json', async () => {
  const mod = { name: 'm', routes: { '/ping': (b) => ({ pong: b.n + 1 }) }, mcp: { m: { command: 'node', args: ['m.js'], env: { OWN: '1' } } } };
  const g = await boot({ modules: [mod] });
  const r = await g.call('/ping', { n: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { pong: 2 });
  assert.equal((await g.call('/ping', { n: 1 }, 'wrong')).status, 401);
  assert.equal((await g.call('/missing')).status, 404);
  // the module server gets the same control env as the approval server, plus its own
  assert.deepEqual(g.mcp.mcpServers.m.env, { ...g.mcp.mcpServers.approve.env, OWN: '1' });
});

test('/approval: a read-only command is free; anything else asks the owner and waits for "yes"', async () => {
  const g = await boot();
  assert.deepEqual(await (await g.call('/approval', { tool_name: 'Bash', input: { command: 'ls' } })).json(), { allow: true, reason: 'free' });
  const pending = g.call('/approval', { tool_name: 'mcp__x__do', input: { a: 1 } }).then((r) => r.json());
  await waitFor(() => g.channel.sent.length === 1, 'the ask');
  assert.match(g.channel.sent[0], /Request #1/);
  g.channel.deliver({ id: 'y', text: 'yes' });
  assert.deepEqual(await pending, { allow: true, reason: 'owner' });
});

test('module hooks: start gets the router, context and command run, describers are used', async () => {
  let started;
  const mod = {
    name: 'm',
    start: (router) => { started = router; },
    context: (text) => `CTX(${text})`,
    command: (text) => (text === 'hello module' ? 'handled by module' : null),
    describers: [(tool, input) => (tool === 'mcp__m__act' ? `ACT ${input.what}` : null)],
  };
  const g = await boot({ modules: [mod] });
  assert.equal(started, g.gw.router);
  g.channel.deliver({ id: '1', text: 'hello module' });
  await waitFor(() => g.channel.sent.includes('handled by module'));
  assert.equal(g.agent.calls.length, 0);
  g.channel.deliver({ id: '2', text: 'plain' });
  await waitFor(() => g.agent.calls.length === 1);
  assert.equal(g.agent.calls[0].prompt, 'CTX(plain)\n\nplain');
  const pending = g.call('/approval', { tool_name: 'mcp__m__act', input: { what: 'x' } }).then((r) => r.json());
  await waitFor(() => g.channel.sent.some((s) => s.includes('ACT x')), 'the described ask');
  g.channel.deliver({ id: '3', text: 'no' });
  assert.equal((await pending).allow, false);
});

test('hooksOf merges the module hooks', async () => {
  const hooks = hooksOf([{ context: () => 'a' }, { context: () => '' }, { context: () => 'b' }, { approve: () => null }, { approve: () => ({ allow: true }) }, {}]);
  assert.equal(await hooks.context('t'), 'a\n\nb');
  assert.deepEqual(await hooks.approve({}), { allow: true });
  assert.equal(await hooks.command('t'), null);
});

test('a turn cut off by a restart is resumed on start', async () => {
  const g = await boot({ state: { inflight: { text: 'unfinished work', at: Date.now() - 1000 } } });
  await waitFor(() => g.agent.calls.length === 1, 'the resumed turn');
  assert.match(g.agent.calls[0].prompt, /cut off by a restart/);
  assert.ok(g.agent.calls[0].prompt.endsWith('unfinished work'));
});

test('stop() closes the server, stops the channel and the agent, and stops modules', async () => {
  let moduleStopped = false;
  const g = await boot({ modules: [{ name: 'm', stop: () => { moduleStopped = true; }, routes: { '/ping': () => ({}) } }] });
  assert.equal((await g.call('/ping')).status, 200);
  await g.stop();
  assert.equal(moduleStopped, true);
  assert.equal(g.channel.stopped, true);
  assert.equal(g.agent.killed, true);
  assert.equal(g.gw.control.server.listening, false);
  await assert.rejects(g.call('/ping'));
});
