#!/usr/bin/env node
// Moves the assistant to a system user of its own (Linux / WSL2 with systemd). Run with sudo:
//   sudo "$(command -v node)" ~/.assistant/app/gateway/bin/own-user.js install
// What it builds:
//   user `assistant`: no password, no login shell, no sudo, not in any admin group
//   /opt/assistant/app    the code, owned by root: the assistant can read it, never change it
//   /home/assistant/.assistant   its config, private repo, data and folder (a copy of yours)
//   assistant.service     a system unit: other homes hidden, system read-only, memory capped
//   assistant-update.path the assistant asks for a new version by writing a file; root does it
// Your own copy in ~/.assistant stays as it is (a backup). `uninstall` goes back to it.
// macOS: not supported; the assistant runs as your user with the guards in the code.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BOT = 'assistant';
export const BOT_HOME = `/home/${BOT}`;
export const BOT_BASE = `${BOT_HOME}/.assistant`;
export const OPT = '/opt/assistant';
export const APP = `${OPT}/app`;
const UNITS = '/etc/systemd/system';
export const REQUEST = `${BOT_BASE}/data/update-request.json`;
const TAG = /^\w[\w./-]*$/;

const USAGE = `Usage: sudo node own-user.js COMMAND [--owner USER] [--memory 2G]
  install           create the user, copy code and data, start assistant.service (your user service stops)
  sync-from-owner   copy your newer secrets (.env) and saved logins to the assistant, restart it
  apply-update      (run by assistant-update.service) check out the version the assistant asked for
  check             is it safe: no sudo, other homes closed, code read-only, service up
  uninstall         stop it and start your own user service again (the user and its data stay)`;

export function unitText({ nodeDir, memory = '2G', uid }) {
  return `# The assistant as its own user. Installed by own-user.js.
[Unit]
Description=Personal assistant gateway (own user)
After=network-online.target
Wants=network-online.target

[Service]
User=${BOT}
Group=${BOT}
WorkingDirectory=${APP}/gateway
ExecStart="${nodeDir}/node" --disable-warning=ExperimentalWarning "${APP}/gateway/src/index.js"
Environment="HOME=${BOT_HOME}"
Environment="ASSISTANT_HOME=${BOT_BASE}"
Environment="ASSISTANT_OWN_USER=1"
Environment="XDG_RUNTIME_DIR=/run/user/${uid}"
Environment="PATH=${BOT_HOME}/.local/bin:${nodeDir}:/usr/local/bin:/usr/bin:/bin"
Restart=always
RestartSec=5
MemoryMax=${memory}
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=${BOT_HOME}
ProtectHome=tmpfs
BindPaths=${BOT_HOME}
ProtectKernelTunables=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
`;
}

export function updateUnits({ nodeDir }) {
  return {
    'assistant-update.path': `[Unit]\nDescription=The assistant asked for a new version\n\n[Path]\nPathChanged=${REQUEST}\n\n[Install]\nWantedBy=multi-user.target\n`,
    'assistant-update.service': `[Unit]\nDescription=Update the assistant's code (root)\n\n[Service]\nType=oneshot\nExecStart="${nodeDir}/node" "${APP}/gateway/bin/own-user.js" apply-update\nEnvironment="PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin"\n`,
  };
}

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const ok = (cmd, args) => { try { sh(cmd, args); return true; } catch { return false; } };
const copy = (from, to) => { if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true }); } };
const userHome = (u) => sh('getent', ['passwd', u]).split(':')[5];
const asUser = (u, cmd, args) => sh('runuser', ['-u', u, '--', cmd, ...args]);

// Absolute paths of the owner's base inside copied JSON (brain dir, agent folder) → the bot's.
export function rehome(text, ownerBase) { return text.split(ownerBase).join(BOT_BASE); }

function need(cond, msg) { if (!cond) throw new Error(msg); }

function install({ owner, memory }) {
  need(os.platform() === 'linux', 'only Linux / WSL2 (macOS keeps running as your user)');
  need(process.getuid?.() === 0, 'run with sudo');
  need(ok('systemctl', ['--version']), 'systemd is needed (WSL2: set systemd=true in /etc/wsl.conf)');
  const home = userHome(owner);
  const base = path.join(home, '.assistant');
  need(fs.existsSync(path.join(base, 'app', 'gateway', 'src', 'index.js')), `no assistant in ${base} yet: run the setup first`);
  const log = [];
  // 1. the user
  if (!ok('id', [BOT])) sh('useradd', ['--system', '--create-home', '--home-dir', BOT_HOME, '--shell', '/usr/sbin/nologin', BOT]);
  fs.chmodSync(BOT_HOME, 0o750);
  const uid = sh('id', ['-u', BOT]);
  sh('loginctl', ['enable-linger', BOT]); // its own runtime dir (Chromium, the Claude CLI want one)
  log.push(`user ${BOT} (uid ${uid})`);
  // 2. your user service stops (one gateway at a time)
  const ouid = sh('id', ['-u', owner]);
  try { sh('runuser', ['-u', owner, '--', 'env', `XDG_RUNTIME_DIR=/run/user/${ouid}`, 'systemctl', '--user', 'disable', '--now', 'assistant.service']); log.push('your user service stopped'); } catch { /* not installed */ }
  // 3. the code, root-owned and read-only for the assistant
  fs.rmSync(APP, { recursive: true, force: true });
  copy(path.join(base, 'app'), APP);
  sh('chown', ['-R', 'root:root', OPT]);
  sh('chmod', ['-R', 'u+rwX,go+rX,go-w', OPT]);
  // Node in your home is hidden from the service: a copy goes next to the code.
  let nodeDir = path.dirname(process.execPath);
  if (nodeDir.startsWith('/home/') || nodeDir.startsWith('/root')) {
    copy(path.dirname(nodeDir), `${OPT}/node`);
    sh('chown', ['-R', 'root:root', `${OPT}/node`]);
    nodeDir = `${OPT}/node/bin`;
  }
  log.push(`code ${APP}, node ${nodeDir}`);
  // 4. its data: a copy of yours, paths moved to its home
  for (const d of ['repo', 'data', 'home', 'config.json']) copy(path.join(base, d), path.join(BOT_BASE, d));
  for (const f of [path.join(BOT_BASE, 'config.json'), path.join(BOT_BASE, 'repo', 'config.json')]) {
    if (fs.existsSync(f)) fs.writeFileSync(f, rehome(fs.readFileSync(f, 'utf8'), base));
  }
  // 5. Claude Code and its login, Chromium
  copy(path.join(home, '.local', 'share', 'claude'), path.join(BOT_HOME, '.local', 'share', 'claude'));
  const link = path.join(home, '.local', 'bin', 'claude');
  if (fs.existsSync(link)) {
    const target = fs.realpathSync(link).replace(home, BOT_HOME);
    fs.mkdirSync(path.join(BOT_HOME, '.local', 'bin'), { recursive: true });
    fs.rmSync(path.join(BOT_HOME, '.local', 'bin', 'claude'), { force: true });
    fs.symlinkSync(target, path.join(BOT_HOME, '.local', 'bin', 'claude'));
  }
  copy(path.join(home, '.claude', '.credentials.json'), path.join(BOT_HOME, '.claude', '.credentials.json'));
  copy(path.join(home, '.claude.json'), path.join(BOT_HOME, '.claude.json'));
  copy(path.join(home, '.cache', 'ms-playwright'), path.join(BOT_HOME, '.cache', 'ms-playwright'));
  sh('chown', ['-R', `${BOT}:${BOT}`, BOT_HOME]);
  for (const p of [path.join(BOT_BASE, 'data'), path.join(BOT_HOME, '.claude')]) if (fs.existsSync(p)) fs.chmodSync(p, 0o700);
  // 6. the private repo on its own deploy key (your GitHub login stays yours)
  if (fs.existsSync(path.join(BOT_BASE, 'repo', '.git'))) log.push(repoKey(owner));
  // 7. services
  fs.writeFileSync(path.join(UNITS, 'assistant.service'), unitText({ nodeDir, memory, uid }));
  for (const [n, t] of Object.entries(updateUnits({ nodeDir }))) fs.writeFileSync(path.join(UNITS, n), t);
  sh('systemctl', ['daemon-reload']);
  sh('systemctl', ['enable', '--now', 'assistant.service', 'assistant-update.path']);
  log.push('assistant.service and assistant-update.path on');
  return [...log, check({ owner })].join('\n');
}

// The bot's clone of the private repo pulls and pushes with a key of its own, added to the repo
// by you (gh, your login). Write access: the brain commits its notes.
function repoKey(owner) {
  const key = path.join(BOT_HOME, '.ssh', 'assistant_repo');
  if (!fs.existsSync(key)) {
    fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
    sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'assistant-own-user', '-f', key]);
  }
  sh('chown', ['-R', `${BOT}:${BOT}`, path.dirname(key)]);
  const repo = path.join(BOT_BASE, 'repo');
  const url = sh('git', ['-C', repo, 'remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(url);
  if (!m) return `repo: not on GitHub (${url}); pulls use its remote as is`;
  const pub = `/tmp/assistant-own-user-${process.pid}.pub`;
  fs.copyFileSync(`${key}.pub`, pub);
  fs.chmodSync(pub, 0o644);
  try { asUser(owner, 'gh', ['repo', 'deploy-key', 'add', pub, '--repo', m[1], '--allow-write', '--title', `assistant user on ${os.hostname()}`]); } catch (e) { if (!/already/.test(String(e.stderr))) throw e; } finally { fs.rmSync(pub, { force: true }); }
  sh('git', ['-C', repo, 'remote', 'set-url', 'origin', `git@github.com:${m[1]}.git`]);
  sh('git', ['-C', repo, 'config', 'core.sshCommand', `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`]);
  sh('git', ['config', '--system', '--add', 'safe.directory', repo]);
  return `repo ${m[1]}: own deploy key`;
}

function syncFromOwner({ owner }) {
  const base = path.join(userHome(owner), '.assistant');
  const out = [];
  if (fs.existsSync(path.join(base, 'data', '.env'))) { copy(path.join(base, 'data', '.env'), path.join(BOT_BASE, 'data', '.env')); out.push('secrets'); }
  const b = path.join(base, 'data', 'browser');
  for (const f of fs.existsSync(b) ? fs.readdirSync(b).filter((n) => n.endsWith('.import.json')) : []) {
    copy(path.join(b, f), path.join(BOT_BASE, 'data', 'browser', f));
    fs.rmSync(path.join(b, f), { force: true });
    out.push(`logins ${f.replace('.import.json', '')}`);
  }
  sh('chown', ['-R', `${BOT}:${BOT}`, path.join(BOT_BASE, 'data')]);
  sh('chmod', ['600', path.join(BOT_BASE, 'data', '.env')]);
  sh('systemctl', ['restart', 'assistant.service']);
  return `copied: ${out.join(', ') || 'nothing new'}; restarted`;
}

// The assistant wrote { version } to REQUEST (src/sync.js). Root checks out exactly that tag.
export function applyUpdate({ run = sh, request = REQUEST } = {}) {
  if (!fs.existsSync(request)) return 'no request';
  const text = fs.readFileSync(request, 'utf8');
  fs.rmSync(request, { force: true }); // first: a bad request must never come back as a loop
  let version;
  try { ({ version } = JSON.parse(text)); } catch { throw new Error('the update request is not JSON'); }
  if (typeof version !== 'string' || !TAG.test(version)) throw new Error(`not a tag: ${version}`);
  run('git', ['-C', APP, 'fetch', '-q', '--tags', 'origin']);
  // The same resolution as src/sync.js: a tag, else a branch on origin.
  let target;
  try { target = run('git', ['-C', APP, 'rev-parse', `${version}^{commit}`]); } catch { target = run('git', ['-C', APP, 'rev-parse', `origin/${version}^{commit}`]); }
  run('git', ['-C', APP, 'checkout', '-q', target]);
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: `${APP}/gateway` });
  run('systemctl', ['restart', 'assistant.service']);
  return `updated to ${version}`;
}

function check({ owner }) {
  const home = userHome(owner);
  const line = (good, text) => `${good ? 'ok' : 'BAD'}: ${text}`;
  return [
    line(!ok('runuser', ['-u', BOT, '--', 'sudo', '-n', 'true']), `${BOT} has no sudo`),
    line(!sh('id', ['-nG', BOT]).split(/\s+/).some((g) => ['sudo', 'wheel', 'admin', 'docker', 'lxd'].includes(g)), `${BOT} is in no admin group`),
    line(!ok('runuser', ['-u', BOT, '--', 'test', '-w', `${APP}/gateway/src/policy.js`]), 'the code is read-only for it'),
    line(sh('stat', ['-c', '%a', home]).slice(-1) === '0' || !ok('runuser', ['-u', BOT, '--', 'ls', home]), `it cannot read ${home} (and the service hides all homes anyway)`),
    line(ok('systemctl', ['is-active', '--quiet', 'assistant.service']), 'assistant.service is running'),
  ].join('\n');
}

function uninstall({ owner }) {
  need(process.getuid?.() === 0, 'run with sudo');
  try { sh('systemctl', ['disable', '--now', 'assistant.service', 'assistant-update.path']); } catch { /* not there */ }
  for (const n of ['assistant.service', 'assistant-update.path', 'assistant-update.service']) fs.rmSync(path.join(UNITS, n), { force: true });
  sh('systemctl', ['daemon-reload']);
  const ouid = sh('id', ['-u', owner]);
  const node = path.join(userHome(owner), '.assistant', 'app', 'gateway', 'bin', 'service.js');
  try { sh('runuser', ['-u', owner, '--', 'env', `XDG_RUNTIME_DIR=/run/user/${ouid}`, process.execPath, node, 'install']); } catch (e) { return `stopped; start your own service with: node ${node} install (${String(e.stderr || e.message).split('\n')[0]})`; }
  return `back to your own user service. The ${BOT} user and ${BOT_BASE} stay; remove them with: sudo userdel -r ${BOT}`;
}

export function main([cmd, ...rest]) {
  const opt = (k, d) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : d);
  const owner = opt('owner', process.env.SUDO_USER);
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (cmd === 'apply-update') return applyUpdate();
  if (!/^[a-z_][\w-]*$/i.test(owner || '') || owner === 'root' || owner === BOT) throw new Error('run it with sudo from your own user (or give --owner USER)');
  if (cmd === 'install') return install({ owner, memory: opt('memory', '2G') });
  if (cmd === 'sync-from-owner') return syncFromOwner({ owner });
  if (cmd === 'check') return check({ owner });
  if (cmd === 'uninstall') return uninstall({ owner });
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(main(process.argv.slice(2))); } catch (e) { console.error(`ERROR: ${String(e.stderr || e.message).split('\n')[0]}`); process.exit(1); }
}
