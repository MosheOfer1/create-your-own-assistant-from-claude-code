import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { after, test } from 'node:test';
import { Agent, agentEnv, APPROVE_TOOL, fromResult, systemPrompt, toolsIn, withClock, writeMcpConfig } from '../src/agent.js';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const CONFIG = { claudeBin: 'claude-fake', model: 'sonnet', timezone: 'UTC', agentCwd: os.tmpdir(), approvalTimeoutMin: 10, warm: true, warmIdleMin: 30, ownerName: 'Dana', language: 'en' };

// A fake `claude` child: records stdin writes, kill signals, and lets the test print stdout lines.
function fakeSpawn() {
  const spawned = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.written = [];
    child.killed = [];
    child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(chunk.toString()); cb(); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig) => { child.killed.push(sig); setImmediate(() => child.emit('close', null)); };
    child.out = (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`);
    spawned.push({ bin, args, opts, child });
    return child;
  };
  return { spawned, spawnFn };
}

const result = (over = {}) => ({ type: 'result', result: 'hello', session_id: 'S1', usage: { input_tokens: 100, cache_read_input_tokens: 900 }, num_turns: 1, ...over });
const make = (config = {}, extra = {}) => {
  const f = fakeSpawn();
  const agent = new Agent({ config: { ...CONFIG, ...config }, mcpConfig: '/x/mcp.json', allowedTools: ['Read', 'Glob'], spawnFn: f.spawnFn, ...extra });
  return { agent, ...f };
};

test('warm mode: two turns reuse one process; the result line resolves the turn', async () => {
  const { agent, spawned } = make();
  const tools = [];
  const first = agent.run({ prompt: 'hi', sessionId: null, onTool: (n, i) => tools.push([n, i]) });
  const { child, args } = spawned[0];
  assert.ok(args.includes('--input-format'));
  assert.ok(!args.includes('--resume'));
  assert.deepEqual(args.slice(args.indexOf('--permission-prompt-tool'), args.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', APPROVE_TOOL]);
  const sent = JSON.parse(child.written[0]);
  assert.equal(sent.type, 'user');
  assert.match(sent.message.content, /^\[Now \(UTC\): .*\]\nhi$/);
  child.out({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
  child.out(result());
  assert.deepEqual(await first, { text: 'hello', sessionId: 'S1', isError: false, context: 1000 });
  assert.deepEqual(tools, [['Bash', { command: 'ls' }]]);

  const second = agent.run({ prompt: 'again', sessionId: 'S1' });
  assert.equal(spawned.length, 1);
  assert.equal(child.written.length, 2);
  assert.match(JSON.parse(child.written[1]).message.content, /again$/);
  child.out(result({ result: 'second' }));
  assert.equal((await second).text, 'second');
  assert.deepEqual(child.killed, []);
  agent.kill();
  assert.deepEqual(child.killed, ['SIGTERM']);
});

test('warm mode: another session id starts a fresh process and kills the old one', async () => {
  const { agent, spawned } = make();
  const a = agent.run({ prompt: 'one', sessionId: null });
  spawned[0].child.out(result());
  await a;
  const b = agent.run({ prompt: 'two', sessionId: 'OTHER' });
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].child.killed, ['SIGTERM']);
  assert.deepEqual(spawned[1].args.slice(spawned[1].args.indexOf('--resume')), ['--resume', 'OTHER']);
  spawned[1].child.out(result({ session_id: 'OTHER' }));
  await b;
  agent.kill();
});

test('warm mode: abort kills the process and resolves aborted', async () => {
  const { agent, spawned } = make();
  const ctl = new AbortController();
  const p = agent.run({ prompt: 'long', sessionId: null, signal: ctl.signal });
  ctl.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  assert.equal(r.isError, true);
  assert.equal(r.text, '');
  assert.deepEqual(spawned[0].child.killed, ['SIGTERM']);
  assert.equal(agent.warm, null);
});

test('an already aborted signal never writes a prompt', async () => {
  const { agent, spawned } = make();
  const ctl = new AbortController();
  ctl.abort();
  const r = await agent.run({ prompt: 'x', sessionId: null, signal: ctl.signal });
  assert.equal(r.aborted, true);
  assert.deepEqual(spawned[0].child.written, []);
  assert.deepEqual(spawned[0].child.killed, ['SIGTERM']);
});

test('a process that exits during a turn ends it as an error', async () => {
  const { agent, spawned } = make();
  const p = agent.run({ prompt: 'x', sessionId: null });
  spawned[0].child.stderr.write('bad flag');
  await new Promise((r) => setImmediate(r));
  spawned[0].child.emit('close', 2);
  const r = await p;
  assert.equal(r.isError, true);
  assert.match(r.text, /claude exited \(code 2\)\. bad flag/);
  assert.equal(agent.warm, null);
});

test('non-warm run passes --resume, sends the prompt on stdin and stops the process', async () => {
  const { agent, spawned } = make({ warm: false });
  const p = agent.run({ prompt: 'hi', sessionId: 'S7' });
  const { child, args } = spawned[0];
  assert.ok(!args.includes('--input-format'));
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(args.slice(args.indexOf('--resume')), ['--resume', 'S7']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/x/mcp.json');
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['Read', 'Glob']);
  assert.match(child.written.join(''), /^\[Now \(UTC\): .*\]\nhi$/);
  child.out(result({ session_id: 'S7', is_error: false }));
  assert.equal((await p).sessionId, 'S7');
  assert.deepEqual(child.killed, ['SIGTERM']);
});

test('readOnly runs without the approval tool; disallowed tools are passed on', async () => {
  const { agent, spawned } = make({ warm: false }, { disallowedTools: ['Read(//x/**)'] });
  const p = agent.run({ prompt: 'q', sessionId: null, readOnly: true, model: 'haiku' });
  spawned[0].child.out(result());
  const { args } = spawned[0];
  assert.ok(!args.includes('--permission-prompt-tool'));
  assert.deepEqual(args.slice(args.indexOf('--permission-prompts'), args.indexOf('--permission-prompts') + 2), ['--permission-prompts', 'none']);
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.deepEqual(args.slice(args.indexOf('--disallowedTools') + 1), ['Read(//x/**)']);
  await p;
});

test('plain() runs a tool-less one-off with the prompt on stdin', async () => {
  const { agent, spawned } = make();
  const p = agent.plain({ prompt: 'summarize' });
  const { child, args } = spawned[0];
  assert.equal(child.written.join(''), 'summarize');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  child.out(result({ result: 'summary' }));
  assert.equal((await p).text, 'summary');
});

test('the child is started in agentCwd with the tool timeout', async () => {
  const { agent, spawned } = make({ warm: false });
  const p = agent.run({ prompt: 'q', sessionId: null });
  assert.equal(spawned[0].bin, 'claude-fake');
  assert.equal(spawned[0].opts.cwd, CONFIG.agentCwd);
  assert.equal(spawned[0].opts.env.MCP_TOOL_TIMEOUT, String(11 * 60_000));
  spawned[0].child.out(result());
  await p;
});

test('agentEnv drops secrets and keeps what the CLI needs', () => {
  const env = {
    PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_FOO: '1', LC_ALL: 'C', https_proxy: 'p',
    SECRET_TOKEN: 's', TELEGRAM_BOT_TOKEN: 't', MAIL_PASSWORD: 'm', AWS_SECRET_ACCESS_KEY: 'a',
  };
  assert.deepEqual(agentEnv(env, { EXTRA: 'e' }), {
    PATH: '/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_FOO: '1', LC_ALL: 'C', https_proxy: 'p', EXTRA: 'e',
  });
});

test('fromResult computes the context per step', () => {
  const j = { result: 'x', session_id: 's', is_error: true, num_turns: 4, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70 } };
  assert.deepEqual(fromResult(j, 'old'), { text: 'x', sessionId: 's', isError: true, context: 25 });
  assert.deepEqual(fromResult({}, 'old'), { text: '', sessionId: 'old', isError: false, context: 0 });
  assert.equal(fromResult({ usage: { input_tokens: 99 }, num_turns: 0 }, null).context, 99);
});

test('toolsIn lists tool_use blocks of assistant lines only', () => {
  const line = { type: 'assistant', message: { content: [{ type: 'text', text: 't' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', name: 'Glob' }] } };
  assert.deepEqual(toolsIn(line), [{ name: 'Read', input: { file_path: '/a' } }, { name: 'Glob', input: {} }]);
  assert.deepEqual(toolsIn({ type: 'user', message: { content: [{ type: 'tool_use', name: 'X' }] } }), []);
  assert.deepEqual(toolsIn(null), []);
});

test('systemPrompt fills in owner and language; withClock puts the time first', () => {
  const text = systemPrompt(CONFIG, ['EXTRA LINE']);
  assert.ok(!text.includes('{{OWNER}}') && !text.includes('{{LANGUAGE}}'));
  assert.ok(text.endsWith('\n\nEXTRA LINE'));
  const stamped = withClock('hello', 'Asia/Jerusalem', Date.UTC(2026, 0, 15, 10, 30));
  assert.match(stamped, /^\[Now \(Asia\/Jerusalem\): .*2026.*\]\nhello$/);
});

test('writeMcpConfig writes a 0600 file with the approve server and the ctl env', () => {
  const dir = tmp();
  const file = writeMcpConfig({ dataDir: dir, ctlUrl: 'http://127.0.0.1:1234', ctlToken: 'tok', servers: { mail: { command: 'mail-mcp', args: [], env: { MAIL: 'x' } } } });
  assert.equal(file, path.join(dir, 'mcp.json'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const { mcpServers } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctl = { ASSISTANT_CTL_URL: 'http://127.0.0.1:1234', ASSISTANT_CTL_TOKEN: 'tok' };
  assert.equal(mcpServers.approve.command, process.execPath);
  assert.ok(mcpServers.approve.args[0].endsWith(path.join('mcp', 'approve.js')));
  assert.ok(fs.existsSync(mcpServers.approve.args[0]));
  assert.deepEqual(mcpServers.approve.env, ctl);
  assert.deepEqual(mcpServers.mail.env, { ...ctl, MAIL: 'x' });
});
