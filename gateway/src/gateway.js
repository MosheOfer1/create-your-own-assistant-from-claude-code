import os from 'node:os';
import path from 'node:path';
import { Agent, writeMcpConfig } from './agent.js';
import { Approvals } from './approvals.js';
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
export async function loadModules(config, ctx = {}) {
  const out = [];
  for (const [name, opts] of Object.entries(config.modules || {})) {
    if (opts?.enabled === false) continue;
    const { default: make } = await import(`../modules/${name}/index.js`);
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
  const agentOpts = { config, mcpConfig, allowedTools: policy.allowed, disallowedTools: deny, promptExtra: modules.map((m) => m.prompt).filter(Boolean) };
  const agent = agentFactory ? agentFactory(agentOpts) : new Agent(agentOpts);

  const approvals = new Approvals({ timeoutMs: config.approvalTimeoutMin * 60_000, holdMs: config.approvalHoldHours * 3600_000, store: state });
  const router = new Router({ config, state, approvals, policy, agent, channel, hooks: hooksOf(modules), log });
  Object.assign(routes, { '/approval': (b) => router.requestApproval(b) }, ...modules.map((m) => m.routes || {}));

  for (const m of modules) await m.start?.(router);
  channel.start((msg) => router.receive(msg));
  router.resume();

  const stop = async () => {
    agent.kill?.();
    for (const m of modules) await m.stop?.();
    channel.stop?.();
    control.server.close();
  };
  return { router, agent, policy, approvals, state, control, stop };
}
