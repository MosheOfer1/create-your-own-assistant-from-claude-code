#!/usr/bin/env node
// Puts the assistant on a machine the user already has, over SSH (their own key, BatchMode: no
// password prompts here). Nothing is installed with sudo: Node goes to ~/.local/opt, the service
// is a systemd user unit. Secrets travel over ssh stdin, never on a command line.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.ASSISTANT_HOME || path.join(os.homedir(), '.assistant');
const PUBLIC = 'https://github.com/MosheOfer1/create-your-own-assistant-from-claude-code.git';
const NODE = '22.23.0';

const USAGE = `Usage: remote.js COMMAND USER@HOST [--key FILE] [--version TAG] [--repo OWNER/NAME]
  check     what the machine has: OS, CPU, RAM (needs 2 GB+), node, git, claude, systemd, AppArmor userns
  install   Node ${NODE} (if older), the public repo at --version, npm ci, Chromium, the private repo
            (--repo, via a deploy key made on the machine), config and secrets, the service
  login     prints the one command the user runs to log Claude in on the machine (interactive)
  logs [N]  the service's last log lines`;

const opt = (rest, k) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : undefined);
const sshArgs = (host, key) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(key ? ['-i', key] : []), host];
// Runs a POSIX shell script on the host (sent on stdin, so nothing in it shows in `ps`).
const remote = (host, key, script, input = '') => execFileSync('ssh', [...sshArgs(host, key), 'sh -s'], { input: `${script}\n${input}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 << 20 });

export const CHECK = `
echo "os: $(uname -srm)"; echo "cpus: $(nproc 2>/dev/null)"
echo "ram_mb: $(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
for b in node git claude; do p=$(command -v $b || ls ~/.local/opt/node22/bin/$b 2>/dev/null); echo "$b: $([ -n "$p" ] && $p --version 2>/dev/null | head -1 || echo missing)"; done
echo "systemd_user: $( (systemctl --user show-environment >/dev/null 2>&1 || [ -d "/run/user/$(id -u)/systemd" ]) && echo yes || echo no)"
echo "linger: $(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2)"
echo "userns_restricted: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
`;

// Reads CHECK's output → { ok, problems: [] }.
export function judge(text) {
  const v = Object.fromEntries(text.trim().split('\n').map((l) => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()]));
  const problems = [];
  if (!(Number(v.ram_mb) > 0)) problems.push('could not read the RAM size');
  else if (Number(v.ram_mb) < 1900) problems.push(`only ${v.ram_mb} MB RAM; the assistant needs 2 GB`);
  if (!/^Linux/.test(v.os || '')) problems.push(`not Linux (${v.os}); use this computer instead`);
  if (v.git === 'missing') problems.push('git is missing (sudo apt install git)');
  if (v.systemd_user === 'no') problems.push('no systemd user session (WSL: enable systemd in /etc/wsl.conf)');
  const major = Number(String(v.node).replace(/^v/, '').split('.')[0]);
  const notes = [];
  if (!(major >= 22)) notes.push(`node ${v.node}: Node ${NODE} will be installed in ~/.local/opt`);
  if (v.claude === 'missing') notes.push('Claude Code will be installed');
  if (v.linger !== 'yes') notes.push('linger is off: ask the machine\'s admin for `sudo loginctl enable-linger USER`, or it stops at logout');
  if (v.userns_restricted === '1') notes.push('Ubuntu restricts user namespaces: Chromium runs with --no-sandbox unless an AppArmor profile is added');
  return { ok: problems.length === 0, problems, notes, facts: v };
}

const installScript = ({ version, repoUrl }) => `set -e
umask 077
A="$HOME/.assistant"; mkdir -p "$A/data"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  if [ ! -x "$HOME/.local/opt/node22/bin/node" ]; then
    arch=$(uname -m); case $arch in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported cpu $arch"; exit 1;; esac
    mkdir -p "$HOME/.local/opt" && cd "$HOME/.local/opt"
    curl -fsSL "https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-$a.tar.xz" | tar -xJ && rm -rf node22 && mv "node-v${NODE}-linux-$a" node22
  fi
  export PATH="$HOME/.local/opt/node22/bin:$PATH"
fi
command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
[ -d "$A/app/.git" ] || git clone -q ${PUBLIC} "$A/app"
cd "$A/app" && git fetch -q --tags && git checkout -q ${version || 'main'}
cd gateway && npm ci --omit=dev --no-audit --no-fund >/dev/null && npx --yes playwright-core install chromium >/dev/null
${repoUrl ? `[ -f "$HOME/.ssh/assistant_repo" ] || ssh-keygen -q -t ed25519 -N '' -C assistant-repo -f "$HOME/.ssh/assistant_repo"
echo "deploy_key: $(cat "$HOME/.ssh/assistant_repo.pub")"` : ''}
echo "node: $(command -v node)"
`;

const cloneRepoScript = (repoUrl) => `set -e
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/assistant_repo -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
A="$HOME/.assistant"
if [ -d "$A/repo/.git" ]; then git -C "$A/repo" pull -q --rebase; else git clone -q ${repoUrl} "$A/repo"; fi
git -C "$A/repo" config core.sshCommand "$GIT_SSH_COMMAND"
echo cloned`;

// Every value that goes into a command or a script is checked first (no shell characters, no
// leading "-" that ssh or git would read as an option).
const SAFE = { host: /^\w[\w.-]*@\w[\w.-]*$/, key: /^[\w./~-]+$/, version: /^\w[\w./-]*$/, repo: /^\w[\w.-]*\/\w[\w.-]*$/ };
export function safe(kind, value) {
  if (value !== undefined && !SAFE[kind].test(value)) throw new Error(`not a valid ${kind}: ${value}`);
  return value;
}

export function main([cmd, host, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (!SAFE.host.test(host || '')) throw new Error(`USER@HOST is required\n${USAGE}`);
  const key = safe('key', opt(rest, 'key'));
  safe('version', opt(rest, 'version'));
  safe('repo', opt(rest, 'repo'));
  if (cmd === 'check') {
    const r = judge(remote(host, key, CHECK));
    return [...Object.entries(r.facts).map(([k, v]) => `${k}: ${v}`), ...r.problems.map((p) => `PROBLEM: ${p}`), ...r.notes.map((n) => `note: ${n}`), r.ok ? 'ok' : 'not ok'].join('\n');
  }
  if (cmd === 'login') return `ssh -t ${key ? `-i ${key} ` : ''}${host} '~/.local/bin/claude /login || claude /login'`;
  if (cmd === 'logs') return remote(host, key, `journalctl --user -u assistant.service -n ${Number(rest[0]) || 50} --no-pager`);
  if (cmd === 'install') {
    const repo = opt(rest, 'repo');
    const repoUrl = repo && `git@github.com:${repo}.git`;
    const out = [remote(host, key, installScript({ version: opt(rest, 'version'), repoUrl })).trim()];
    if (repoUrl) {
      const pub = /deploy_key: (.+)/.exec(out[0])?.[1];
      if (!pub) throw new Error('no deploy key came back');
      const f = path.join(os.tmpdir(), `assistant-deploy-${Date.now()}.pub`);
      fs.writeFileSync(f, `${pub}\n`);
      // Write access: the brain on the machine commits and pushes its notes.
      try { execFileSync('gh', ['repo', 'deploy-key', 'add', f, '--repo', repo, '--allow-write', '--title', `assistant on ${host.split('@')[1]}`], { stdio: 'pipe' }); } catch (e) { if (!/already/.test(String(e.stderr))) throw e; }
      fs.rmSync(f, { force: true });
      out.push(remote(host, key, cloneRepoScript(repoUrl)).trim());
    }
    // config and secrets over stdin, 0600 on the other side.
    for (const [local, dest] of [[path.join(BASE, 'config.json'), '.assistant/config.json'], [path.join(BASE, 'data', '.env'), '.assistant/data/.env']]) {
      if (fs.existsSync(local)) remote(host, key, `umask 077; cat > "$HOME/${dest}"; exit 0`, fs.readFileSync(local, 'utf8'));
    }
    const node = /node: (.+)/.exec(out[0])?.[1] || 'node';
    out.push(remote(host, key, `export PATH="$HOME/.local/opt/node22/bin:$HOME/.local/bin:$PATH"; ${node} "$HOME/.assistant/app/gateway/bin/service.js" install`).trim());
    return out.join('\n').replace(/deploy_key: .*/, 'deploy key: added to the private repo');
  }
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(main(process.argv.slice(2))); } catch (e) { console.error(`ERROR: ${String(e.stderr || e.message).split('\n')[0]}`); process.exit(1); }
}
