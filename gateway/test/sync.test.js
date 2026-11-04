import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { makeSync } from '../src/sync.js';

let tmp;
let n = 0;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = 1_000_000; // the injected clock starts well after 0

// Temp base/app dirs plus a scripted fake exec(cmd, args, opts) → Promise<{ stdout }>.
// `world` is what the fake git "knows"; tests change it. Every call is recorded in `calls`.
function setup({ repo = true, version, config, world = {} } = {}) {
  const root = path.join(tmp, `s${++n}`);
  const base = path.join(root, 'base');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'gateway'), { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  if (repo) {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(base, 'repo', 'config.json'), config ?? JSON.stringify({ language: 'en', ...(version ? { version } : {}) }));
  }
  const w = {
    blob: 'blob-1', // what HEAD:config.json resolves to now
    blobAfterPull: undefined, // set by the pull (undefined: unchanged)
    head: 'c0'.padEnd(40, '0'), // HEAD of the app checkout
    tags: {}, // local `<name>^{commit}` → sha
    origin: {}, // `origin/<name>^{commit}` → sha
    pullError: null,
    npmError: null,
    delay: 0,
    ...world,
  };
  const calls = [];
  const logs = [];
  const clock = { t: T0 };
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (w.delay) await new Promise((r) => setTimeout(r, w.delay));
    if (cmd === 'npm') { if (w.npmError) throw new Error(w.npmError); return { stdout: '' }; }
    assert.equal(cmd, 'git');
    assert.equal(args[0], '-C');
    const [, dir, sub, ...rest] = args;
    const out = (s) => ({ stdout: `${s}\n` });
    if (sub === 'pull') {
      if (w.pullError) throw new Error(w.pullError);
      if (w.blobAfterPull !== undefined) w.blob = w.blobAfterPull;
      return out('');
    }
    if (sub === 'fetch') return out('');
    if (sub === 'checkout') { w.head = rest[rest.length - 1]; return out(''); }
    if (sub === 'rev-parse') {
      const ref = rest[0];
      if (ref === 'HEAD:config.json') {
        if (w.blob == null) throw new Error('fatal: path config.json does not exist');
        return out(w.blob);
      }
      if (ref === 'HEAD') { assert.equal(dir, app); return out(w.head); }
      const local = /^(.+)\^\{commit\}$/.exec(ref)?.[1];
      if (local?.startsWith('origin/') && w.origin[local.slice(7)]) return out(w.origin[local.slice(7)]);
      if (local && w.tags[local]) return out(w.tags[local]);
      throw new Error(`fatal: bad revision '${ref}'`);
    }
    throw new Error(`unexpected git ${sub}`);
  };
  const sync = makeSync({ base, app, minGapMs: MIN, now: () => clock.t, exec, log: (l) => logs.push(l) });
  const sub = (name) => calls.filter((c) => c.cmd === 'git' && c.args[2] === name);
  const writeConfig = (obj) => fs.writeFileSync(path.join(base, 'repo', 'config.json'), JSON.stringify(obj));
  return { base, app, w, calls, logs, clock, sync, sub, writeConfig, repoDir: path.join(base, 'repo') };
}

const sha = (c) => c.repeat(40);

describe('sync: no repo', () => {
  test('no <base>/repo at all: "none" and nothing is run', async () => {
    const s = setup({ repo: false });
    assert.equal(await s.sync(), 'none');
    assert.equal(await s.sync({ force: true }), 'none');
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.logs, []);
  });

  test('a repo directory without .git is not touched', async () => {
    const s = setup({ repo: false });
    fs.mkdirSync(path.join(s.base, 'repo'), { recursive: true });
    assert.equal(await s.sync({ force: true }), 'none');
    assert.deepEqual(s.calls, []);
  });
});

describe('sync: how often it pulls', () => {
  test('the first call pulls with --rebase --autostash in <base>/repo', async () => {
    const s = setup();
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('pull').length, 1);
    assert.deepEqual(s.sub('pull')[0].args, ['-C', s.repoDir, 'pull', '-q', '--rebase', '--autostash']);
    // the blob is read before and after the pull
    assert.deepEqual(s.calls.map((c) => c.args[2]), ['rev-parse', 'pull', 'rev-parse']);
    assert.deepEqual(s.calls[0].args, ['-C', s.repoDir, 'rev-parse', 'HEAD:config.json']);
  });

  test('a second call within minGapMs does not pull; after the gap it does', async () => {
    const s = setup();
    await s.sync();
    s.clock.t += MIN - 1;
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('pull').length, 1);
    s.clock.t += 1; // exactly minGapMs since the first pull
    await s.sync();
    assert.equal(s.sub('pull').length, 2);
  });

  test('a skipped call runs no command at all', async () => {
    const s = setup();
    await s.sync();
    const before = s.calls.length;
    s.clock.t += 1000;
    await s.sync();
    assert.equal(s.calls.length, before);
  });

  test('{ force: true } pulls inside the gap', async () => {
    const s = setup();
    await s.sync();
    s.clock.t += 10;
    await s.sync({ force: true });
    assert.equal(s.sub('pull').length, 2);
  });

  test('a forced call restarts the gap for the next normal call', async () => {
    const s = setup();
    await s.sync();
    s.clock.t += MIN - 5;
    await s.sync({ force: true });
    s.clock.t += MIN - 5; // far past the first pull, but not past the forced one
    await s.sync();
    assert.equal(s.sub('pull').length, 2);
  });

  test('two concurrent calls share one run: one pull, the same answer', async () => {
    const s = setup({ world: { delay: 10, blobAfterPull: 'blob-2' } });
    const [a, b] = await Promise.all([s.sync(), s.sync({ force: true })]);
    assert.equal(a, 'restart');
    assert.equal(b, 'restart');
    assert.equal(s.sub('pull').length, 1);
  });

  test('the shared run is released when it ends: a later forced call pulls again', async () => {
    const s = setup({ world: { delay: 1 } });
    await Promise.all([s.sync(), s.sync()]);
    await s.sync({ force: true });
    assert.equal(s.sub('pull').length, 2);
  });

  test('the same promise is returned to concurrent callers', async () => {
    const s = setup({ world: { delay: 5 } });
    const p1 = s.sync();
    const p2 = s.sync();
    assert.equal(p1, p2);
    await p1;
  });
});

describe('sync: config.json changes', () => {
  test('blob unchanged by the pull: "none", no log', async () => {
    const s = setup({ world: { blob: 'same' } });
    assert.equal(await s.sync(), 'none');
    assert.deepEqual(s.logs, []);
  });

  test('blob changed by the pull: "restart" and logged', async () => {
    const s = setup({ world: { blob: 'old', blobAfterPull: 'new' } });
    assert.equal(await s.sync(), 'restart');
    assert.deepEqual(s.logs, ['sync: config or code changed']);
    assert.equal(s.sub('checkout').length, 0, 'no version pinned: the code is not touched');
    assert.ok(!s.calls.some((c) => c.cmd === 'npm'));
  });

  test('config.json first appears with the pull (no blob before): "restart"', async () => {
    const s = setup({ world: { blob: null, blobAfterPull: 'new' } });
    assert.equal(await s.sync(), 'restart');
  });

  test('config.json missing before and after: "none"', async () => {
    const s = setup({ world: { blob: null } });
    assert.equal(await s.sync(), 'none');
  });

  test('a config without a version never touches the app checkout', async () => {
    const s = setup({ world: { blob: 'x', blobAfterPull: 'y' } });
    await s.sync();
    assert.ok(s.calls.every((c) => c.cmd === 'git' && c.args[1] === s.repoDir), 'only the repo is addressed');
  });

  test('after a change the next pull (past the gap) with no further change gives "none"', async () => {
    const s = setup({ world: { blob: 'old', blobAfterPull: 'new' } });
    assert.equal(await s.sync(), 'restart');
    s.w.blobAfterPull = undefined;
    s.clock.t += MIN;
    assert.equal(await s.sync(), 'none');
  });
});

describe('sync: pinned code version', () => {
  test('version resolves to the commit of HEAD: no checkout, no npm, "none"', async () => {
    const s = setup({ version: 'v1.2.0' });
    s.w.tags['v1.2.0'] = s.w.head;
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('checkout').length, 0);
    assert.ok(!s.calls.some((c) => c.cmd === 'npm'));
    assert.deepEqual(s.logs, []);
  });

  test('a different commit: fetch --tags, checkout the RESOLVED commit, npm ci in app/gateway, "restart"', async () => {
    const s = setup({ version: 'v1.2.0' });
    s.w.tags['v1.2.0'] = sha('a');
    assert.equal(await s.sync(), 'restart');
    const app = s.app;
    const appCalls = s.calls.filter((c) => c.args[1] === app || c.cmd === 'npm').map((c) => [c.cmd, ...c.args.slice(c.cmd === 'git' ? 2 : 0)].join(' '));
    assert.deepEqual(appCalls, [
      'git fetch -q --tags origin',
      'git rev-parse v1.2.0^{commit}',
      'git rev-parse HEAD',
      `git checkout -q ${sha('a')}`,
      'npm ci --omit=dev --no-audit --no-fund',
    ]);
    const checkout = s.sub('checkout')[0];
    assert.deepEqual(checkout.args, ['-C', app, 'checkout', '-q', sha('a')]);
    assert.ok(!checkout.args.includes('v1.2.0'), 'the raw name never reaches checkout');
    const npm = s.calls.find((c) => c.cmd === 'npm');
    assert.equal(npm.opts.cwd, path.join(app, 'gateway'));
    assert.deepEqual(s.logs, ['sync: code → v1.2.0', 'sync: config or code changed']);
  });

  test('npm ci runs after the checkout', async () => {
    const s = setup({ version: 'v2' });
    s.w.tags.v2 = sha('b');
    await s.sync();
    const order = s.calls.map((c) => (c.cmd === 'npm' ? 'npm' : c.args[2]));
    assert.ok(order.indexOf('checkout') < order.indexOf('npm'));
    assert.ok(order.indexOf('fetch') < order.indexOf('checkout'));
  });

  test('after the checkout HEAD matches: the next forced pull does nothing more', async () => {
    const s = setup({ version: 'v1.2.0' });
    s.w.tags['v1.2.0'] = sha('a');
    assert.equal(await s.sync(), 'restart');
    assert.equal(await s.sync({ force: true }), 'none');
    assert.equal(s.sub('checkout').length, 1);
    assert.equal(s.calls.filter((c) => c.cmd === 'npm').length, 1);
  });

  test('the tag is missing locally but origin/<v> exists: that commit is used', async () => {
    const s = setup({ version: 'release-3' });
    s.w.origin['release-3'] = sha('c');
    assert.equal(await s.sync(), 'restart');
    const asked = s.sub('rev-parse').map((c) => c.args[3]);
    assert.ok(asked.includes('release-3^{commit}'));
    assert.ok(asked.includes('origin/release-3^{commit}'));
    assert.deepEqual(s.sub('checkout')[0].args, ['-C', s.app, 'checkout', '-q', sha('c')]);
  });

  test('a local tag wins: origin/<v> is not asked', async () => {
    const s = setup({ version: 'v5' });
    s.w.tags.v5 = sha('d');
    s.w.origin.v5 = sha('e');
    await s.sync();
    assert.deepEqual(s.sub('checkout')[0].args.at(-1), sha('d'));
    assert.ok(!s.sub('rev-parse').some((c) => c.args[3].startsWith('origin/')));
  });

  test('a branch-like version with a slash and dots is accepted', async () => {
    const s = setup({ version: 'rel/1.2.x' });
    s.w.tags['rel/1.2.x'] = sha('f');
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.sub('checkout').length, 1);
  });

  test('neither the tag nor origin/<v> exists: "none", logged, no checkout, no npm', async () => {
    const s = setup({ version: 'v404' });
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('checkout').length, 0);
    assert.ok(!s.calls.some((c) => c.cmd === 'npm'));
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /^sync: /);
    assert.match(s.logs[0], /v404/);
  });

  test('config blob changed AND a new version: one "restart", one checkout', async () => {
    const s = setup({ version: 'v9', world: { blob: 'a', blobAfterPull: 'b' } });
    s.w.tags.v9 = sha('1');
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.sub('checkout').length, 1);
  });

  test('a failing npm ci gives "none" and is logged (the error is not thrown to the caller)', async () => {
    const s = setup({ version: 'v1' });
    s.w.tags.v1 = sha('a');
    s.w.npmError = 'npm ERR! network';
    assert.equal(await s.sync(), 'none');
    assert.match(s.logs.join('\n'), /sync: npm ERR! network/);
  });
});

describe('sync: bad versions and errors', () => {
  for (const bad of ['--upload-pack=x', '-x', '.hidden', '../up', 'a b', 'v1;rm', 'v1\nx', '$(x)']) {
    test(`version ${JSON.stringify(bad)}: "none", logged, nothing is run against the app`, async () => {
      const s = setup({ config: JSON.stringify({ version: bad }) });
      s.w.tags[bad] = sha('a');
      s.w.origin[bad] = sha('a');
      assert.equal(await s.sync(), 'none');
      assert.equal(s.logs.length, 1);
      assert.match(s.logs[0], /^sync: config\.json version is not a tag/);
      assert.equal(s.sub('checkout').length, 0);
      assert.equal(s.sub('fetch').length, 0);
      assert.ok(!s.calls.some((c) => c.cmd === 'npm'));
      assert.ok(!s.calls.some((c) => c.args.includes(bad)), 'the value never reaches a command');
    });
  }

  test('the log keeps only the first line of a multi-line error', async () => {
    const s = setup({ world: { pullError: 'first line\nsecond line' } });
    await s.sync();
    assert.deepEqual(s.logs, ['sync: first line']);
  });

  test('a failing pull gives "none" and is logged; no checkout, no npm', async () => {
    const s = setup({ version: 'v1', world: { pullError: 'could not resolve host' } });
    s.w.tags.v1 = sha('a');
    assert.equal(await s.sync(), 'none');
    assert.deepEqual(s.logs, ['sync: could not resolve host']);
    assert.equal(s.sub('checkout').length, 0);
    assert.ok(!s.calls.some((c) => c.cmd === 'npm'));
  });

  test('a failed pull does not break later calls: after the gap it pulls again and can restart', async () => {
    const s = setup({ world: { pullError: 'offline', blob: 'old', blobAfterPull: 'new' } });
    assert.equal(await s.sync(), 'none');
    s.w.pullError = null;
    assert.equal(await s.sync({ force: true }), 'restart');
    assert.equal(s.sub('pull').length, 2);
  });

  test('an unparsable config.json gives "none" and is logged (a SyntaxError is caught)', async () => {
    const s = setup({ config: '{broken' });
    assert.equal(await s.sync(), 'none');
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /^sync: /);
  });

  test('a rejected call still clears the shared run (the next call works)', async () => {
    const s = setup({ world: { pullError: 'x' } });
    await s.sync();
    s.w.pullError = null;
    s.clock.t += MIN;
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('pull').length, 2);
  });

  test('two concurrent calls that fail: one pull, one log line, both get "none"', async () => {
    const s = setup({ world: { pullError: 'conflict', delay: 5 } });
    const r = await Promise.all([s.sync(), s.sync()]);
    assert.deepEqual(r, ['none', 'none']);
    assert.equal(s.sub('pull').length, 1);
    assert.deepEqual(s.logs, ['sync: conflict']);
  });
});

describe('sync: defaults', () => {
  let s;
  beforeEach(() => { s = setup({ repo: false }); });

  test('makeSync with no exec/log/now still works for a missing repo (no real command is run)', async () => {
    const sync = makeSync({ base: s.base, app: s.app });
    assert.equal(await sync(), 'none');
  });
});
