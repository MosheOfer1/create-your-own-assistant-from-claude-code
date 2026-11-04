#!/usr/bin/env node
// Runs the gateway as a service on this machine.
//   Linux / WSL2: a systemd user unit (linger on, so it runs without a login), memory capped.
//   macOS: a launchd agent (runs while the user is logged in).
// The machine must stay on and awake: the assistant sleeps with it.
// Updates need no timer: the gateway pulls the private repo before a turn (src/sync.js);
// `update` does it now, by hand.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeSync } from '../src/sync.js';

const BASE = process.env.ASSISTANT_HOME || path.join(os.homedir(), '.assistant');
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'); // the public repo checkout
const NAME = 'assistant';
const UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', `${NAME}.service`);
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `local.${NAME}.gateway.plist`);

const USAGE = `Usage: service.js COMMAND
  install [--memory 2G]   install and start the service
  uninstall               stop and remove it (data and config stay)
  status | restart | logs [N]
  update                  pull the private repo now; restart if config.json or the pinned version changed`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const which = (bin) => { try { return run('sh', ['-c', `command -v ${bin}`]); } catch { return null; } };
const mac = os.platform() === 'darwin';
const uid = () => os.userInfo().uid;

export function unitText({ node, app = APP, base = BASE, memory = '2G', pathDirs }) {
  return `[Unit]
Description=Personal assistant gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="${node}" --disable-warning=ExperimentalWarning "${path.join(app, 'gateway', 'src', 'index.js')}"
WorkingDirectory=${path.join(app, 'gateway')}
Environment="ASSISTANT_HOME=${base}"
Environment="PATH=${pathDirs.join(':')}"
Restart=always
RestartSec=5
MemoryMax=${memory}
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export function plistText({ node, app = APP, base = BASE, pathDirs }) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const argv = [node, '--disable-warning=ExperimentalWarning', path.join(app, 'gateway', 'src', 'index.js')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.${NAME}.gateway</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${esc(path.join(app, 'gateway'))}</string>
  <key>EnvironmentVariables</key><dict><key>ASSISTANT_HOME</key><string>${esc(base)}</string><key>PATH</key><string>${esc(pathDirs.join(':'))}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
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
    try { run('launchctl', ['bootout', `gui/${uid()}`, PLIST]); } catch { /* not loaded */ }
    run('launchctl', ['bootstrap', `gui/${uid()}`, PLIST]);
    return `installed ${PLIST}; logs in ${path.join(BASE, 'gateway.log')}`;
  }
  fs.mkdirSync(path.dirname(UNIT), { recursive: true });
  fs.writeFileSync(UNIT, unitText(opts));
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
  let linger = 'on';
  try { run('loginctl', ['enable-linger', os.userInfo().username]); } catch { linger = 'NOT on (ask for: sudo loginctl enable-linger $USER) - without it the assistant stops when you log out'; }
  return `installed ${UNIT} (memory cap ${memory}); linger ${linger}`;
}

function uninstall() {
  if (mac) {
    try { run('launchctl', ['bootout', `gui/${uid()}`, PLIST]); } catch { /* not loaded */ }
    fs.rmSync(PLIST, { force: true });
  } else {
    try { run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]); } catch { /* not there */ }
    fs.rmSync(UNIT, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
  }
  return 'removed (config and data stay in ~/.assistant)';
}

const restart = () => (mac ? run('launchctl', ['kickstart', '-k', `gui/${uid()}/local.${NAME}.gateway`]) : run('systemctl', ['--user', 'restart', `${NAME}.service`])) || 'restarted';

// By hand: pull the private repo now (the gateway also does it before each turn).
export async function update({ base = BASE, app = APP, restartFn = restart, sync = makeSync({ base, app }) } = {}) {
  return (await sync({ force: true })) === 'restart' ? restartFn() : 'up to date';
}

export async function main([cmd, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (cmd === 'install') return install(rest.includes('--memory') ? rest[rest.indexOf('--memory') + 1] : '2G');
  if (cmd === 'uninstall') return uninstall();
  if (cmd === 'restart') return restart();
  if (cmd === 'status') return mac ? run('launchctl', ['print', `gui/${uid()}/local.${NAME}.gateway`]).split('\n').slice(0, 12).join('\n') : run('sh', ['-c', `systemctl --user status ${NAME}.service --no-pager | head -12`]);
  if (cmd === 'logs') {
    const n = String(Number(rest[0]) || 50);
    return mac ? run('tail', ['-n', n, path.join(BASE, 'gateway.log')]) : run('journalctl', ['--user', '-u', `${NAME}.service`, '-n', n, '--no-pager']);
  }
  if (cmd === 'update') return update();
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((out) => out && console.log(out), (e) => { console.error(`ERROR: ${String(e.message).split('\n')[0]}`); process.exit(1); });
}
