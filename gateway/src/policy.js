import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isReadOnly, realChange } from './commands.js';

// "Free inside, gated outside". Tools in ALLOWED run without asking. Everything else reaches
// the gateway (mcp/approve.js), where autoAllow() decides in code; what it does not pass asks
// the owner. GATED tools reach other people or money: they always ask, whatever a module says.
export const ALLOWED = ['Read', 'Glob', 'Grep', 'WebSearch', 'TodoWrite'];
export const GATED = [/__send/, /__reply/, /__forward/, /__share/, /__(pay|buy|book|order)/, /__respond_to_event$/];

// Built from the core lists plus what each module adds ({ allowed, gated, untrusted }).
export class Policy {
  constructor({ agentCwd, root, freeShell = false, modules = [] }) {
    Object.assign(this, { agentCwd, root, freeShell });
    this.allowed = [...ALLOWED, ...modules.flatMap((m) => m.allowed || [])];
    this.gatedRes = [...GATED, ...modules.flatMap((m) => m.gated || [])];
    this.untrustedRes = [/^WebFetch$/, ...modules.flatMap((m) => m.untrusted || [])];
    this.free = modules.flatMap((m) => (m.autoAllow ? [m.autoAllow] : []));
  }

  gated(tool) { return this.gatedRes.some((r) => r.test(tool)); }

  // Text someone else wrote enters the conversation (a page, an email, a received file).
  // From then on strong actions ask until a new conversation: the text may carry instructions.
  untrusted(tool, input = {}) {
    if (this.untrustedRes.some((r) => r.test(tool))) return true;
    if (!['Read', 'Grep'].includes(tool) || !this.agentCwd) return false;
    // Files others sent land in <agentCwd>/inbox. Paths may be relative or hold "..";
    // a Grep over a folder above the inbox reads it too.
    const inbox = path.join(path.resolve(this.agentCwd), 'inbox');
    const abs = path.resolve(this.agentCwd, String(input.file_path || input.path || '.'));
    return inside(abs, inbox) || (tool === 'Grep' && inside(inbox, abs) && fs.existsSync(inbox));
  }

  autoAllow(tool, input = {}, { tainted = false } = {}) {
    if (this.gated(tool)) return false;
    if (tool === 'Bash') return isReadOnly(input.command) || (this.freeShell && !tainted && !realChange(input.command));
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return ownFile(input.file_path || input.notebook_path, this.agentCwd, this.root);
    if (tool === 'WebFetch') return !tainted || plainUrl(input.url);
    return this.free.some((f) => f(tool, input, { tainted }));
  }
}

// In a tainted conversation a page may still be read when its address can carry nothing out:
// no query, no fragment, no long path part.
export function plainUrl(url = '') {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && !u.search && !u.hash && !u.username
      && u.pathname.split('/').every((seg) => seg.length <= 30) && u.pathname.length <= 120;
  } catch { return false; }
}

const inside = (p, dir) => p === dir || p.startsWith(`${dir}${path.sep}`);
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// A file the agent may write by itself: inside its own folder, through no symlink out,
// never a dot path (.env, .claude, .ssh), data/ or node_modules, never the gateway's code.
export function ownFile(file, agentCwd, codeRoot = '') {
  if (!file || !agentCwd || !path.isAbsolute(String(file))) return false;
  const abs = path.resolve(String(file));
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const real = path.join(realOr(dir), path.relative(dir, abs));
  try { if (fs.lstatSync(real).isSymbolicLink()) return false; } catch { /* a new file */ }
  if (codeRoot && !path.relative(realOr(codeRoot), real).startsWith('..')) return false;
  const rel = path.relative(realOr(agentCwd), real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((p) => p.startsWith('.') || p === 'data' || p === 'node_modules');
}

// Files the agent's Read/Grep/Glob never open, even read-only: a page could talk it into
// reading a key and sending it out. Rules use an absolute path with a leading //.
export function secretReadDeny({ root, home, dataDir }) {
  const rule = (p, all = true) => `Read(/${p}${all ? '/**' : ''})`;
  return [rule(dataDir), rule(path.join(root, '.env'), false), rule(path.join(home, '.ssh')), rule(path.join(home, '.claude')),
    rule(path.join(home, '.claude.json'), false), rule(path.join(home, '.config')), rule(path.join(home, '.gnupg'))];
}

// WebFetch never reaches this machine or a cloud metadata service by name. Its rules can only
// name hosts (no IP ranges); the browse module checks every address itself.
export const LOCAL_FETCH_DENY = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '169.254.169.254', 'metadata.google.internal', os.hostname()]
  .map((d) => `WebFetch(domain:${d})`);

// lockHost (a shared machine): the agent's file tools stay out of the system folders, other
// homes and every folder in this home except its own folder and the gateway's code.
export function hostReadDeny({ root, home, agentCwd, list = (d) => { try { return fs.readdirSync(d); } catch { return []; } } }) {
  const rule = (p) => `Read(/${p}/**)`;
  const keep = [path.resolve(root), path.resolve(agentCwd)];
  const out = ['/etc', '/opt', '/srv', '/var', '/root', '/mnt', '/media', '/proc', '/boot'].map(rule);
  for (const u of list('/home')) if (path.join('/home', u) !== path.resolve(home)) out.push(rule(path.join('/home', u)));
  for (const e of list(home)) {
    const p = path.resolve(home, e);
    if (!keep.some((k) => k === p || k.startsWith(`${p}${path.sep}`))) out.push(rule(p), `Read(/${p})`);
  }
  return out;
}
