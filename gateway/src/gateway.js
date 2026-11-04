import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, writeMcpConfig } from './agent.js';
import { Approvals } from './approvals.js';
import { BASE, ROOT } from './config.js';
import { newToken, startControl } from './control.js';
import { hostReadDeny, LOCAL_FETCH_DENY, Policy, secretReadDeny } from './policy.js';
import { Router } from './router.js';
import { State } from './state.js';

// A module (modules/<name>/index.js) exports default (config, ctx) → {
//   name, mcp: { server: { command, args, env } }, allowed: [tool], gated: [RegExp], untrusted: [RegExp],
//   autoAllow(tool, input, { tainted }) → bool, routes: { '/path': handler }, describers: [fn],
//   prompt: 'text for the system prompt', context(text), command(text), approve(request),
//   start(router), stop() }
// Every field is optional, so each module works alone and the core works with none.
//
// A module is built in (gateway/modules/<name>) or the owner's own, in their private repo
// (<repo>/modules/<name>/index.js): what is personal stays out of the public code. A built-in
// name wins, so a private module cannot replace a built-in one by accident. A private module
// runs with the gateway's rights, like a built-in one: only the owner's repo can hold one.
// It reaches the core by absolute path: import(`${config.root}/src/net.js`).
export function moduleFile(name, { root = ROOT, repoDir = path.join(BASE, 'repo') } = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`module name "${name}": use a-z, 0-9 and -`);
  const file = [path.join(root, 'modules', name, 'index.js'), path.join(repoDir, 'modules', name, 'index.js')].find((f) => fs.existsSync(f));
  if (!file) throw new Error(`no module "${name}": not built in, not in ${path.join(repoDir, 'modules')}`);
  return file;
}

// What in a ~/.claude would reach the agent once user settings load: null when nothing.
export function userClaudeDirty(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('CLAUDE.md')) return 'a CLAUDE.md';
  if (['skills', 'agents', 'commands', 'plugins', 'hooks'].some((d) => has(d) && fs.readdirSync(path.join(dir, d)).length)) return 'skills, agents, commands, plugins or hooks';
  for (const f of ['settings.json', 'settings.local.json']) {
    if (!has(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return `an unreadable ${f}`; }
    if (s.hooks || s.permissions?.allow?.length || s.enabledPlugins || s.mcpServers || s.apiKeyHelper || s.env) return `settings in ${f}`;
  }
  return null;
}

export async function loadModules(config, ctx = {}) {
  const out = [];
  for (const [name, opts] of Object.entries(config.modules || {})) {
    if (opts?.enabled === false) continue;
    const { default: make } = await import(pathToFileURL(moduleFile(name, { repoDir: config.repoDir })).href);
    out.push({ name, ...(await make({ ...config, ...opts }, ctx)) });
  }
  return out;
}

// Hooks for the router, merged from all modules.
export function hooksOf(modules) {
  const has = (k) => modules.filter((m) => m[k]);
  return {
    context: async (text) => (await Promise.all(has('context').map((m) => m.context(text)))).filter(Boolean).join('\n\n'),
    command: async (text) => { for (const m of has('command')) { const r = await m.command(text); if (r) return r; } return null; },
    approve: async (req) => { for (const m of has('approve')) { const r = await m.approve(req); if (r) return r; } return null; },
    afterTurn: (text, r) => { for (const m of has('afterTurn')) m.afterTurn(text, r); },
    approved: (req) => { for (const m of has('approved')) m.approved(req); },
    media: has('media').length ? async (msg) => { for (const m of has('media')) { const r = await m.media(msg); if (r) return r; } return null; } : null,
    describers: modules.flatMap((m) => m.describers || []),
  };
}

// Builds the whole gateway around one channel. agentFactory replaces the real claude in tests.
export async function createGateway({ config, channel, modules, agentFactory, log = console.log }) {
  const state = new State(path.join(config.dataDir, 'state.json'));
  const token = newToken();
  const routes = {};
  const control = await startControl({ token, routes });
  const ctx = { ctlUrl: control.url, ctlToken: token, state, log };
  modules ??= await loadModules(config, ctx);

  const policy = new Policy({ agentCwd: config.agentCwd, root: config.root, freeShell: config.freeShell, modules });
  const mcpConfig = writeMcpConfig({ dataDir: config.dataDir, ctlUrl: control.url, ctlToken: token, servers: Object.assign({}, ...modules.map((m) => m.mcp || {})) });
  const home = os.homedir();
  const deny = [...secretReadDeny({ root: config.root, home, dataDir: config.dataDir }), ...LOCAL_FETCH_DENY,
    ...(config.lockHost ? hostReadDeny({ root: config.root, home, agentCwd: config.agentCwd }) : [])];
  // claude.ai connectors (the google module) need the user's own settings: only as its own user.
  // And only while that ~/.claude stays clean: no CLAUDE.md, no allow rules, hooks or plugins.
  const wants = config.ownUser && modules.some((m) => m.claudeAi);
  const dirty = wants && userClaudeDirty(path.join(os.homedir(), '.claude'));
  if (dirty) log(`google: connectors off: ~/.claude of this user has ${dirty}. Remove it to use them.`);
  const claudeAi = wants && !dirty;
  const agentOpts = { config, mcpConfig, allowedTools: policy.allowed, disallowedTools: deny, promptExtra: modules.map((m) => m.prompt).filter(Boolean), claudeAi };
  const agent = agentFactory ? agentFactory(agentOpts) : new Agent(agentOpts);

  const approvals = new Approvals({ timeoutMs: config.approvalTimeoutMin * 60_000, holdMs: config.approvalHoldHours * 3600_000, store: state });
  const router = new Router({ config, state, approvals, policy, agent, channel, hooks: hooksOf(modules), log });
  Object.assign(routes, { '/approval': (b) => router.requestApproval(b) }, ...modules.map((m) => m.routes || {}));

  for (const m of modules) await m.start?.(router);
  channel.start((msg) => router.receive(msg));
  router.resume();
  // What was held in quiet hours goes out once they end.
  const quietTimer = setInterval(() => router.flushHeld(), 60_000);
  quietTimer.unref?.();

  const stop = async () => {
    clearInterval(quietTimer);
    agent.kill?.();
    for (const m of modules) await m.stop?.();
    channel.stop?.();
    control.server.close();
  };
  return { router, agent, policy, approvals, state, control, stop };
}
