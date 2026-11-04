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
export function makeSync({ base, app, minGapMs = 60_000, now = Date.now, exec = run, log = console.log }) {
  const repo = path.join(base, 'repo');
  let last = -Infinity; // a failed pull also counts: offline, it is tried again after minGapMs
  let busy = null;
  const git = async (cwd, ...a) => (await exec('git', ['-C', cwd, ...a], { timeout: 60_000 })).stdout.trim();
  const blob = () => git(repo, 'rev-parse', 'HEAD:config.json').catch(() => '');

  async function once({ force = false } = {}) {
    if (!fs.existsSync(path.join(repo, '.git'))) return 'none';
    if (!force && now() - last < minGapMs) return 'none';
    last = now();
    const before = await blob();
    await git(repo, 'pull', '-q', '--rebase', '--autostash');
    let changed = (await blob()) !== before;
    const cfg = path.join(repo, 'config.json');
    const want = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')).version : null;
    if (want) {
      // A tag or branch name only: a value like "--upload-pack=…" must never reach git as an option.
      if (!/^\w[\w./-]*$/.test(want)) throw new Error(`config.json version is not a tag: ${want}`);
      await git(app, 'fetch', '-q', '--tags', 'origin');
      const target = await git(app, 'rev-parse', `${want}^{commit}`).catch(() => git(app, 'rev-parse', `origin/${want}^{commit}`));
      if (target !== await git(app, 'rev-parse', 'HEAD')) {
        await git(app, 'checkout', '-q', target);
        await exec('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: path.join(app, 'gateway'), timeout: 10 * 60_000 });
        log(`sync: code → ${want}`);
        changed = true;
      }
    }
    if (changed) log('sync: config or code changed');
    return changed ? 'restart' : 'none';
  }

  // One pull at a time; a failure (offline, a conflict) is logged and the turn goes on as before.
  return (opts) => {
    busy ??= once(opts).catch((e) => { log(`sync: ${String(e.message).split('\n')[0]}`); return 'none'; }).finally(() => { busy = null; });
    return busy;
  };
}
