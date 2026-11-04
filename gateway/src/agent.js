import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const APPROVE_TOOL = 'mcp__approve__ask';

// No settings files at all: not the user's ~/.claude (its CLAUDE.md, allow rules, hooks,
// plugins, skills), not a CLAUDE.md or .claude/ the agent wrote into its own folder or one
// above it. When the gateway runs as the owner's own user, those would bypass the approvals
// and show the owner's private notes to the agent. Everything the agent needs comes as flags.
// The login is not a setting: it is still read.
const ISOLATE = ['--setting-sources', ''];
// The claude.ai connectors (Gmail, Calendar, Drive) load only with the user's settings and
// without --strict-mcp-config. Only for a gateway that runs as its own user: its ~/.claude is
// its own (bin/own-user.js copies the login, nothing else) and the agent cannot write there.
const WITH_CONNECTORS = ['--setting-sources', 'user'];

// What Claude and every command it runs may see of the environment: what the CLI needs,
// never the gateway's own secrets (channel tokens, mail passwords).
const ENV_KEEP = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|TMPDIR|XDG_[A-Z_]+|CLAUDE_[A-Z0-9_]+|ANTHROPIC_[A-Z0-9_]+|DISABLE_[A-Z_]+|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|HTTPS?_PROXY|NO_PROXY)$/i;
export function agentEnv(env = process.env, extra = {}) {
  return { ...Object.fromEntries(Object.entries(env).filter(([k]) => ENV_KEEP.test(k))), ...extra };
}

// The MCP config for claude: the approval server plus each module's servers.
// It holds the control token, so 0600 in the data folder.
export function writeMcpConfig({ dataDir, ctlUrl, ctlToken, servers = {} }) {
  const env = { ASSISTANT_CTL_URL: ctlUrl, ASSISTANT_CTL_TOKEN: ctlToken };
  const all = { approve: { command: process.execPath, args: [path.join(ROOT, 'mcp', 'approve.js')], env }, ...servers };
  for (const s of Object.values(all)) s.env = { ...env, ...s.env };
  const file = path.join(dataDir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: all }), { mode: 0o600 });
  return file;
}

// The assistant's instructions, appended to Claude Code's own system prompt. No clock here:
// a system prompt that changes every minute breaks the prompt cache.
export function systemPrompt(config, extra = []) {
  const base = fs.readFileSync(path.join(ROOT, 'prompts', 'system.md'), 'utf8')
    .replaceAll('{{OWNER}}', config.ownerName).replaceAll('{{LANGUAGE}}', config.language);
  return [base, ...extra].join('\n\n');
}

export function withClock(prompt, tz, ms = Date.now()) {
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(ms);
  return `[Now (${tz}): ${now}]\n${prompt}`;
}

// The result object of `claude -p` → { text, sessionId, isError, context }.
// context = tokens one step reads, the measure for "this conversation got too long".
export function fromResult(j, sessionId) {
  const u = j.usage || {};
  const read = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const text = j.result || (j.is_error ? `The agent failed: ${(j.errors || [j.subtype]).join('; ')}` : '');
  return { text, sessionId: j.session_id ?? sessionId, isError: !!j.is_error, context: Math.round(read / Math.max(1, j.num_turns || 1)) };
}

// Tool calls in one stream-json line: [{ name, input }].
export function toolsIn(j) {
  if (j?.type !== 'assistant') return [];
  return (j.message?.content || []).filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input || {} }));
}

// Runs agent turns. The main conversation goes to one warm process (a turn = one stdin line);
// one-offs (readOnly, plain) start their own process.
export class Agent {
  constructor({ config, mcpConfig, allowedTools, disallowedTools = [], promptExtra = [], claudeAi = false, spawnFn = spawn }) {
    Object.assign(this, { config, mcpConfig, allowedTools, disallowedTools, promptExtra, spawnFn });
    this.claudeAi = !!(claudeAi && config.ownUser);
    // No auto-memory either: it lives in ~/.claude/projects and is loaded outside the approvals.
    // The brain module is the assistant's memory.
    this.env = agentEnv(process.env, { MCP_TOOL_TIMEOUT: String((config.approvalTimeoutMin + 1) * 60_000), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    this.warm = null; // { child, key, session, buf, err, turn, idle, used }
  }

  args({ model, readOnly = false } = {}) {
    return [
      ...(this.claudeAi ? WITH_CONNECTORS : ISOLATE),
      '--model', model || this.config.model,
      '--tools', (this.config.tools || ['default']).join(','),
      // A module's prompt may be a function (the brain's core facts): read each turn. When it
      // changes, the arguments change and the warm process restarts with the new prompt.
      '--append-system-prompt', systemPrompt(this.config, this.promptExtra.map((p) => (typeof p === 'function' ? p() : p)).filter(Boolean)),
      '--mcp-config', this.mcpConfig, ...(this.claudeAi ? [] : ['--strict-mcp-config']),
      ...(readOnly ? ['--permission-prompts', 'none'] : ['--permission-prompt-tool', APPROVE_TOOL]),
      '--allowedTools', ...this.allowedTools,
      ...(this.disallowedTools.length ? ['--disallowedTools', ...this.disallowedTools] : []),
    ];
  }

  // One turn. Resolves { text, sessionId, isError, aborted?, context }.
  // onTool(name, input) runs as each tool starts. signal (AbortSignal) stops the turn.
  run({ prompt, sessionId, model, signal, onTool, readOnly = false, timeoutMs = 20 * 60_000 }) {
    const text = withClock(prompt, this.config.timezone);
    const base = this.args({ model, readOnly });
    if (this.config.warm && !readOnly) return this.runWarm({ base, sessionId, text, signal, onTool, timeoutMs });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...base, ...(sessionId ? ['--resume', sessionId] : [])];
    return new Promise((resolve) => {
      const proc = this.start(args, sessionId);
      proc.child.stdin.end(text);
      this.turnOn(proc, { resolve, sessionId, signal, onTool, timeoutMs });
    });
  }

  // A text task with no tools and no session (summaries, mail triage). Prompt via stdin.
  plain({ prompt, model = 'haiku', timeoutMs = 10 * 60_000 }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...ISOLATE, '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
    return new Promise((resolve) => {
      const proc = this.start(args, null);
      proc.child.stdin.end(prompt);
      this.turnOn(proc, { resolve, sessionId: null, timeoutMs });
    });
  }

  runWarm({ base, sessionId, text, signal, onTool, timeoutMs }) {
    const key = crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex');
    const p = this.warm;
    const same = p && !p.turn && p.key === key && (sessionId ? p.session === sessionId : !p.session && !p.used);
    if (!same) {
      this.kill(p);
      const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...base, ...(sessionId ? ['--resume', sessionId] : [])];
      this.warm = this.start(args, sessionId);
      this.warm.key = key;
    }
    const proc = this.warm;
    clearTimeout(proc.idle);
    proc.used = true;
    return new Promise((resolve) => {
      this.turnOn(proc, { resolve, sessionId, signal, onTool, timeoutMs, keep: true });
      proc.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    });
  }

  start(args, sessionId) {
    const child = this.spawnFn(this.config.claudeBin, args, { cwd: this.config.agentCwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = { child, session: sessionId || null, buf: '', err: '', turn: null, idle: null, used: false };
    child.stdout.on('data', (d) => this.lines(proc, d));
    child.stderr.on('data', (d) => { proc.err = (proc.err + d).slice(-4000); });
    child.stdin.on('error', () => {});
    child.on('error', (e) => { proc.err += e.message; });
    child.on('close', (code) => {
      if (this.warm === proc) this.warm = null;
      clearTimeout(proc.idle);
      proc.turn?.finish({ text: `claude exited (code ${code}). ${proc.err.slice(-500)}`, sessionId: proc.session, isError: true });
    });
    return proc;
  }

  turnOn(proc, { resolve, sessionId, signal, onTool, timeoutMs, keep = false }) {
    if (signal?.aborted) { this.kill(proc); return resolve({ text: '', sessionId, isError: true, aborted: true }); }
    const finish = (r) => {
      if (proc.turn !== turn) return;
      proc.turn = null;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (!keep || r.isError) this.kill(proc);
      else { proc.idle = setTimeout(() => this.kill(proc), this.config.warmIdleMin * 60_000); proc.idle.unref?.(); }
      resolve(r);
    };
    const stop = () => finish({ text: '', sessionId, isError: true, aborted: true });
    const timer = setTimeout(() => finish({ text: 'The agent did not finish in time.', sessionId, isError: true }), timeoutMs);
    const turn = { finish, onTool };
    proc.turn = turn;
    signal?.addEventListener('abort', stop, { once: true });
  }

  lines(proc, d) {
    proc.buf += d;
    for (let i = proc.buf.indexOf('\n'); i >= 0; i = proc.buf.indexOf('\n')) {
      const line = proc.buf.slice(0, i);
      proc.buf = proc.buf.slice(i + 1);
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const turn = proc.turn;
      if (!turn) continue;
      for (const t of toolsIn(j)) turn.onTool?.(t.name, t.input);
      if (j.type === 'result') {
        if (j.session_id) proc.session = j.session_id;
        turn.finish(fromResult(j, proc.session));
      }
    }
  }

  kill(proc = this.warm) {
    if (!proc) return;
    if (this.warm === proc) this.warm = null;
    clearTimeout(proc.idle);
    try { proc.child.stdin.end(); } catch { /* gone */ }
    proc.child.kill('SIGTERM');
  }
}
