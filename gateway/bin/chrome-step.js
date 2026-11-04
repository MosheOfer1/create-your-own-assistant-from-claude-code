#!/usr/bin/env node
// A step the user does with their own hands, in a visible Chrome window on their computer:
// log in to a site, create an app password, read a code. A bar at the top says what to do, in
// their language, with a Done button. Done → the window closes and the work goes on.
// Nothing the user types passes through the chat or this program's output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromePath } from '../modules/browse/browser.js';

const USAGE = `Usage: chrome-step.js COMMAND [options]
  login  --url URL [--identity ID] [--say TEXT] [--out FILE]
         The user logs in. On Done the logins (cookies + localStorage) are saved to FILE
         (default <DATA>/browser/<ID>.import.json, 0600; --data DATA, default ~/.assistant/data,
         where the gateway picks them up). Prints: done | closed | timeout
  step   --url URL --say TEXT          any step by hand (e.g. create a bot, turn on 2FA). Prints: done | closed | timeout
  secret --url URL --say TEXT --field LABEL --save FILE
         the bar has a hidden field; on Done its value goes to FILE (0600), never to the output. Prints: saved | closed | timeout
  push   --identity ID --to USER@HOST:DATADIR [--key FILE]
         sends the saved logins to the assistant's machine over ssh, then deletes the local copy
Options: --lang xx (bar language, default from $LANG), --minutes N (default 20)`;

const BAR = {
  en: { done: 'Done', login: 'Log in here yourself. Then press Done.', field: 'Paste it here' },
  he: { done: 'סיימתי', login: 'התחברו כאן בעצמכם. בסוף לחצו "סיימתי".', field: 'הדביקו כאן' },
};

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
    else o._.push(argv[i]);
  }
  return o;
}

// The bar, added to every page of the window (also after navigations). It calls the exposed
// binding assistantDone(value).
function bar({ say, done, field, rtl }) {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;right:0;font:16px system-ui,sans-serif;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<div dir="${rtl ? 'rtl' : 'ltr'}" style="display:flex;gap:12px;align-items:center;padding:10px 16px;background:#1f6feb;color:#fff;box-shadow:0 2px 8px #0004">
    <span style="flex:1"></span>${field ? '<input type="password" autocomplete="off" style="padding:6px;border-radius:6px;border:0;min-width:16em">' : ''}
    <button style="padding:8px 18px;border:0;border-radius:8px;background:#fff;color:#1f6feb;font-weight:700;cursor:pointer"></button></div>`;
  root.querySelector('span').textContent = say;
  const input = root.querySelector('input');
  if (input) input.placeholder = field;
  const btn = root.querySelector('button');
  btn.textContent = done;
  btn.onclick = () => window.assistantDone(input ? input.value : '');
  const add = () => document.documentElement.appendChild(host);
  if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
}

export async function windowStep(o, { field = false, onPage } = {}) {
  const lang = String(o.lang || process.env.LANG || 'en').slice(0, 2);
  const t = BAR[lang] || BAR.en;
  const { chromium } = await import('playwright-core');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-step-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: !!o.headless, executablePath: await chromePath(), viewport: null, args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  try {
    let finish;
    const result = new Promise((r) => { finish = r; });
    await ctx.exposeBinding('assistantDone', (_src, value) => finish({ how: 'done', value }));
    await ctx.addInitScript(bar, { say: o.say || t.login, done: t.done, field: field ? (typeof o.field === 'string' ? o.field : t.field) : '', rtl: ['he', 'ar', 'fa'].includes(lang) });
    ctx.on('close', () => finish({ how: 'closed' }));
    const page = ctx.pages()[0] || await ctx.newPage();
    page.on('close', () => { if (!ctx.pages().length) finish({ how: 'closed' }); });
    await page.goto(o.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    onPage?.(page);
    const timer = setTimeout(() => finish({ how: 'timeout' }), Number(o.minutes || 20) * 60_000);
    const r = await result;
    clearTimeout(timer);
    if (r.how === 'done' && o.out) {
      fs.mkdirSync(path.dirname(o.out), { recursive: true, mode: 0o700 });
      fs.writeFileSync(o.out, JSON.stringify(await ctx.storageState()), { mode: 0o600 });
    }
    return r;
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const sh = (cmd, a, input) => new Promise((resolve, reject) => {
  const c = spawn(cmd, a, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'inherit'] });
  if (input) c.stdin.end(input);
  c.on('close', (code) => (code ? reject(new Error(`${cmd} exited ${code}`)) : resolve()));
});

async function main(argv) {
  const o = args(argv);
  const cmd = o._[0];
  const data = typeof o.data === 'string' ? o.data : path.join(os.homedir(), '.assistant', 'data');
  const id = String(o.identity || 'assistant').replace(/[^\w-]/g, '_');
  if (!cmd || o.help || o.h) return USAGE;
  if (['login', 'step', 'secret'].includes(cmd) && typeof o.url !== 'string') throw new Error(`--url is required\n${USAGE}`);
  if (cmd === 'login') return (await windowStep({ ...o, out: o.out || path.join(data, 'browser', `${id}.import.json`) })).how;
  if (cmd === 'step') return (await windowStep(o)).how;
  if (cmd === 'secret') {
    if (typeof o.save !== 'string') throw new Error('--save FILE is required');
    const r = await windowStep(o, { field: true });
    if (r.how !== 'done') return r.how;
    if (!String(r.value || '').trim()) return 'empty';
    fs.mkdirSync(path.dirname(o.save), { recursive: true, mode: 0o700 });
    fs.writeFileSync(o.save, String(r.value).trim(), { mode: 0o600 });
    return 'saved';
  }
  if (cmd === 'push') {
    const file = path.join(data, 'browser', `${id}.import.json`);
    const m = /^([^:]+):(.+)$/.exec(String(o.to || ''));
    if (!m) throw new Error('--to USER@HOST:DATADIR is required');
    if (!fs.existsSync(file)) throw new Error(`no saved logins for ${id}; run login first`);
    const ssh = ['-o', 'BatchMode=yes', ...(o.key ? ['-i', o.key] : []), m[1]];
    // The file goes through ssh's stdin; it is never in a command line or the output.
    await sh('ssh', [...ssh, `umask 077 && mkdir -p '${m[2]}/browser' && cat > '${m[2]}/browser/${id}.import.json'`], fs.readFileSync(file));
    fs.rmSync(file, { force: true });
    return 'sent';
  }
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then((out) => console.log(out), (e) => { console.error(`ERROR: ${String(e.message).split('\n')[0]}`); process.exit(1); });
