import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { applyUpdate } from '../bin/own-user.js';
import { makeSync } from '../src/sync.js';

// sync with ownUser: true. The gateway cannot check out code (it is root's): it asks root with
// <base>/data/update-request.json and root's assistant-update.path does the rest.

let tmp;
let n = 0;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-own-user-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60_000;
const T0 = 1_000_000;
const sha = (c) => c.repeat(40);

function setup({ version, tags = {}, origin = {}, head = sha('0'), ownUser = true } = {}) {
  const root = path.join(tmp, `o${++n}`);
  const base = path.join(root, 'base');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'gateway'), { recursive: true });
  fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  const w = { blob: 'blob-1', blobAfterPull: undefined, head, tags: { ...tags }, origin: { ...origin }, version };
  const writeConfig = () => fs.writeFileSync(path.join(base, 'repo', 'config.json'), JSON.stringify({ language: 'en', ...(w.version ? { version: w.version } : {}) }));
  writeConfig();
  const calls = [];
  const logs = [];
  const clock = { t: T0 };
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const out = (s) => ({ stdout: `${s}\n` });
    if (cmd === 'npm') return out('');
    assert.equal(cmd, 'git');
    // As its own user, git runs with -c safe.directory=... first (the code is root's).
    const a = args[0] === '-c' ? args.slice(2) : args;
    const [, , sub, ...rest] = a;
    if (sub === 'pull') { if (w.blobAfterPull !== undefined) w.blob = w.blobAfterPull; return out(''); }
    if (sub === 'fetch') return out('');
    if (sub === 'checkout') { w.head = rest[rest.length - 1]; return out(''); }
    if (sub === 'rev-parse') {
      const ref = rest[0];
      if (ref === 'HEAD:config.json') return out(w.blob);
      if (ref === 'HEAD') return out(w.head);
      const name = /^(?:refs\/tags\/)?(.+)\^\{commit\}$/.exec(ref)?.[1];
      if (name?.startsWith('origin/') && w.origin[name.slice(7)]) return out(w.origin[name.slice(7)]);
      if (name && w.tags[name]) return out(w.tags[name]);
      throw new Error(`fatal: bad revision '${ref}'`);
    }
    throw new Error(`unexpected git ${sub}`);
  };
  const sync = makeSync({ base, app, minGapMs: MIN, now: () => clock.t, exec, log: (l) => logs.push(l), ownUser });
  const req = path.join(base, 'data', 'update-request.json');
  const readReq = () => JSON.parse(fs.readFileSync(req, 'utf8'));
  const sub = (name) => calls.filter((c) => c.cmd === 'git' && (c.args[0] === '-c' ? c.args[4] : c.args[2]) === name);
  const setVersion = (v) => { w.version = v; writeConfig(); };
  return { base, app, w, calls, logs, clock, sync, sub, req, readReq, setVersion };
}

describe('sync with ownUser: a new version is asked of root', () => {
  test('a version that differs from HEAD: no checkout, no npm, a request file, a log line, "none"', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('checkout').length, 0);
    assert.equal(s.calls.filter((c) => c.cmd === 'npm').length, 0);
    assert.equal(s.sub('fetch').length, 0); // no fetch: the code is root's, and root fetches
    assert.equal(s.readReq().version, 'v2.0.0');
    assert.ok(s.logs.includes('sync: asked root for v2.0.0'), s.logs.join('|'));
    assert.ok(!s.logs.some((l) => /code →/.test(l)));
    assert.equal(s.w.head, sha('0')); // HEAD did not move
  });

  test('the request is { version, at } with the clock\'s time, at <base>/data/update-request.json', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v2.0.0', at: T0 });
    assert.equal(s.req, path.join(s.base, 'data', 'update-request.json'));
  });

  test('a second call with the same version does not rewrite the file', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    await s.sync();
    const old = new Date(2020, 0, 1);
    fs.utimesSync(s.req, old, old); // so a rewrite would show in mtime
    const text = fs.readFileSync(s.req, 'utf8');
    s.clock.t += MIN;
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.readFileSync(s.req, 'utf8'), text); // "at" unchanged
    assert.equal(s.readReq().at, T0);
    assert.equal(fs.statSync(s.req).mtimeMs, old.getTime());
    assert.equal(s.logs.filter((l) => l.includes('asked root')).length, 1);
  });

  test('a different version rewrites the file', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2'), 'v3.0.0': sha('3') } });
    await s.sync();
    s.setVersion('v3.0.0');
    s.w.blobAfterPull = 'blob-2';
    s.clock.t += MIN;
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v3.0.0', at: T0 + MIN });
    assert.deepEqual(s.logs.filter((l) => l.includes('asked root')), ['sync: asked root for v2.0.0', 'sync: asked root for v3.0.0']);
  });

  test('a different version without a config change in between is also asked for', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2'), 'v3.0.0': sha('3') } });
    await s.sync();
    s.setVersion('v3.0.0'); // the blob the fake git reports stays the same
    s.clock.t += MIN;
    await s.sync();
    assert.equal(s.readReq().version, 'v3.0.0');
  });

  test('the same commit as HEAD: no request file, no log', async () => {
    const s = setup({ version: 'v1.0.0', tags: { 'v1.0.0': sha('0') } });
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.existsSync(s.req), false);
    assert.ok(!s.logs.some((l) => l.includes('asked root')));
  });

  test('another tag name on the same commit as HEAD: no request file', async () => {
    const s = setup({ version: 'v1-alias', tags: { 'v1-alias': sha('0') } });
    await s.sync();
    assert.equal(fs.existsSync(s.req), false);
  });

  test('a branch (not a release tag) is not asked for: root would refuse it', async () => {
    const s = setup({ version: 'stable', origin: { stable: sha('5') } });
    await s.sync();
    assert.equal(fs.existsSync(s.req), false);
    assert.equal(s.sub('checkout').length, 0);
    assert.ok(s.logs.some((l) => /stable is not a release tag/.test(l)), s.logs.join('|'));
  });

  test('a config.json change next to the new version: "restart" (the request is still written)', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    s.w.blobAfterPull = 'blob-2';
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.readReq().version, 'v2.0.0');
    assert.equal(s.sub('checkout').length, 0);
    assert.ok(s.logs.includes('sync: config or code changed'));
  });

  test('no version in config.json: nothing is asked, nothing is fetched', async () => {
    const s = setup({});
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.existsSync(s.req), false);
    assert.equal(s.sub('fetch').length, 0);
  });

  test('a version that is not a tag name is refused and never written to the request', async () => {
    const s = setup({ version: '--upload-pack=x' });
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.existsSync(s.req), false);
    assert.equal(s.sub('fetch').length, 0);
    assert.ok(s.logs.some((l) => /not a tag/.test(l)), s.logs.join('|'));
  });

  test('a release not here yet: asked of root all the same (root fetches it, the assistant cannot)', async () => {
    const s = setup({ version: 'v9.0.0' });
    assert.equal(await s.sync(), 'none');
    assert.equal(s.readReq().version, 'v9.0.0');
    assert.equal(s.sub('fetch').length, 0);
  });

  test('a failing version step never hides a config change', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    s.w.blobAfterPull = 'blob-2';
    fs.rmSync(path.join(s.base, 'data'), { recursive: true, force: true });
    fs.writeFileSync(path.join(s.base, 'data'), 'not a folder'); // the request cannot be written
    assert.equal(await s.sync(), 'restart');
    assert.ok(s.logs.some((l) => l.startsWith('sync: version: ')), s.logs.join('|'));
  });

  test('a stale request for an older version is replaced, not kept', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') } });
    fs.writeFileSync(s.req, JSON.stringify({ version: 'v1.0.0', at: 1 }));
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v2.0.0', at: T0 });
  });
});

describe('sync without ownUser (the contrast)', () => {
  test('the same difference checks out the commit, runs npm ci and writes no request', async () => {
    const s = setup({ version: 'v2.0.0', tags: { 'v2.0.0': sha('2') }, ownUser: false });
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.sub('checkout').length, 1);
    assert.equal(s.w.head, sha('2'));
    assert.equal(s.calls.filter((c) => c.cmd === 'npm').length, 1);
    assert.equal(fs.existsSync(s.req), false);
  });
});

// The two halves together: what sync.js writes is what own-user.js applyUpdate reads (as root).
// Root takes only a release tag newer than the installed one, so a branch or an older tag that
// sync passes on is refused there.
describe('sync request → root applyUpdate', () => {
  const rootRun = (installedTags) => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[2] === 'tag') return installedTags;
      if (cmd === 'git' && args[2] === 'rev-parse') return sha('9');
      return '';
    };
    return { calls, run };
  };

  test('a newer release tag: root checks it out (scripts off) and removes the request', async () => {
    const s = setup({ version: 'v1.3.0', tags: { 'v1.3.0': sha('3') } });
    await s.sync();
    const r = rootRun('v1.2.0');
    assert.equal(applyUpdate({ run: r.run, request: s.req, top: s.base }), 'updated to v1.3.0');
    assert.ok(r.calls.some((c) => c[0] === 'npm' && c.includes('--ignore-scripts')));
    assert.equal(fs.existsSync(s.req), false);
  });

  test('a branch in a request file is refused by root: nothing checked out', async () => {
    const s = setup({ version: 'stable', origin: { stable: sha('5') } });
    fs.mkdirSync(path.dirname(s.req), { recursive: true });
    fs.writeFileSync(s.req, JSON.stringify({ version: 'stable', at: 1 }));
    const r = rootRun('v1.2.0');
    assert.throws(() => applyUpdate({ run: r.run, request: s.req, top: s.base }), /not a release tag/);
    assert.deepEqual(r.calls, []);
  });

  test('an older release tag (a downgrade) is refused by root', async () => {
    const s = setup({ version: 'v1.1.0', tags: { 'v1.1.0': sha('1') } });
    await s.sync();
    assert.equal(s.readReq().version, 'v1.1.0');
    const r = rootRun('v1.0.0\nv1.2.0');
    assert.throws(() => applyUpdate({ run: r.run, request: s.req, top: s.base }), /not newer than the installed v1\.2\.0/);
    assert.ok(!r.calls.some((c) => c[0] === 'npm' || c.includes('checkout')));
  });
});
