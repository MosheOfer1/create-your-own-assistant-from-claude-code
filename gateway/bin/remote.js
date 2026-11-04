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
  install   Node ${NODE} (if older, checked against nodejs.org's SHASUMS256.txt), the public repo at
            --version (default: its newest release tag vX.Y.Z; main only if it has none), npm ci,
            Chromium, the private repo (--repo, via a deploy key made on the machine), config and
            secrets, the WhatsApp link made in setup (stop the gateway here first), the service
  login     prints the one command the user runs to log Claude in on the machine (interactive)
  own-user  prints the one command that moves the assistant to its own user there (sudo, interactive)
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

// Node from nodejs.org into ~/.local/opt/node22. The tarball is checked against the
// SHASUMS256.txt that nodejs.org publishes next to it before anything is unpacked: a broken or
// swapped download stops the install here.
export const NODE_SH = `arch=$(uname -m); case $arch in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) echo "unsupported cpu $arch"; exit 1;; esac
f="node-v${NODE}-linux-$a.tar.xz"; t=$(mktemp -d)
curl -fsSL -o "$t/$f" "https://nodejs.org/dist/v${NODE}/$f"
curl -fsSL -o "$t/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE}/SHASUMS256.txt"
(cd "$t" && awk -v f="$f" '$2 == f' SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1) || { echo "ERROR: $f does not match nodejs.org's SHASUMS256.txt"; rm -rf "$t"; exit 1; }
mkdir -p "$HOME/.local/opt" && cd "$HOME/.local/opt" && tar -xJf "$t/$f" && rm -rf node22 "$t" && mv "node-v${NODE}-linux-$a" node22`;

// Claude Code's own installer, from claude.ai over HTTPS. It is saved to a file and run from
// there, not piped into bash: a download cut off halfway never runs as half a script, and a
// failed download stops the install (set -e) instead of feeding bash nothing.
export const CLAUDE_SH = `if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  t=$(mktemp -d)
  curl -fsSL -o "$t/install.sh" https://claude.ai/install.sh
  bash "$t/install.sh"
  rm -rf "$t"
fi`;

// The version to run: --version if given, else the newest release tag vX.Y.Z. main only when
// the repo has no release yet, and the output says so (main is whatever was pushed last).
export const checkoutScript = (version) => `cd "$A/app" && git fetch -q --tags
v=${version ? `'${safe('version', version)}'` : `$(git tag --list 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | head -n 1)`}
if [ -z "$v" ]; then v=main; echo "version: main (the repo has no release tag yet)"; else echo "version: $v"; fi
git checkout -q "$v"`;

export const installScript = ({ version, repoUrl }) => `set -e
umask 077
A="$HOME/.assistant"; mkdir -p "$A/data"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  if [ ! -x "$HOME/.local/opt/node22/bin/node" ]; then
${NODE_SH}
  fi
  export PATH="$HOME/.local/opt/node22/bin:$PATH"
fi
${CLAUDE_SH}
[ -d "$A/app/.git" ] || git clone -q ${PUBLIC} "$A/app"
${checkoutScript(version)}
# --ignore-scripts: the install scripts in the lockfile are only checks (Baileys: Node >= 20,
# protobufjs: a version warning); a hijacked dependency gets no install-time code run.
cd gateway && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && npx --yes playwright-core install chromium >/dev/null
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
  // Interactive (sudo asks for the password on the machine): the user types it, once.
  if (cmd === 'own-user') return `ssh -t ${key ? `-i ${key} ` : ''}${host} 'N=$(command -v node || echo ~/.local/opt/node22/bin/node); sudo "$N" ~/.assistant/app/gateway/bin/own-user.js install'`;
  if (cmd === 'logs') return remote(host, key, `journalctl --user -u assistant.service -n ${Number(rest[0]) || 50} --no-pager`);
  if (cmd === 'install') {
    const repo = opt(rest, 'repo');
    const repoUrl = repo && `git@github.com:${repo}.git`;
    const out = [remote(host, key, installScript({ version: opt(rest, 'version'), repoUrl })).trim()];
    if (repoUrl) {
      const pub = /deploy_key: (.+)/.exec(out[0])?.[1];
      if (!pub) throw new Error('no deploy key came back');
      // A fresh private folder (mkdtemp), not a guessable name in /tmp.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-deploy-'));
      const f = path.join(dir, 'assistant_repo.pub');
      fs.writeFileSync(f, `${pub}\n`);
      // Write access: the brain on the machine commits and pushes its notes.
      try { execFileSync('gh', ['repo', 'deploy-key', 'add', f, '--repo', repo, '--allow-write', '--title', `assistant on ${host.split('@')[1]}`], { stdio: 'pipe' }); } catch (e) { if (!/already/.test(String(e.stderr))) throw e; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      out.push(remote(host, key, cloneRepoScript(repoUrl)).trim());
    }
    // config and secrets over stdin, 0600 on the other side.
    for (const [local, dest] of [[path.join(BASE, 'config.json'), '.assistant/config.json'], [path.join(BASE, 'data', '.env'), '.assistant/data/.env']]) {
      if (fs.existsSync(local)) remote(host, key, `umask 077; cat > "$HOME/${dest}"; exit 0`, fs.readFileSync(local, 'utf8'));
    }
    // The WhatsApp link made here in setup (step 8) moves too, so the machine needs no new pairing.
    // Only one place may use a link: stop the gateway here first (the caller says so).
    const wa = path.join(BASE, 'data', 'whatsapp-auth');
    if (fs.existsSync(wa)) {
      const tar = execFileSync('tar', ['-czf', '-', '-C', path.dirname(wa), 'whatsapp-auth'], { maxBuffer: 64 << 20 });
      execFileSync('ssh', [...sshArgs(host, key), 'umask 077; mkdir -p "$HOME/.assistant/data" && tar -xzf - -C "$HOME/.assistant/data"'], { input: tar, stdio: ['pipe', 'pipe', 'pipe'] });
      out.push('whatsapp: link copied');
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
