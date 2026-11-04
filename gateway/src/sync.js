import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Keeps this machine in step with the user's private repo (config.json, brain/, the pinned
// version), pulling only when it matters: before a turn (at most once a minute) and once a day.
// Nothing reaches in from outside: no timer, no inbound ssh, no key in GitHub.
// Returns 'restart' when config.json or the code version changed (the caller restarts the
// gateway), else 'none'. Reminders and everything set in the chat do not depend on this.
// ownUser: the gateway runs as its own user and its code is root's (bin/own-user.js). It cannot
// check out a new version itself: it writes data/update-request.json and root's
// assistant-update.path does the update and the restart.
export function makeSync({ base, app, minGapMs = 60_000, now = Date.now, exec = run, log = console.log, ownUser = false }) {
  const repo = path.join(base, 'repo');
  let last = -Infinity; // a failed pull also counts: offline, it is tried again after minGapMs
  let busy = null;
  const git = async (cwd, ...a) => (await exec('git', ['-C', cwd, ...a], { timeout: 60_000 })).stdout.trim();
  // config.json and the owner's private modules (modules/): a change in either restarts.
  const blob = async () => [await git(repo, 'rev-parse', 'HEAD:config.json').catch(() => ''), await git(repo, 'rev-parse', 'HEAD:modules').catch(() => '')].join(' ');

  async function once({ force = false } = {}) {
    if (!fs.existsSync(path.join(repo, '.git'))) return 'none';
    if (!force && now() - last < minGapMs) return 'none';
    last = now();
    const before = await blob();
    await git(repo, 'pull', '-q', '--rebase', '--autostash');
    let changed = (await blob()) !== before;
    const cfg = path.join(repo, 'config.json');
    const want = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')).version : null;
    // A failed version step never hides a config change: that one still restarts.
    if (want) changed = (await version(want).catch((e) => { log(`sync: version: ${String(e.message).split('\n')[0]}`); return false; })) || changed;
    if (changed) log('sync: config or code changed');
    return changed ? 'restart' : 'none';
  }

  // Own user: the code is root's. The assistant only reads it (no fetch: it may not write there),
  // and asks root for the release; root fetches, checks and installs it (bin/own-user.js).
  // safe.directory on the command line: git refuses a repo owned by another user otherwise.
  async function askRoot(want) {
    const appGit = async (...a) => (await exec('git', ['-c', `safe.directory=${app}`, '-C', app, ...a], { timeout: 60_000 })).stdout.trim();
    if (!/^v\d+\.\d+\.\d+$/.test(want)) { log(`sync: ${want} is not a release tag (vX.Y.Z); as its own user the assistant updates only to a newer release`); return false; }
    const target = await appGit('rev-parse', `refs/tags/${want}^{commit}`).catch(() => null);
    if (target && target === await appGit('rev-parse', 'HEAD')) return false;
    const req = path.join(base, 'data', 'update-request.json');
    const asked = fs.existsSync(req) && JSON.parse(fs.readFileSync(req, 'utf8')).version === want;
    if (!asked) {
      fs.mkdirSync(path.dirname(req), { recursive: true });
      fs.writeFileSync(req, JSON.stringify({ version: want, at: now() }));
      log(`sync: asked root for ${want}`);
    }
    return false;
  }

  // → true when the code changed here (a restart is needed).
  async function version(want) {
    // A tag or branch name only: a value like "--upload-pack=…" must never reach git as an option.
    if (!/^\w[\w./-]*$/.test(want)) throw new Error(`config.json version is not a tag: ${want}`);
    if (ownUser) return askRoot(want);
    await git(app, 'fetch', '-q', '--tags', 'origin');
    const target = await git(app, 'rev-parse', `${want}^{commit}`).catch(() => git(app, 'rev-parse', `origin/${want}^{commit}`));
    if (target === await git(app, 'rev-parse', 'HEAD')) return false;
    await git(app, 'checkout', '-q', target);
    await exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(app, 'gateway'), timeout: 10 * 60_000 });
    log(`sync: code → ${want}`);
    return true;
  }

  // One pull at a time; a failure (offline, a conflict) is logged and the turn goes on as before.
  return (opts) => {
    busy ??= once(opts).catch((e) => { log(`sync: ${String(e.message).split('\n')[0]}`); return 'none'; }).finally(() => { busy = null; });
    return busy;
  };
}
