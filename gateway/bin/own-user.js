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
// The only versions root installs: release tags. A branch or a commit could be anything.
const RELEASE = /^v(\d+)\.(\d+)\.(\d+)$/;

const USAGE = `Usage: sudo node own-user.js COMMAND [--owner USER] [--memory 2G]
  install           create the user, copy code and data, start assistant.service (your user service stops)
  sync-from-owner   copy your newer secrets (.env) and saved logins to the assistant, restart it
  apply-update      (run by assistant-update.service) check out the release the assistant asked for:
                    only a tag vX.Y.Z newer than the installed one (never a branch, never older)
  rollback vX.Y.Z   (you, by hand) go back to an older release: sudo node own-user.js rollback v1.2.0
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
const asUser = (u, cmd, args, opts) => sh('runuser', ['-u', u, '--', cmd, ...args], opts);

// Absolute paths of the owner's base inside copied JSON (brain dir, agent folder) → the bot's.
export function rehome(text, ownerBase) { return text.split(ownerBase).join(BOT_BASE); }

function need(cond, msg) { if (!cond) throw new Error(msg); }

// Root never writes in the assistant's home with its own rights. The assistant owns that home and
// can put a symlink there (data/.env -> /etc/shadow, data -> /etc): fs.cpSync, writeFileSync and
// chmodSync all follow it, so root would write or chmod the file it points to. Two guards:
//  1. noLink: every part of the path that exists below `top` is a real file or folder (a clear refusal);
//  2. the writes themselves run as the assistant (asBot, giveBot): a link it planted can only lead
//     it to files it could change anyway. That also closes the gap between the check and the write.
export function noLink(p, top = BOT_HOME) {
  const rel = path.relative(top, p);
  need(!rel.startsWith('..') && !path.isAbsolute(rel), `${p} is not inside ${top}`);
  let cur = top;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') return p; throw e; }
    need(!st.isSymbolicLink(), `refusing: ${cur} is a symlink, and root must not follow it out of the assistant's home. Remove it and run again`);
  }
  return p;
}

const asBot = (cmd, args, opts) => asUser(BOT, cmd, args, opts);
// Writes `text` to `file` as the assistant (it owns the file, see noLink).
const writeAsBot = (file, text) => asBot('sh', ['-c', 'cat > "$1"', 'sh', noLink(file)], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });

// Root reads the owner's side with tar; the assistant unpacks it on its side. Modes come along
// (.env stays 0600), symlinks stay symlinks, and the files are the assistant's (no chown -R).
// pipefail: a failed read must fail the copy, not unpack half of it.
const GIVE = 'set -eo pipefail; src=$1 name=$2 dest=$3; shift 3; tar -C "$src" -cf - "$name" | "$@" sh -c \'mkdir -p "$1" && tar -C "$1" -xpf - --no-same-owner\' sh "$dest"';
// Copies the owner's file or folder `from` to `to` in the assistant's home (same base name).
export function giveBot(from, to, { run = sh, as = ['runuser', '-u', BOT, '--'], top = BOT_HOME } = {}) {
  if (!fs.existsSync(from)) return false;
  need(path.basename(from) === path.basename(to), `copy ${from} to a path with the same name, not ${to}`);
  noLink(to, top);
  run('bash', ['-c', GIVE, 'bash', path.dirname(from), path.basename(from), path.dirname(to), ...as]);
  return true;
}

// Reads a small plain file that the assistant can change. O_NOFOLLOW: a symlink as the last part
// fails (ELOOP) instead of being followed; O_NONBLOCK: a FIFO put there cannot hang root.
export function readPlain(file, max = 64 << 10) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
    if (e.code === 'ELOOP') throw new Error(`refusing: ${file} is a symlink`);
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    need(st.isFile(), `refusing: ${file} is not a plain file`);
    need(st.size <= max, `refusing: ${file} is larger than ${max} bytes`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

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
  fs.chmodSync(noLink(BOT_HOME), 0o750);
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
  // 4. its data: a copy of yours, paths moved to its home. All writes in its home are its own (noLink).
  for (const d of ['repo', 'data', 'home', 'config.json']) giveBot(path.join(base, d), path.join(BOT_BASE, d));
  for (const f of ['config.json', path.join('repo', 'config.json')]) {
    if (fs.existsSync(path.join(base, f))) writeAsBot(path.join(BOT_BASE, f), rehome(fs.readFileSync(path.join(base, f), 'utf8'), base));
  }
  // 5. Claude Code and its login, Chromium
  giveBot(path.join(home, '.local', 'share', 'claude'), path.join(BOT_HOME, '.local', 'share', 'claude'));
  const link = path.join(home, '.local', 'bin', 'claude');
  if (fs.existsSync(link)) {
    const target = fs.realpathSync(link).replace(home, BOT_HOME);
    asBot('mkdir', ['-p', noLink(path.join(BOT_HOME, '.local', 'bin'))]);
    asBot('ln', ['-sfn', target, path.join(BOT_HOME, '.local', 'bin', 'claude')]); // -n: replace a link, never write into its target
  }
  giveBot(path.join(home, '.claude', '.credentials.json'), path.join(BOT_HOME, '.claude', '.credentials.json'));
  giveBot(path.join(home, '.claude.json'), path.join(BOT_HOME, '.claude.json'));
  giveBot(path.join(home, '.cache', 'ms-playwright'), path.join(BOT_HOME, '.cache', 'ms-playwright'));
  const closed = [path.join(BOT_BASE, 'data'), path.join(BOT_HOME, '.claude')].map((p) => noLink(p));
  asBot('mkdir', ['-p', ...closed]);
  asBot('chmod', ['700', ...closed]);
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
// Everything in its home runs as the assistant: root reading .ssh/assistant_repo.pub could be made
// to read /etc/shadow through a symlink, and root running git in a repo the assistant controls
// would run the assistant's git config (hooks, core.fsmonitor) as root. So no system-wide
// safe.directory for root either.
function repoKey(owner) {
  const key = path.join(BOT_HOME, '.ssh', 'assistant_repo');
  asBot('mkdir', ['-p', '-m', '700', path.dirname(key)]);
  if (!ok('runuser', ['-u', BOT, '--', 'test', '-e', key])) asBot('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'assistant-own-user', '-f', key]);
  const repo = path.join(BOT_BASE, 'repo');
  const url = asBot('git', ['-C', repo, 'remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/.exec(url);
  if (!m) return `repo: not on GitHub (${url}); pulls use its remote as is`;
  // A machine set up over SSH (remote.js) has no gh: your clone already pulls and pushes with a
  // deploy key made there. The assistant gets a copy of that key instead of one of its own.
  const ownerKey = path.join(userHome(owner), '.ssh', 'assistant_repo');
  if (!ok('runuser', ['-u', owner, '--', 'gh', '--version']) && fs.existsSync(ownerKey)) {
    asBot('rm', ['-f', key, `${key}.pub`]);
    giveBot(ownerKey, key);
    giveBot(`${ownerKey}.pub`, `${key}.pub`);
    asBot('chmod', ['600', key]);
    asBot('git', ['-C', repo, 'remote', 'set-url', 'origin', `git@github.com:${m[1]}.git`]);
    asBot('git', ['-C', repo, 'config', 'core.sshCommand', `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`]);
    return `repo ${m[1]}: the deploy key of your clone (no gh here)`;
  }
  const pub = publicKey(asBot('cat', [`${key}.pub`]));
  // gh runs as you. The key goes in a fresh folder (mkdtemp: a name no one can guess or plant
  // first), handed to you, removed after.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-own-user-'));
  try {
    const file = path.join(dir, 'assistant_repo.pub');
    fs.writeFileSync(file, `${pub}\n`, { mode: 0o644 });
    fs.chownSync(dir, Number(sh('id', ['-u', owner])), Number(sh('id', ['-g', owner])));
    asUser(owner, 'gh', ['repo', 'deploy-key', 'add', file, '--repo', m[1], '--allow-write', '--title', `assistant user on ${os.hostname()}`]);
  } catch (e) { if (!/already/.test(String(e.stderr))) throw e; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  asBot('git', ['-C', repo, 'remote', 'set-url', 'origin', `git@github.com:${m[1]}.git`]);
  asBot('git', ['-C', repo, 'config', 'core.sshCommand', `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`]);
  return `repo ${m[1]}: own deploy key`;
}

// Only a one-line ed25519 public key goes to GitHub, never whatever else the file holds.
export function publicKey(text) {
  const line = String(text).trim();
  need(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [\w.@-]+)?$/.test(line), 'the deploy key is not one ed25519 public key line');
  return line;
}

function syncFromOwner({ owner }) {
  const base = path.join(userHome(owner), '.assistant');
  const out = [];
  // The assistant is running now: every write on its side is its own (see noLink).
  const env = path.join(BOT_BASE, 'data', '.env');
  if (giveBot(path.join(base, 'data', '.env'), env)) { asBot('chmod', ['600', env]); out.push('secrets'); }
  const b = path.join(base, 'data', 'browser');
  for (const f of fs.existsSync(b) ? fs.readdirSync(b).filter((n) => n.endsWith('.import.json')) : []) {
    giveBot(path.join(b, f), path.join(BOT_BASE, 'data', 'browser', f));
    fs.rmSync(path.join(b, f), { force: true });
    out.push(`logins ${f.replace('.import.json', '')}`);
  }
  sh('systemctl', ['restart', 'assistant.service']);
  return `copied: ${out.join(', ') || 'nothing new'}; restarted`;
}

// a > b for two release tags, as numbers: v1.10.0 is newer than v1.9.0.
export function newer(a, b) {
  const [x, y] = [a, b].map((v) => RELEASE.exec(v).slice(1).map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The installed release: the newest vX.Y.Z tag that HEAD contains (null before the first release).
function installed(run) {
  const tags = run('git', ['-C', APP, 'tag', '--merged', 'HEAD', '--list', 'v*']).split('\n').map((t) => t.trim()).filter((t) => RELEASE.test(t));
  return tags.reduce((best, t) => (!best || newer(t, best) ? t : best), null);
}

// Root checks out the commit of refs/tags/<version> (a branch of the same name never counts) and
// installs its dependencies. --ignore-scripts: npm would run the install scripts of every package
// as root. Only two have one (package-lock "hasInstallScript"): @whiskeysockets/baileys (preinstall:
// a Node >= 20 check; its "prepare" build never runs for a registry package) and protobufjs
// (postinstall: a version-scheme warning). Neither builds or downloads anything the gateway needs,
// so skipping them changes nothing but keeps a hijacked dependency from running code as root.
function checkoutRelease(run, version) {
  const target = run('git', ['-C', APP, 'rev-parse', `refs/tags/${version}^{commit}`]);
  run('git', ['-C', APP, 'checkout', '-q', target]);
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: `${APP}/gateway` });
  run('systemctl', ['restart', 'assistant.service']);
}

// The assistant wrote { version } to REQUEST (src/sync.js). The assistant can write anything
// there, so root takes only a release tag newer than the installed one: no branch, no commit,
// no way back to an old version with a known hole. Going back is `rollback`, by hand.
export function applyUpdate({ run = sh, request = REQUEST, top = BOT_HOME } = {}) {
  noLink(path.dirname(request), top); // before the rm too: a linked data/ would make it remove a file elsewhere
  let text;
  try { text = readPlain(request); } catch (e) { if (e.code === 'ENOENT') return 'no request'; throw e; } finally {
    fs.rmSync(request, { force: true }); // first: a bad request must never come back as a loop (a link: only the link goes)
  }
  let version;
  try { ({ version } = JSON.parse(text)); } catch { throw new Error('the update request is not JSON'); }
  if (typeof version !== 'string' || !RELEASE.test(version)) throw new Error(`not a release tag (vX.Y.Z): ${version}`);
  run('git', ['-C', APP, 'fetch', '-q', '--tags', 'origin']);
  const now = installed(run);
  need(!now || newer(version, now), `refusing ${version}: not newer than the installed ${now} (to go back: sudo node own-user.js rollback ${version})`);
  checkoutRelease(run, version);
  return `updated to ${version}`;
}

// By hand, as root: any release tag, an older one too. The assistant cannot start this.
export function rollback(version, { run = sh } = {}) {
  need(typeof version === 'string' && RELEASE.test(version), `not a release tag (vX.Y.Z): ${version}\n${USAGE}`);
  run('git', ['-C', APP, 'fetch', '-q', '--tags', 'origin']);
  checkoutRelease(run, version);
  return `rolled back to ${version}`;
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
  if (cmd === 'rollback') {
    need(RELEASE.test(rest[0] || ''), `not a release tag (vX.Y.Z): ${rest[0]}\n${USAGE}`);
    need(process.getuid?.() === 0, 'run with sudo');
    return rollback(rest[0]);
  }
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
