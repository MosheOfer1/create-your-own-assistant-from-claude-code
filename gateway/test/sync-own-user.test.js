import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
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
    const [, , sub, ...rest] = args;
    if (sub === 'pull') { if (w.blobAfterPull !== undefined) w.blob = w.blobAfterPull; return out(''); }
    if (sub === 'fetch') return out('');
    if (sub === 'checkout') { w.head = rest[rest.length - 1]; return out(''); }
    if (sub === 'rev-parse') {
      const ref = rest[0];
      if (ref === 'HEAD:config.json') return out(w.blob);
      if (ref === 'HEAD') return out(w.head);
      const name = /^(.+)\^\{commit\}$/.exec(ref)?.[1];
      if (name?.startsWith('origin/') && w.origin[name.slice(7)]) return out(w.origin[name.slice(7)]);
      if (name && w.tags[name]) return out(w.tags[name]);
      throw new Error(`fatal: bad revision '${ref}'`);
    }
    throw new Error(`unexpected git ${sub}`);
  };
  const sync = makeSync({ base, app, minGapMs: MIN, now: () => clock.t, exec, log: (l) => logs.push(l), ownUser });
  const req = path.join(base, 'data', 'update-request.json');
  const readReq = () => JSON.parse(fs.readFileSync(req, 'utf8'));
  const sub = (name) => calls.filter((c) => c.cmd === 'git' && c.args[2] === name);
  const setVersion = (v) => { w.version = v; writeConfig(); };
  return { base, app, w, calls, logs, clock, sync, sub, req, readReq, setVersion };
}

describe('sync with ownUser: a new version is asked of root', () => {
  test('a version that differs from HEAD: no checkout, no npm, a request file, a log line, "none"', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') } });
    assert.equal(await s.sync(), 'none');
    assert.equal(s.sub('checkout').length, 0);
    assert.equal(s.calls.filter((c) => c.cmd === 'npm').length, 0);
    assert.equal(s.sub('fetch').length, 1); // it still looks: the tag has to be fetched to be compared
    assert.equal(s.readReq().version, 'v2');
    assert.ok(s.logs.includes('sync: asked root for v2'), s.logs.join('|'));
    assert.ok(!s.logs.some((l) => /code →/.test(l)));
    assert.equal(s.w.head, sha('0')); // HEAD did not move
  });

  test('the request is { version, at } with the clock\'s time, at <base>/data/update-request.json', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') } });
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v2', at: T0 });
    assert.equal(s.req, path.join(s.base, 'data', 'update-request.json'));
  });

  test('a second call with the same version does not rewrite the file', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') } });
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
    const s = setup({ version: 'v2', tags: { v2: sha('2'), v3: sha('3') } });
    await s.sync();
    s.setVersion('v3');
    s.w.blobAfterPull = 'blob-2';
    s.clock.t += MIN;
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v3', at: T0 + MIN });
    assert.deepEqual(s.logs.filter((l) => l.includes('asked root')), ['sync: asked root for v2', 'sync: asked root for v3']);
  });

  test('a different version without a config change in between is also asked for', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2'), v3: sha('3') } });
    await s.sync();
    s.setVersion('v3'); // the blob the fake git reports stays the same
    s.clock.t += MIN;
    await s.sync();
    assert.equal(s.readReq().version, 'v3');
  });

  test('the same commit as HEAD: no request file, no log', async () => {
    const s = setup({ version: 'v1', tags: { v1: sha('0') } });
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.existsSync(s.req), false);
    assert.ok(!s.logs.some((l) => l.includes('asked root')));
  });

  test('another tag name on the same commit as HEAD: no request file', async () => {
    const s = setup({ version: 'v1-alias', tags: { 'v1-alias': sha('0') } });
    await s.sync();
    assert.equal(fs.existsSync(s.req), false);
  });

  test('a version that exists only as origin/<name> is asked for by that name', async () => {
    const s = setup({ version: 'stable', origin: { stable: sha('5') } });
    await s.sync();
    assert.equal(s.readReq().version, 'stable');
    assert.equal(s.sub('checkout').length, 0);
  });

  test('a config.json change next to the new version: "restart" (the request is still written)', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') } });
    s.w.blobAfterPull = 'blob-2';
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.readReq().version, 'v2');
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

  test('an unresolvable version: logged, no request file', async () => {
    const s = setup({ version: 'v9' });
    assert.equal(await s.sync(), 'none');
    assert.equal(fs.existsSync(s.req), false);
    assert.ok(s.logs.some((l) => l.startsWith('sync: ')));
  });

  test('a stale request for an older version is replaced, not kept', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') } });
    fs.writeFileSync(s.req, JSON.stringify({ version: 'v1', at: 1 }));
    await s.sync();
    assert.deepEqual(s.readReq(), { version: 'v2', at: T0 });
  });
});

describe('sync without ownUser (the contrast)', () => {
  test('the same difference checks out the commit, runs npm ci and writes no request', async () => {
    const s = setup({ version: 'v2', tags: { v2: sha('2') }, ownUser: false });
    assert.equal(await s.sync(), 'restart');
    assert.equal(s.sub('checkout').length, 1);
    assert.equal(s.w.head, sha('2'));
    assert.equal(s.calls.filter((c) => c.cmd === 'npm').length, 1);
    assert.equal(fs.existsSync(s.req), false);
  });
});
