import { execFile } from 'node:child_process';
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

// A real file somewhere below (a skill, a plugin, a hook). Empty folders and hidden bookkeeping
// entries do not count: Claude makes plugins/synced/<account>/ and a .bucket-… by itself at login.
// skip: top names that do not count. skills/synced: the account's own skills, synced down by
// Claude (the agent runs with --disable-slash-commands, agent.js, so they never load).
// plugins/plugin-directory-cache*.json: the CLI's catalog of plugins, nothing installed.
// plugins/synced: plugins the Claude account syncs down by itself. Each is fine only while
// disabled in settings.json ("<name>@synced": false, set by `claude plugin disable --all`).
const SKIP = { skills: /^synced$/, plugins: /^plugin-directory-cache.*\.json$/ };
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
// Names of the synced plugins: plugins/synced/<account>/<id>/.claude-plugin/plugin.json.
export function syncedPlugins(dir) {
  const ls = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => path.join(d, e.name)); } catch { return []; } };
  return ls(path.join(dir, 'synced')).flatMap(ls).filter((d) => fs.readdirSync(d).length).map((d) => readJson(path.join(d, '.claude-plugin', 'plugin.json'))?.name || '?');
}
function pluginsOnlySynced(dir, enabled = {}) {
  const rest = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'synced' && !SKIP.plugins.test(n));
  return !rest.length && syncedPlugins(dir).every((n) => enabled[`${n}@synced`] === false);
}
function hasFiles(dir, depth = 6, skip = null) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return list.some((e) => !e.name.startsWith('.') && !skip?.test(e.name) && (e.isFile() || e.isSymbolicLink() || (e.isDirectory() && depth > 0 && hasFiles(path.join(dir, e.name), depth - 1))));
}

// What in a ~/.claude would reach the agent once user settings load: null when nothing.
export function userClaudeDirty(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  if (has('CLAUDE.md')) return 'a CLAUDE.md';
  const enabled = readJson(path.join(dir, 'settings.json'))?.enabledPlugins || {};
  const pl = path.join(dir, 'plugins');
  const pluginsBad = fs.existsSync(pl) && (hasFiles(pl, 6, SKIP.plugins) || syncedPlugins(pl).length) && !pluginsOnlySynced(pl, enabled);
  if (pluginsBad || ['skills', 'agents', 'commands', 'hooks'].some((d) => hasFiles(path.join(dir, d), 6, SKIP[d]))) return 'skills, agents, commands, plugins or hooks';
  for (const f of ['settings.json', 'settings.local.json']) {
    if (!has(f)) continue;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return `an unreadable ${f}`; }
    if (s.hooks || s.permissions?.allow?.length || Object.values(s.enabledPlugins || {}).some((v) => v !== false) || s.mcpServers || s.apiKeyHelper || s.env) return `settings in ${f}`;
  }
  return null;
}

// MCP servers in ~/.claude.json (user scope) load with the user's settings too.
// The claude.ai connectors of the account, as tool prefixes: "claude.ai Google Drive: …" →
// mcp__claude_ai_Google_Drive. From `claude mcp list` (no model call). null when it fails.
export function parseConnectors(out) {
  return [...String(out).matchAll(/^claude\.ai (.+?): /gm)].map((m) => `mcp__claude_ai_${m[1].replace(/ /g, '_')}`);
}
export function disableSyncedPlugins(log = console.log, run = execFile) {
  return new Promise((resolve) => run('claude', ['plugin', 'disable', '--all'], { timeout: 60_000 }, (err) => {
    if (err) log('google: could not disable the synced plugins'); resolve();
  }));
}
export function listConnectors(run = execFile) {
  return new Promise((resolve) => run('claude', ['mcp', 'list'], { timeout: 90_000 }, (err, out) => resolve(err ? null : parseConnectors(out))));
}
// Every connector the config does not name is denied: its tools never reach the agent's context.
export function connectorDeny(all, keep = []) {
  const want = new Set(keep.map((k) => `mcp__claude_ai_${k.replace(/ /g, '_')}`));
  return all.filter((p) => !want.has(p));
}

export function userMcpServers(file) {
  try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}).length ? `MCP servers in ${path.basename(file)}` : null; } catch { return null; }
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
  // Plugins the account syncs down (creative-claw …) would load too: off for this user.
  if (wants && syncedPlugins(path.join(os.homedir(), '.claude', 'plugins')).length) await (config.disablePlugins || disableSyncedPlugins)(log);
  const dirty = wants && (userClaudeDirty(path.join(os.homedir(), '.claude')) || userMcpServers(path.join(os.homedir(), '.claude.json')));
  if (dirty) log(`google: connectors off: ~/.claude of this user has ${dirty}. Remove it to use them.`);
  let claudeAi = wants && !dirty;
  if (claudeAi) {
    const all = await (config.listConnectors || listConnectors)();
    if (!all) { log('google: connectors off: `claude mcp list` failed.'); claudeAi = false; } else {
      const keep = config.modules?.google?.connectors || ['Gmail', 'Google_Calendar', 'Google_Drive'];
      const off = connectorDeny(all, keep);
      deny.push(...off);
      if (off.length) log(`google: connectors denied: ${off.join(', ')}`);
    }
  }
  const agentOpts = { config, mcpConfig, allowedTools: policy.allowed, disallowedTools: deny, promptExtra: modules.map((m) => m.prompt).filter(Boolean), claudeAi };
  const agent = agentFactory ? agentFactory(agentOpts) : new Agent(agentOpts);

  const approvals = new Approvals({ timeoutMs: config.approvalTimeoutMin * 60_000, holdMs: config.approvalHoldHours * 3600_000, store: state });
  const router = new Router({ config, state, approvals, policy, agent, channel, hooks: hooksOf(modules), log });
  Object.assign(routes, { '/approval': (b) => router.requestApproval(b) }, ...modules.map((m) => m.routes || {}));

  // A location the owner sends is saved at once: an update may restart the gateway before the next turn.
  for (const c of channel.list?.map((x) => x.channel) || [channel]) c.onLocation = (l) => state.set('lastLocation', { ...l });
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
