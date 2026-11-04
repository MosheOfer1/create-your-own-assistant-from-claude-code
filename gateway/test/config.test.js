import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { loadConfig } from '../src/config.js';

let tmp;
let n = 0;
const KEYS = ['ASSISTANT_OWN_USER', 'ASSISTANT_CONFIG'];
let saved;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); for (const k of KEYS) delete process.env[k]; });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// Writes a temp config.json (with temp dataDir and agentCwd) and points ASSISTANT_CONFIG at it.
function cfg(extra = {}) {
  const dir = path.join(tmp, `c${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ dataDir: path.join(dir, 'data'), agentCwd: path.join(dir, 'home'), ownerName: 'Dana', ...extra }));
  process.env.ASSISTANT_CONFIG = file;
  return dir;
}

describe('loadConfig(): ownUser and freeShell', () => {
  test('ASSISTANT_OWN_USER=1 and no freeShell in the config: freeShell stays off, ownUser true', () => {
    cfg();
    process.env.ASSISTANT_OWN_USER = '1';
    const c = loadConfig();
    assert.equal(c.ownUser, true);
    assert.equal(c.freeShell, false);
    assert.equal(c.ownerName, 'Dana');
  });

  test('freeShell:false in the config stays false even as its own user', () => {
    cfg({ freeShell: false });
    process.env.ASSISTANT_OWN_USER = '1';
    const c = loadConfig();
    assert.equal(c.ownUser, true);
    assert.equal(c.freeShell, false);
  });

  test('freeShell:true in the config stays true', () => {
    cfg({ freeShell: true });
    assert.equal(loadConfig().freeShell, true);
  });

  test('without the env: ownUser false and freeShell false by default', () => {
    cfg();
    const c = loadConfig();
    assert.equal(c.ownUser, false);
    assert.equal(c.freeShell, false);
  });

  test('only the value "1" turns it on', () => {
    for (const v of ['0', '', 'true', 'yes', ' 1']) {
      cfg();
      process.env.ASSISTANT_OWN_USER = v;
      const c = loadConfig();
      assert.equal(c.ownUser, false, JSON.stringify(v));
      assert.equal(c.freeShell, false, JSON.stringify(v));
    }
  });

  test('"ownUser" written in config.json cannot switch it on (only the environment can)', () => {
    cfg({ ownUser: true });
    const c = loadConfig();
    assert.equal(c.ownUser, false);
    assert.equal(c.freeShell, false);
  });

  test('the data and agent folders are created at the temp paths', () => {
    const dir = cfg();
    const c = loadConfig();
    assert.equal(c.dataDir, path.join(dir, 'data'));
    assert.equal(c.agentCwd, path.join(dir, 'home'));
    assert.ok(fs.statSync(c.dataDir).isDirectory());
    assert.ok(fs.statSync(c.agentCwd).isDirectory());
    assert.equal(fs.statSync(c.dataDir).mode & 0o777, 0o700);
  });
});
