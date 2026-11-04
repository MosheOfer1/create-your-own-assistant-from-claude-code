#!/usr/bin/env node
// A browser for your own Claude Code sessions (the web-browse skill). One Chrome per identity
// stays open between commands, so logins, tabs and half-done forms persist. It listens on
// 127.0.0.1 only. Public pages only; it never types into password or card fields.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, chromePath } from '../modules/browse/browser.js';

const USAGE = `Usage: browse.js COMMAND [ARGS]      (identity: $BROWSE_IDENTITY, default "me")
  start [--show]          start this identity's Chrome (--show: a visible window)
  stop                    close it (logins stay in the profile)
  open URL                go there; prints title, URL and the page's main text
  text [--max N] [--all]  main text again (--all: menus too)
  links [WORD]            visible links and buttons (text -> href)
  click TARGET            a visible link/button by its text, or a CSS selector
  type TARGET TEXT        fill a field (label, placeholder or CSS)
  press KEY               Enter, Tab, Escape...
  shot [PATH]             screenshot (default /tmp/browse-<identity>.png)
Env: BROWSE_HOME (~/.assistant/browser), BROWSE_CHROME (a Chrome binary).`;

const identity = String(process.env.BROWSE_IDENTITY || 'me').replace(/[^\w-]/g, '_');
const home = process.env.BROWSE_HOME || path.join(os.homedir(), '.assistant', 'browser');
const profileDir = path.join(home, identity);
const port = 9300 + (crypto.createHash('sha256').update(identity).digest()[0] * 2 % 500);
const cdpUrl = `http://127.0.0.1:${port}`;
const pidFile = path.join(home, `${identity}.pid`);

const up = () => fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

async function start(show = false) {
  if (await up()) { if (!show) return; await stop(); }
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--window-size=1280,900',
    ...(show ? [] : ['--headless=new']), 'about:blank'];
  const child = spawn(await chromePath(), args, { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  for (let i = 0; i < 80 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await up())) throw new Error('Chrome did not start');
}

async function stop() {
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* not running */ }
  fs.rmSync(pidFile, { force: true });
  for (let i = 0; i < 40 && (await up()); i++) await new Promise((r) => setTimeout(r, 250));
}

async function main([cmd, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (cmd === 'start') { await start(rest.includes('--show')); return `up (${identity})`; }
  if (cmd === 'stop') { await stop(); return 'stopped'; }
  await start();
  const b = new Browser({ cdpUrl });
  try {
    const flag = (f) => rest.includes(f);
    const opt = (f, d) => (rest.includes(f) ? Number(rest[rest.indexOf(f) + 1]) : d);
    switch (cmd) {
      case 'open': return await b.open(rest[0]);
      case 'text': return await b.text({ max: opt('--max', 6000), all: flag('--all') });
      case 'links': return await b.links(rest[0]);
      case 'click': return await b.click(rest[0]);
      case 'type': return await b.type(rest[0], rest.slice(1).join(' '));
      case 'press': return await b.press(rest[0]);
      case 'shot': return await b.shot(rest[0] || path.join(os.tmpdir(), `browse-${identity}.png`));
      default: throw new Error(`unknown command ${cmd}\n${USAGE}`);
    }
  } finally { await b.close(); }
}

main(process.argv.slice(2)).then((out) => console.log(out), (e) => { console.error(`ERROR: ${String(e.message).split('\n')[0]}`); process.exit(1); });
