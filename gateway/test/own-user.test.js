import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { APP, BOT_BASE, BOT_HOME, REQUEST, applyUpdate, main, rehome, unitText, updateUnits } from '../bin/own-user.js';

let tmp;
let n = 0;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-user-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NODE_DIR = '/opt/assistant/node/bin';
const lines = (text) => text.split('\n');
// The value of "Key=value" in a unit (first match), or undefined.
const val = (text, key) => lines(text).find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
// The value of Environment="NAME=value".
const env = (text, name) => /^Environment="(.*)"$/.exec(lines(text).find((l) => l.startsWith(`Environment="${name}=`)) ?? '')?.[1].slice(name.length + 1);

describe('constants', () => {
  test('the paths are the fixed ones', () => {
    assert.equal(BOT_HOME, '/home/assistant');
    assert.equal(BOT_BASE, '/home/assistant/.assistant');
    assert.equal(APP, '/opt/assistant/app');
    assert.equal(REQUEST, '/home/assistant/.assistant/data/update-request.json');
  });
});

describe('unitText()', () => {
  const unit = unitText({ nodeDir: NODE_DIR, uid: 998 });

  test('runs as the assistant user and group', () => {
    assert.equal(val(unit, 'User'), 'assistant');
    assert.equal(val(unit, 'Group'), 'assistant');
  });

  test('ExecStart is quoted: node from nodeDir and the code in /opt', () => {
    assert.equal(val(unit, 'ExecStart'), `"${NODE_DIR}/node" --disable-warning=ExperimentalWarning "/opt/assistant/app/gateway/src/index.js"`);
    assert.equal(val(unit, 'WorkingDirectory'), '/opt/assistant/app/gateway');
  });

  test('a nodeDir with a space stays inside the quotes', () => {
    const u = unitText({ nodeDir: '/opt/my node/bin', uid: 1 });
    assert.ok(val(u, 'ExecStart').startsWith('"/opt/my node/bin/node" '));
  });

  test('environment: HOME, ASSISTANT_HOME, ASSISTANT_OWN_USER, XDG_RUNTIME_DIR', () => {
    assert.equal(env(unit, 'HOME'), '/home/assistant');
    assert.equal(env(unit, 'ASSISTANT_HOME'), '/home/assistant/.assistant');
    assert.equal(env(unit, 'ASSISTANT_OWN_USER'), '1');
    assert.equal(env(unit, 'XDG_RUNTIME_DIR'), '/run/user/998');
  });

  test('XDG_RUNTIME_DIR follows the uid given (a string from `id -u` too)', () => {
    assert.equal(env(unitText({ nodeDir: NODE_DIR, uid: '1234' }), 'XDG_RUNTIME_DIR'), '/run/user/1234');
  });

  test('PATH starts with the assistant\'s .local/bin, then nodeDir, then the system', () => {
    const p = env(unit, 'PATH').split(':');
    assert.deepEqual(p.slice(0, 2), ['/home/assistant/.local/bin', NODE_DIR]);
    assert.deepEqual(p.slice(2), ['/usr/local/bin', '/usr/bin', '/bin']);
  });

  test('hardening: no new privileges, private tmp, strict system, homes hidden but its own', () => {
    assert.equal(val(unit, 'NoNewPrivileges'), 'yes');
    assert.equal(val(unit, 'PrivateTmp'), 'yes');
    assert.equal(val(unit, 'ProtectSystem'), 'strict');
    assert.equal(val(unit, 'ReadWritePaths'), '/home/assistant');
    assert.equal(val(unit, 'ProtectHome'), 'tmpfs');
    assert.equal(val(unit, 'BindPaths'), '/home/assistant');
    assert.equal(val(unit, 'ProtectKernelTunables'), 'yes');
    assert.equal(val(unit, 'ProtectControlGroups'), 'yes');
  });

  test('no setting weakens the sandbox', () => {
    for (const bad of ['ProtectSystem=no', 'ProtectHome=no', 'ProtectHome=read-only', 'NoNewPrivileges=no', 'User=root']) {
      assert.ok(!lines(unit).includes(bad), bad);
    }
    assert.ok(!/AmbientCapabilities|CAP_SYS_ADMIN/.test(unit));
  });

  test('MemoryMax is 2G by default and can be set', () => {
    assert.equal(val(unit, 'MemoryMax'), '2G');
    assert.equal(val(unitText({ nodeDir: NODE_DIR, memory: '512M', uid: 998 }), 'MemoryMax'), '512M');
  });

  test('restarts always; installed for multi-user.target', () => {
    assert.equal(val(unit, 'Restart'), 'always');
    assert.equal(val(unit, 'RestartSec'), '5');
    assert.equal(lines(unit)[lines(unit).indexOf('[Install]') + 1], 'WantedBy=multi-user.target');
  });

  test('has the three sections [Unit] [Service] [Install]', () => {
    assert.deepEqual(lines(unit).filter((l) => /^\[.*\]$/.test(l)), ['[Unit]', '[Service]', '[Install]']);
  });
});

describe('updateUnits()', () => {
  const u = updateUnits({ nodeDir: NODE_DIR });

  test('exactly two units', () => {
    assert.deepEqual(Object.keys(u).sort(), ['assistant-update.path', 'assistant-update.service']);
  });

  test('the .path watches exactly REQUEST and nothing else', () => {
    const p = u['assistant-update.path'];
    const watched = lines(p).filter((l) => /^Path\w+=/.test(l));
    assert.deepEqual(watched, ['PathChanged=/home/assistant/.assistant/data/update-request.json']);
    assert.equal(`PathChanged=${REQUEST}`, watched[0]);
    assert.equal(lines(p)[lines(p).indexOf('[Install]') + 1], 'WantedBy=multi-user.target');
  });

  test('the .service is a oneshot that runs own-user.js apply-update from /opt', () => {
    const s = u['assistant-update.service'];
    assert.equal(val(s, 'Type'), 'oneshot');
    assert.equal(val(s, 'ExecStart'), `"${NODE_DIR}/node" "/opt/assistant/app/gateway/bin/own-user.js" apply-update`);
  });

  test('the update service does not run as the assistant (root does the update)', () => {
    assert.equal(val(u['assistant-update.service'], 'User'), undefined);
  });
});

// The unit files must be accepted by systemd's own parser.
describe('systemd-analyze verify', () => {
  const have = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' }).status === 0;
  const verify = (units) => {
    const dir = path.join(tmp, `sd${++n}`);
    fs.mkdirSync(dir);
    const files = Object.entries(units).map(([name, text]) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; });
    const r = spawnSync('systemd-analyze', ['verify', ...files], { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`.split('\n').filter(Boolean);
  };
  // Lines that say the file itself is wrong. A missing user, a missing /opt path or a missing
  // dependency on this machine is not a syntax error and is ignored.
  const SYNTAX = /Unknown key|Unknown section|Invalid section|Missing '='|Invalid (?:argument|syntax)|failed to load|Failed to parse|Unknown lvalue|Bad message|Assignment outside of section|Unbalanced/i;
  const skip = !have && 'systemd-analyze is not installed';

  test('the three units have no syntax problems', { skip }, () => {
    const nodeDir = path.dirname(process.execPath);
    const out = verify({ 'assistant.service': unitText({ nodeDir, uid: 998 }), ...updateUnits({ nodeDir }) });
    assert.deepEqual(out.filter((l) => SYNTAX.test(l)), [], out.join('\n'));
  });

  test('the check can see a broken unit (it is not blind)', { skip }, () => {
    const out = verify({ 'bad.service': '[Service]\nBogusKey=1\n[Unit\n' });
    assert.ok(out.some((l) => SYNTAX.test(l)), out.join('\n'));
  });
});

describe('rehome()', () => {
  const owner = '/home/dana/.assistant';

  test('replaces every occurrence of the owner base inside JSON text', () => {
    const text = JSON.stringify({ brain: { dir: `${owner}/repo/brain` }, agentCwd: `${owner}/home`, other: [`${owner}/data`, owner] }, null, 2);
    const out = rehome(text, owner);
    assert.ok(!out.includes('/home/dana'));
    assert.deepEqual(JSON.parse(out), { brain: { dir: '/home/assistant/.assistant/repo/brain' }, agentCwd: '/home/assistant/.assistant/home', other: ['/home/assistant/.assistant/data', '/home/assistant/.assistant'] });
  });

  test('leaves other paths alone', () => {
    const text = JSON.stringify({ a: '/home/dana/Documents/notes', b: '/home/dana/.other/y', c: '/usr/bin/git', d: 'relative/path', e: '~/.assistant/home' });
    assert.equal(rehome(text, owner), text);
  });

  test('text without the base comes back identical; an empty text too', () => {
    assert.equal(rehome('{}', owner), '{}');
    assert.equal(rehome('', owner), '');
  });

  test('the base is matched as plain text, not as a pattern', () => {
    const base = '/home/da.na/.assistant';
    assert.equal(rehome('"/home/daXna/.assistant/x" "/home/da.na/.assistant/y"', base), '"/home/daXna/.assistant/x" "/home/assistant/.assistant/y"');
  });
});

describe('applyUpdate()', () => {
  const SHA = 'a1b2c3'.padEnd(40, 'd');
  function setup({ body } = {}) {
    const dir = path.join(tmp, `u${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    const request = path.join(dir, 'update-request.json');
    if (body !== undefined) fs.writeFileSync(request, typeof body === 'string' ? body : JSON.stringify(body));
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'git' && args[2] === 'rev-parse') return SHA;
      return '';
    };
    return { request, calls, run };
  }

  test('no request file: "no request" and nothing is run', () => {
    const s = setup();
    assert.equal(applyUpdate({ run: s.run, request: s.request }), 'no request');
    assert.deepEqual(s.calls, []);
  });

  test('a valid tag: fetch, resolve, checkout the resolved sha, npm ci, restart', () => {
    const s = setup({ body: { version: 'v1.4.0', at: 5 } });
    assert.equal(applyUpdate({ run: s.run, request: s.request }), 'updated to v1.4.0');
    assert.deepEqual(s.calls.map((c) => [c.cmd, ...c.args]), [
      ['git', '-C', APP, 'fetch', '-q', '--tags', 'origin'],
      ['git', '-C', APP, 'rev-parse', 'v1.4.0^{commit}'],
      ['git', '-C', APP, 'checkout', '-q', SHA],
      ['npm', 'ci', '--omit=dev', '--no-audit', '--no-fund'],
      ['systemctl', 'restart', 'assistant.service'],
    ]);
  });

  test('checks out the resolved commit, never the raw tag', () => {
    const s = setup({ body: { version: 'v2.0.0' } });
    applyUpdate({ run: s.run, request: s.request });
    const co = s.calls.find((c) => c.args[2] === 'checkout');
    assert.equal(co.args[co.args.length - 1], SHA);
    assert.ok(!s.calls.some((c) => c.args.includes('v2.0.0')));
  });

  test('npm ci runs in /opt/assistant/app/gateway', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    applyUpdate({ run: s.run, request: s.request });
    assert.equal(s.calls.find((c) => c.cmd === 'npm').opts.cwd, '/opt/assistant/app/gateway');
  });

  test('the request file is removed after a good update', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    applyUpdate({ run: s.run, request: s.request });
    assert.equal(fs.existsSync(s.request), false);
    assert.equal(applyUpdate({ run: s.run, request: s.request }), 'no request'); // a second run is a no-op
  });

  test('the request file is removed before the update starts (a failing command cannot loop)', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    const run = () => { assert.equal(fs.existsSync(s.request), false); throw new Error('git failed'); };
    assert.throws(() => applyUpdate({ run, request: s.request }), /git failed/);
    assert.equal(fs.existsSync(s.request), false);
  });

  test('tag-like and dotted versions are accepted', () => {
    for (const version of ['v1.2.3', '1.2.3', 'release/2026-11', 'feature_x', 'a.b-c/d']) {
      const s = setup({ body: { version } });
      assert.equal(applyUpdate({ run: s.run, request: s.request }), `updated to ${version}`, version);
    }
  });

  for (const [label, body] of [
    ['--upload-pack=x', { version: '--upload-pack=x' }],
    ['-x', { version: '-x' }],
    ['empty string', { version: '' }],
    ['a space', { version: 'a b' }],
    ['$(x)', { version: '$(x)' }],
    ['a semicolon', { version: 'v1;rm' }],
    ['a newline', { version: 'v1\nv2' }],
    ['missing version', { at: 1 }],
    ['null version', { version: null }],
    ['version 0', { version: 0 }],
  ]) {
    test(`bad version (${label}): throws, nothing is run, the file is still removed`, () => {
      const s = setup({ body });
      assert.throws(() => applyUpdate({ run: s.run, request: s.request }), /not a tag/);
      assert.deepEqual(s.calls, []);
      assert.equal(fs.existsSync(s.request), false);
    });
  }

  test('a version that is an object is refused', () => {
    const s = setup({ body: { version: { a: 1 } } });
    assert.throws(() => applyUpdate({ run: s.run, request: s.request }), /not a tag/);
    assert.deepEqual(s.calls, []);
    assert.equal(fs.existsSync(s.request), false);
  });

  test('a version that is a one-element array is refused', () => {
    const s = setup({ body: { version: ['v1'] } });
    assert.throws(() => applyUpdate({ run: s.run, request: s.request }), /not a tag/);
    assert.deepEqual(s.calls, []);
  });

  test('a request that is not JSON: throws, nothing is run', () => {
    const s = setup({ body: 'not json {' });
    assert.throws(() => applyUpdate({ run: s.run, request: s.request }), /not JSON/);
    assert.deepEqual(s.calls, []);
  });

  test('a request that is not JSON is removed too', () => {
    const s = setup({ body: 'not json {' });
    assert.throws(() => applyUpdate({ run: s.run, request: s.request }));
    assert.equal(fs.existsSync(s.request), false);
  });

  test('a branch name works like in sync.js (falls back to origin/<name>)', () => {
    const s = setup({ body: { version: 'main' } });
    const run = (cmd, args, opts) => {
      s.calls.push({ cmd, args, opts });
      if (cmd === 'git' && args[2] === 'rev-parse') {
        if (args[3] === 'origin/main^{commit}') return SHA;
        throw new Error(`fatal: bad revision '${args[3]}'`);
      }
      return '';
    };
    assert.equal(applyUpdate({ run, request: s.request }), 'updated to main');
  });

  test('a failing step stops the rest (no restart after a failed npm ci)', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    const run = (cmd, args, opts) => { s.calls.push({ cmd, args, opts }); if (cmd === 'npm') throw new Error('npm failed'); return SHA; };
    assert.throws(() => applyUpdate({ run, request: s.request }), /npm failed/);
    assert.ok(!s.calls.some((c) => c.cmd === 'systemctl'));
  });
});

describe('main()', () => {
  const original = process.env.SUDO_USER;
  afterEach(() => { if (original === undefined) delete process.env.SUDO_USER; else process.env.SUDO_USER = original; });

  test('--help, -h and no command give the usage', () => {
    for (const a of [['--help'], ['-h'], []]) {
      const out = main(a);
      assert.match(out, /^Usage: sudo node own-user\.js COMMAND/);
      for (const c of ['install', 'sync-from-owner', 'apply-update', 'check', 'uninstall']) assert.ok(out.includes(c), c);
    }
  });

  test('--help needs no owner', () => {
    delete process.env.SUDO_USER;
    assert.match(main(['--help']), /^Usage/);
  });

  test('SUDO_USER unset and no --owner: "run it with sudo"', () => {
    delete process.env.SUDO_USER;
    for (const c of ['install', 'check', 'uninstall', 'sync-from-owner', 'bogus']) assert.throws(() => main([c]), /run it with sudo/, c);
  });

  test('--owner root, assistant, "a b" and other bad names are refused', () => {
    delete process.env.SUDO_USER;
    for (const o of ['root', 'assistant', 'a b', '', '$(x)', '-x', 'a;b', '../x', '1abc']) {
      assert.throws(() => main(['install', '--owner', o]), /run it with sudo/, JSON.stringify(o));
    }
  });

  test('--owner with no value is refused', () => {
    delete process.env.SUDO_USER;
    assert.throws(() => main(['install', '--owner']), /run it with sudo/);
  });

  test('a bad --owner wins over a good SUDO_USER', () => {
    process.env.SUDO_USER = 'dana';
    assert.throws(() => main(['install', '--owner', 'root']), /run it with sudo/);
  });

  test('SUDO_USER root (sudo from a root shell) is refused as well', () => {
    process.env.SUDO_USER = 'root';
    assert.throws(() => main(['install']), /run it with sudo/);
  });

  test('an unknown command with a valid --owner: "unknown command" plus the usage', () => {
    delete process.env.SUDO_USER;
    assert.throws(() => main(['frobnicate', '--owner', 'dana']), (e) => /^unknown command frobnicate\nUsage: sudo node own-user\.js/.test(e.message));
  });

  test('an unknown command with a valid SUDO_USER is refused the same way', () => {
    process.env.SUDO_USER = 'dana';
    assert.throws(() => main(['frobnicate']), /unknown command frobnicate/);
  });
});
