#!/usr/bin/env node
// Runs the gateway as a service on this machine, and keeps it updated.
//   Linux / WSL2: a systemd user unit (linger on, so it runs without a login), memory capped.
//   macOS: a launchd agent (runs while the user is logged in).
// The machine must stay on and awake: the assistant sleeps with it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.ASSISTANT_HOME || path.join(os.homedir(), '.assistant');
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'); // the public repo checkout
const NAME = 'assistant';
const UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
const TIMER = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}-update`);
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `local.${NAME}.gateway.plist`);
const UPLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `local.${NAME}.update.plist`);

const USAGE = `Usage: service.js COMMAND
  install [--memory 2G]   install and start the service (and the 5-minute update timer on Linux)
  uninstall               stop and remove it (data and config stay)
  status | restart | logs [N]
  update                  pull the private repo (config, brain); if it pins another version
                          (config.version, a git tag of the public repo), check it out, npm ci, restart`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const which = (bin) => { try { return run('sh', ['-c', `command -v ${bin}`]); } catch { return null; } };
const mac = os.platform() === 'darwin';

export function unitText({ node, app = APP, base = BASE, memory = '2G', pathDirs }) {
  return `[Unit]
Description=Personal assistant gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${node} --disable-warning=ExperimentalWarning ${path.join(app, 'gateway', 'src', 'index.js')}
WorkingDirectory=${path.join(app, 'gateway')}
Environment=ASSISTANT_HOME=${base}
Environment=PATH=${pathDirs.join(':')}
Restart=always
RestartSec=5
MemoryMax=${memory}
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export function plistText({ node, app = APP, base = BASE, pathDirs, label = 'gateway', args, every }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const argv = args || ['--disable-warning=ExperimentalWarning', path.join(app, 'gateway', 'src', 'index.js')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.${NAME}.${label}</string>
  <key>ProgramArguments</key><array>${[node, ...argv].map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${esc(path.join(app, 'gateway'))}</string>
  <key>EnvironmentVariables</key><dict><key>ASSISTANT_HOME</key><string>${esc(base)}</string><key>PATH</key><string>${esc(pathDirs.join(':'))}</string></dict>
  ${every ? `<key>StartInterval</key><integer>${every}</integer>` : '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'}
  <key>StandardOutPath</key><string>${esc(path.join(base, 'gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(base, 'gateway.log'))}</string>
</dict></plist>
`;
}

// systemd/launchd start with an almost empty PATH: give it where node and claude live.
function pathDirs() {
  const dirs = [path.dirname(process.execPath), which('claude') && path.dirname(which('claude')), which('ffmpeg') && path.dirname(which('ffmpeg')),
    path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs.filter(Boolean))];
}

function install(memory = '2G') {
  if (!which('claude')) throw new Error('claude is not on PATH; install Claude Code and log in first');
  const opts = { node: process.execPath, memory, pathDirs: pathDirs() };
  if (mac) {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plistText(opts));
    // The update: a second agent every 5 minutes (launchd has no timers).
    fs.writeFileSync(UPLIST, plistText({ ...opts, label: 'update', args: [path.join(APP, 'gateway', 'bin', 'service.js'), 'update'], every: 300 }));
    for (const p of [PLIST, UPLIST]) {
      try { run('launchctl', ['bootout', `gui/${os.userInfo().uid}`, p]); } catch { /* not loaded */ }
      run('launchctl', ['bootstrap', `gui/${os.userInfo().uid}`, p]);
    }
    return `installed ${PLIST}; logs in ${path.join(BASE, 'gateway.log')}`;
  }
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, unitText(opts));
  fs.writeFileSync(`${TIMER}.service`, `[Unit]\nDescription=Update the personal assistant\n\n[Service]\nType=oneshot\nEnvironment=ASSISTANT_HOME=${BASE}\nEnvironment=PATH=${opts.pathDirs.join(':')}\nExecStart=${process.execPath} ${path.join(APP, 'gateway', 'bin', 'service.js')} update\n`);
  fs.writeFileSync(`${TIMER}.timer`, '[Unit]\nDescription=Update the personal assistant (every 5 minutes)\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\nRandomizedDelaySec=30s\n\n[Install]\nWantedBy=timers.target\n');
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`, `${NAME}-update.timer`]);
  let linger = 'on';
  try { run('loginctl', ['enable-linger', os.userInfo().username]); } catch { linger = 'NOT on (ask for: sudo loginctl enable-linger $USER) - without it the assistant stops when you log out'; }
  return `installed ${UNIT} (memory cap ${memory}); linger ${linger}`;
}

function uninstall() {
  if (mac) {
    for (const p of [PLIST, UPLIST]) {
      try { run('launchctl', ['bootout', `gui/${os.userInfo().uid}`, p]); } catch { /* not loaded */ }
      fs.rmSync(p, { force: true });
    }
    return 'removed (config and data stay in ~/.assistant)';
  }
  try { run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`, `${NAME}-update.timer`]); } catch { /* not there */ }
  for (const f of [UNIT, `${TIMER}.service`, `${TIMER}.timer`]) fs.rmSync(f, { force: true });
  run('systemctl', ['--user', 'daemon-reload']);
  return 'removed (config and data stay in ~/.assistant)';
}

const restart = () => (mac ? run('launchctl', ['kickstart', '-k', `gui/${os.userInfo().uid}/local.${NAME}.gateway`]) : run('systemctl', ['--user', 'restart', `${NAME}.service`])) || 'restarted';

// The private repo (config + brain) is ~/.assistant/repo when the setup made one. Pull it (the
// brain's own commits are rebased on top) and move the code to the version config.json pins.
// Every host runs this from its timer: no inbound ssh, no server key in GitHub, works behind a
// home router. A push to the private repo is live within ~5 minutes.
export function update({ base = BASE, app = APP, sh = run, log = console.log } = {}) {
  const repo = path.join(base, 'repo');
  const out = [];
  let restartNeeded = false;
  if (fs.existsSync(path.join(repo, '.git'))) {
    const conf = () => { try { return sh('git', ['-C', repo, 'rev-parse', 'HEAD:config.json']); } catch { return ''; } };
    const before = conf();
    sh('git', ['-C', repo, 'pull', '-q', '--rebase', '--autostash']);
    if (conf() !== before) { out.push('config changed'); restartNeeded = true; }
  }
  const cfg = [path.join(repo, 'config.json'), path.join(base, 'config.json')].find((f) => fs.existsSync(f));
  const want = cfg && JSON.parse(fs.readFileSync(cfg, 'utf8')).version;
  if (want) {
    const have = sh('git', ['-C', app, 'describe', '--tags', '--always']);
    if (have !== want) {
      sh('git', ['-C', app, 'fetch', '-q', '--tags', 'origin']);
      sh('git', ['-C', app, 'checkout', '-q', want]);
      sh('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(app, 'gateway') });
      out.push(`code ${have} → ${want}`);
      restartNeeded = true;
    }
  }
  if (restartNeeded) out.push(restart());
  log(out.join('; ') || 'up to date');
  return out;
}

export function main([cmd, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (cmd === 'install') return install(rest.includes('--memory') ? rest[rest.indexOf('--memory') + 1] : '2G');
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'restart') return restart();
  if (cmd === 'status') return mac ? run('launchctl', ['print', `gui/${os.userInfo().uid}/local.${NAME}.gateway`]).split('\n').slice(0, 12).join('\n') : run('sh', ['-c', `systemctl --user status ${NAME}.service --no-pager | head -12`]);
  if (cmd === 'logs') {
    const n = String(Number(rest[0]) || 50);
    return mac ? run('tail', ['-n', n, path.join(BASE, 'gateway.log')]) : run('journalctl', ['--user', '-u', `${NAME}.service`, '-n', n, '--no-pager']);
  }
  if (cmd === 'update') { update(); return ''; }
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const out = main(process.argv.slice(2)); if (out) console.log(out); } catch (e) { console.error(`ERROR: ${String(e.message).split('\n')[0]}`); process.exit(1); }
}
