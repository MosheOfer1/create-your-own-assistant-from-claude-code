#!/usr/bin/env node
// The mechanical half of the create-assistant skill. The skill explains each step to the user
// and decides; this tool does it and remembers it. Everything is safe to run again.
//   ~/.assistant/setup.json   which steps are done or skipped (the skill resumes from it)
//   ~/.assistant/setup.log    what was done, when (never secrets)
//   ~/.assistant/config.json  the gateway's settings
//   ~/.assistant/data/.env    secrets (0600), written only by `secret` from a local window
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = process.env.ASSISTANT_HOME || path.join(os.homedir(), '.assistant');
const STATE = path.join(BASE, 'setup.json');
const LOG = path.join(BASE, 'setup.log');
const REPO = path.join(BASE, 'repo'); // the user's private repo: config.json + brain/
const CONFIG = fs.existsSync(path.join(REPO, 'config.json')) ? path.join(REPO, 'config.json') : path.join(BASE, 'config.json');
const ENV = path.join(BASE, 'data', '.env');
const HERE = path.dirname(new URL(import.meta.url).pathname);

export const STEPS = ['language', 'plan', 'prereqs', 'host', 'code', 'repo', 'claude', 'whatsapp', 'telegram', 'email', 'voice', 'logins', 'service', 'deploy', 'test'];
const SECRETS = { EMAIL_APP_PASSWORD: 1, TELEGRAM_BOT_TOKEN: 1, TRANSCRIBE_API_KEY: 1, ANTHROPIC_API_KEY: 1 };

const USAGE = `Usage: setup.js COMMAND
  status                         steps: done / skipped / next
  mark STEP done|skipped [NOTE]  record a step (${STEPS.join(', ')})
  log TEXT                       add a line to the setup log
  get [KEY] | set KEY JSON       read / change config.json (dots for nesting: modules.email.user)
  repo create NAME | repo push   a private GitHub repo (gh) for config.json + brain/, cloned to ~/.assistant/repo
  secret NAME --url URL --say TEXT [--lang xx]
                                 the user types/pastes a secret in a local window; it goes to data/.env
                                 (NAME: ${Object.keys(SECRETS).join(', ')}). Prints: saved | closed | timeout
  has NAME                       is a secret set? (yes / no; never the value)
  whatsapp                       link the assistant's number: prints a pairing code, waits (10 min). Prints: linked | timeout
  check                          what this machine has: node, git, gh, claude, ffmpeg, chrome, whisper`;

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 }); };
const log = (line) => { fs.mkdirSync(BASE, { recursive: true, mode: 0o700 }); fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); };

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] = (o[p] && typeof o[p] === 'object' ? o[p] : {});
  if (value === null) delete o[parts.at(-1)]; else o[parts.at(-1)] = value;
  return obj;
}

// .env lines KEY=value; the value is quoted so any character is safe.
export function setEnv(file, name, value) {
  const lines = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter((l) => l && !l.startsWith(`${name}=`));
  lines.push(`${name}=${JSON.stringify(String(value))}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const git = (...steps) => { for (const s of steps) execFileSync('git', ['-C', REPO, ...s], { stdio: 'pipe' }); };
const version = (cmd, args = ['--version']) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).split('\n')[0].trim(); } catch { return null; } };

export async function main([cmd, ...rest]) {
  if (!cmd || cmd === '-h' || cmd === '--help') return USAGE;
  if (cmd === 'status') {
    const s = read(STATE, {});
    const next = STEPS.find((k) => !s[k]);
    return `${STEPS.map((k) => `${s[k] ? (s[k].status === 'done' ? '✔' : '–') : ' '} ${k}${s[k]?.note ? ` (${s[k].note})` : ''}`).join('\n')}\nnext: ${next || 'nothing, all steps are done'}`;
  }
  if (cmd === 'mark') {
    const [step, status, ...note] = rest;
    if (!STEPS.includes(step) || !['done', 'skipped', 'clear'].includes(status)) throw new Error(`mark STEP done|skipped|clear\n${USAGE}`);
    const s = read(STATE, {});
    if (status === 'clear') delete s[step]; else s[step] = { status, at: new Date().toISOString(), ...(note.length && { note: note.join(' ') }) };
    write(STATE, s);
    log(`step ${step}: ${status}${note.length ? ` (${note.join(' ')})` : ''}`);
    return `${step}: ${status}`;
  }
  if (cmd === 'log') { log(rest.join(' ')); return 'logged'; }
  if (cmd === 'get') {
    const c = read(CONFIG, {});
    const v = rest[0] ? rest[0].split('.').reduce((o, k) => o?.[k], c) : c;
    return JSON.stringify(v ?? null, null, 2);
  }
  if (cmd === 'set') {
    const [key, raw] = rest;
    if (!key || raw === undefined) throw new Error('set KEY JSON  (e.g. set language \'"he"\')');
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    if (Object.keys(SECRETS).some((s) => key.toUpperCase().includes(s))) throw new Error('secrets go through `secret`, never into config.json');
    write(CONFIG, setPath(read(CONFIG, {}), key, value));
    log(`config ${key} set`);
    if (CONFIG.startsWith(REPO)) git(['add', 'config.json'], ['commit', '-q', '-m', `setup: ${key}`]);
    return `${key} = ${JSON.stringify(value)}`;
  }
  if (cmd === 'repo') {
    // repo create NAME: a private GitHub repo for config + brain (gh must be logged in).
    // repo push: send local commits (each host pulls within ~5 minutes).
    if (rest[0] === 'push') { git(['push', '-q']); log('repo pushed'); return 'pushed'; }
    if (rest[0] !== 'create' || !/^[\w.-]+$/.test(rest[1] || '')) throw new Error('repo create NAME | repo push');
    if (fs.existsSync(path.join(REPO, '.git'))) return `already at ${REPO}`;
    const user = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
    try { execFileSync('gh', ['repo', 'create', `${user}/${rest[1]}`, '--private', '--description', 'My assistant: settings and second brain'], { stdio: 'pipe' }); } catch (e) { if (!/already exists/i.test(String(e.stderr))) throw e; }
    execFileSync('gh', ['repo', 'clone', `${user}/${rest[1]}`, REPO], { stdio: 'pipe' });
    const conf = read(path.join(BASE, 'config.json'), {});
    conf.modules = { ...conf.modules, brain: { ...(conf.modules?.brain || {}), dir: path.join(REPO, 'brain'), push: true } };
    write(path.join(REPO, 'config.json'), conf);
    fs.mkdirSync(path.join(REPO, 'brain', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'brain', 'README.md'), '# Second brain\n\nNotes and facts the assistant keeps. Open this folder in Obsidian if you like.\n');
    fs.writeFileSync(path.join(REPO, '.gitignore'), '.env\n*.env\ndata/\n.obsidian/workspace*.json\n');
    fs.writeFileSync(path.join(REPO, 'README.md'), '# My assistant\n\n`config.json`: settings (no secrets). `brain/`: the second brain.\nA push here reaches the assistant within about 5 minutes.\n');
    git(['add', '-A'], ['commit', '-q', '-m', 'setup: start'], ['push', '-q', '-u', 'origin', 'HEAD']);
    fs.rmSync(path.join(BASE, 'config.json'), { force: true }); // one config only: the repo's
    log(`repo ${user}/${rest[1]} created`);
    return `${user}/${rest[1]} (private) at ${REPO}`;
  }
  if (cmd === 'has') return fs.existsSync(ENV) && fs.readFileSync(ENV, 'utf8').split('\n').some((l) => l.startsWith(`${rest[0]}=`)) ? 'yes' : 'no';
  if (cmd === 'secret') {
    const name = rest[0];
    if (!SECRETS[name]) throw new Error(`unknown secret ${name}; one of ${Object.keys(SECRETS).join(', ')}`);
    const opt = (k) => (rest.includes(`--${k}`) ? rest[rest.indexOf(`--${k}`) + 1] : undefined);
    const tmp = path.join(BASE, 'data', `.${name}.tmp`);
    const { windowStep } = await import(pathToFileURL(path.join(HERE, 'chrome-step.js')).href);
    const r = await windowStep({ url: opt('url'), say: opt('say'), lang: opt('lang') || read(CONFIG, {}).language, field: opt('field') || true }, { field: true });
    if (r.how !== 'done') return r.how;
    if (!String(r.value || '').trim()) return 'empty';
    setEnv(ENV, name, String(r.value).trim());
    fs.rmSync(tmp, { force: true });
    log(`secret ${name} saved`);
    return 'saved';
  }
  if (cmd === 'whatsapp') {
    // Links the assistant's number: prints the pairing code, waits until it is linked (or 10 min).
    const c = read(CONFIG, {}).channels?.whatsapp || {};
    if (!c.assistantNumber || !c.ownerNumber) throw new Error('set channels.whatsapp.assistantNumber and ownerNumber first');
    const { WhatsAppChannel } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'channels', 'whatsapp.js')).href);
    const authDir = path.join(BASE, 'data', 'whatsapp-auth');
    if (fs.existsSync(path.join(authDir, 'creds.json')) && read(path.join(authDir, 'creds.json'), {}).registered) return 'already linked';
    const wa = new WhatsAppChannel({ ...c, authDir, log: () => {}, onPairingCode: (code) => console.log(`pairing code: ${code}`) });
    const r = await new Promise((resolve) => {
      wa.onStatus = (s) => { if (s === 'open' || s === 'logged-out') resolve(s); };
      setTimeout(() => resolve('timeout'), 10 * 60_000).unref();
      wa.start(() => {});
    });
    wa.stop();
    log(`whatsapp link: ${r}`);
    return r === 'open' ? 'linked' : r;
  }
  if (cmd === 'check') {
    const chrome = await import(pathToFileURL(path.join(HERE, '..', 'modules', 'browse', 'browser.js')).href).then((m) => m.chromePath()).catch(() => null);
    const rows = {
      os: `${os.platform()} ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`,
      node: version('node'), git: version('git'), gh: version('gh'), claude: version('claude'),
      ffmpeg: version('ffmpeg', ['-version']), whisper: version('whisper-cli', ['--help']) ? 'yes' : null, chrome,
    };
    const major = Number(String(rows.node || '').replace(/^v/, '').split('.')[0]);
    if (rows.node && major < 22) rows.node += '  (too old: needs 22+)';
    return Object.entries(rows).map(([k, v]) => `${k}: ${v || 'missing'}`).join('\n');
  }
  throw new Error(`unknown command ${cmd}\n${USAGE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((out) => console.log(out), (e) => { console.error(`ERROR: ${String(e.message).split('\n')[0]}`); process.exit(1); });
}
