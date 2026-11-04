import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { APP, BOT_BASE, BOT_HOME, REQUEST, applyUpdate, trustKey, giveBot, main, newer, noLink, publicKey, rehome, rollback, unitText, updateUnits } from '../bin/own-user.js';

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
  // `merged`: what `git tag --merged HEAD` prints (the tags the installed code contains).
  function setup({ body, merged = '' } = {}) {
    const dir = path.join(tmp, `u${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    const request = path.join(dir, 'update-request.json');
    if (body !== undefined) fs.writeFileSync(request, typeof body === 'string' ? body : JSON.stringify(body));
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'git' && args[2] === 'rev-parse') return SHA;
      if (cmd === 'git' && args[2] === 'tag') return merged;
      return '';
    };
    return { dir, request, calls, run, opts: { run, request, top: dir } };
  }

  test('with a trusted release key: the tag is verified first; an unsigned tag is refused before any checkout', () => {
    const signers = path.join(tmp, `signers${++n}`);
    const pub = path.join(tmp, `k${n}.pub`);
    fs.writeFileSync(pub, `ssh-ed25519 ${'A'.repeat(68)} release@pc\n`);
    assert.match(trustKey(pub, { signers }), /trusted/);
    assert.match(fs.readFileSync(signers, 'utf8'), /^release namespaces="git" ssh-ed25519 A{68}\n$/);
    const good = setup({ body: { version: 'v1.4.0' }, merged: 'v1.3.0\n' });
    assert.equal(applyUpdate({ ...good.opts, signers }), 'updated to v1.4.0');
    const v = good.calls.findIndex((c) => c.args.includes('verify-tag'));
    assert.ok(v >= 0 && v < good.calls.findIndex((c) => c.args.includes('checkout')));
    assert.ok(good.calls[v].args.includes(`gpg.ssh.allowedSignersFile=${signers}`));
    const bad = setup({ body: { version: 'v1.4.0' }, merged: 'v1.3.0\n' });
    const run = (cmd, args, o) => { if (args.includes('verify-tag')) throw new Error('no signature'); return bad.run(cmd, args, o); };
    assert.throws(() => applyUpdate({ ...bad.opts, run, signers }), /not signed by a trusted release key/);
    assert.ok(!bad.calls.some((c) => c.args.includes('checkout')));
    assert.throws(() => trustKey(signers, { signers: path.join(tmp, 'x') }), /not an ssh public key/);
  });

  test('no request file: "no request" and nothing is run', () => {
    const s = setup();
    assert.equal(applyUpdate(s.opts), 'no request');
    assert.deepEqual(s.calls, []);
  });

  test('a newer release: fetch, read the installed tags, resolve the tag, checkout the sha, npm ci, restart', () => {
    const s = setup({ body: { version: 'v1.4.0', at: 5 }, merged: 'v1.2.0\nv1.3.0\n' });
    assert.equal(applyUpdate(s.opts), 'updated to v1.4.0');
    assert.deepEqual(s.calls.map((c) => [c.cmd, ...c.args]), [
      ['git', '-C', APP, 'fetch', '-q', '--tags', 'origin'],
      ['git', '-C', APP, 'tag', '--merged', 'HEAD', '--list', 'v*'],
      ['git', '-C', APP, 'rev-parse', 'refs/tags/v1.4.0^{commit}'],
      ['git', '-C', APP, 'checkout', '-q', SHA],
      ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['systemctl', 'restart', 'assistant.service'],
    ]);
  });

  test('npm ci never runs install scripts as root (--ignore-scripts)', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    applyUpdate(s.opts);
    const npm = s.calls.filter((c) => c.cmd === 'npm');
    assert.equal(npm.length, 1);
    assert.ok(npm[0].args.includes('--ignore-scripts'));
  });

  test('the tag is resolved as refs/tags/<v>: a branch of the same name cannot stand in', () => {
    const s = setup({ body: { version: 'v2.0.0' } });
    applyUpdate(s.opts);
    const revs = s.calls.filter((c) => c.args[2] === 'rev-parse').map((c) => c.args[3]);
    assert.deepEqual(revs, ['refs/tags/v2.0.0^{commit}']);
  });

  test('checks out the resolved commit, never the raw tag', () => {
    const s = setup({ body: { version: 'v2.0.0' } });
    applyUpdate(s.opts);
    const co = s.calls.find((c) => c.args[2] === 'checkout');
    assert.equal(co.args[co.args.length - 1], SHA);
    assert.ok(!s.calls.some((c) => c.args.includes('v2.0.0')));
  });

  test('npm ci runs in /opt/assistant/app/gateway', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    applyUpdate(s.opts);
    assert.equal(s.calls.find((c) => c.cmd === 'npm').opts.cwd, '/opt/assistant/app/gateway');
  });

  test('the request file is removed after a good update', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    applyUpdate(s.opts);
    assert.equal(fs.existsSync(s.request), false);
    assert.equal(applyUpdate(s.opts), 'no request'); // a second run is a no-op
  });

  test('the request file is removed before the update starts (a failing command cannot loop)', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    const run = () => { assert.equal(fs.existsSync(s.request), false); throw new Error('git failed'); };
    assert.throws(() => applyUpdate({ ...s.opts, run }), /git failed/);
    assert.equal(fs.existsSync(s.request), false);
  });

  test('before the first release (no tag in HEAD) any release tag is taken', () => {
    for (const version of ['v0.0.1', 'v1.2.3', 'v10.20.30']) {
      const s = setup({ body: { version }, merged: '' });
      assert.equal(applyUpdate(s.opts), `updated to ${version}`, version);
    }
  });

  for (const [label, installedTags, version] of [
    ['the same release', 'v1.4.0', 'v1.4.0'],
    ['an older patch', 'v1.4.1', 'v1.4.0'],
    ['an older minor', 'v1.4.0', 'v1.3.9'],
    ['an older major', 'v2.0.0', 'v1.99.99'],
    ['older than the newest tag in HEAD (not just the last listed)', 'v1.9.0\nv1.10.0\nv1.2.0', 'v1.9.5'],
  ]) {
    test(`a downgrade is refused (${label}): no checkout, no npm, no restart`, () => {
      const s = setup({ body: { version }, merged: installedTags });
      assert.throws(() => applyUpdate(s.opts), /refusing .*not newer than the installed .*rollback/);
      assert.ok(!s.calls.some((c) => c.args[2] === 'checkout' || c.cmd === 'npm' || c.cmd === 'systemctl'));
      assert.equal(fs.existsSync(s.request), false);
    });
  }

  test('tags in HEAD that are not releases (rc, names) do not count as installed', () => {
    const s = setup({ body: { version: 'v1.0.0' }, merged: 'v9.0.0-rc1\nvlatest\nv2\nrelease-1' });
    assert.equal(applyUpdate(s.opts), 'updated to v1.0.0');
  });

  for (const version of ['main', 'stable', '1.2.3', 'v1.2', 'v1.2.3.4', 'v1.2.3-rc1', 'release/2026-11', 'feature_x', 'V1.2.3', 'v1.2.3 ', 'refs/tags/v1.2.3', 'v1.2.x']) {
    test(`not a release tag (${JSON.stringify(version)}): refused before any command`, () => {
      const s = setup({ body: { version } });
      assert.throws(() => applyUpdate(s.opts), /not a release tag/);
      assert.deepEqual(s.calls, []);
    });
  }

  for (const [label, body] of [
    ['--upload-pack=x', { version: '--upload-pack=x' }],
    ['-x', { version: '-x' }],
    ['empty string', { version: '' }],
    ['a space', { version: 'a b' }],
    ['$(x)', { version: '$(x)' }],
    ['a semicolon', { version: 'v1;rm' }],
    ['a newline', { version: 'v1.0.0\nv2.0.0' }],
    ['missing version', { at: 1 }],
    ['null version', { version: null }],
    ['version 0', { version: 0 }],
  ]) {
    test(`bad version (${label}): throws, nothing is run, the file is still removed`, () => {
      const s = setup({ body });
      assert.throws(() => applyUpdate(s.opts), /not a release tag/);
      assert.deepEqual(s.calls, []);
      assert.equal(fs.existsSync(s.request), false);
    });
  }

  test('a version that is an object is refused', () => {
    const s = setup({ body: { version: { a: 1 } } });
    assert.throws(() => applyUpdate(s.opts), /not a release tag/);
    assert.deepEqual(s.calls, []);
    assert.equal(fs.existsSync(s.request), false);
  });

  test('a version that is a one-element array is refused', () => {
    const s = setup({ body: { version: ['v1.0.0'] } });
    assert.throws(() => applyUpdate(s.opts), /not a release tag/);
    assert.deepEqual(s.calls, []);
  });

  test('a request that is not JSON: throws, nothing is run', () => {
    const s = setup({ body: 'not json {' });
    assert.throws(() => applyUpdate(s.opts), /not JSON/);
    assert.deepEqual(s.calls, []);
  });

  test('a request that is not JSON is removed too', () => {
    const s = setup({ body: 'not json {' });
    assert.throws(() => applyUpdate(s.opts));
    assert.equal(fs.existsSync(s.request), false);
  });

  test('a failing step stops the rest (no restart after a failed npm ci)', () => {
    const s = setup({ body: { version: 'v1.0.0' } });
    const run = (cmd, args, opts) => { s.calls.push({ cmd, args, opts }); if (cmd === 'npm') throw new Error('npm failed'); return SHA; };
    assert.throws(() => applyUpdate({ ...s.opts, run }), /npm failed/);
    assert.ok(!s.calls.some((c) => c.cmd === 'systemctl'));
  });

  // The assistant owns the folder with the request: it can put a symlink or a FIFO there.
  test('a request that is a symlink is not followed: refused, the link removed, its target untouched', () => {
    const s = setup();
    const secret = path.join(s.dir, 'secret');
    fs.writeFileSync(secret, JSON.stringify({ version: 'v9.9.9' }));
    fs.symlinkSync(secret, s.request);
    assert.throws(() => applyUpdate(s.opts), /refusing: .* is a symlink/);
    assert.deepEqual(s.calls, []);
    assert.equal(fs.lstatSync(s.request, { throwIfNoEntry: false }), undefined);
    assert.equal(fs.readFileSync(secret, 'utf8'), JSON.stringify({ version: 'v9.9.9' }));
  });

  test('a request under a symlinked folder: refused, nothing read or removed through it', () => {
    const s = setup();
    const elsewhere = path.join(s.dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'update-request.json'), JSON.stringify({ version: 'v1.0.0' }));
    fs.symlinkSync(elsewhere, path.join(s.dir, 'data'));
    const request = path.join(s.dir, 'data', 'update-request.json');
    assert.throws(() => applyUpdate({ ...s.opts, request }), /refusing: .*data is a symlink/);
    assert.deepEqual(s.calls, []);
    assert.ok(fs.existsSync(path.join(elsewhere, 'update-request.json')), 'the file behind the link must stay');
  });

  test('a request that is a FIFO is refused at once (root does not hang on it)', () => {
    const s = setup();
    const r = spawnSync('mkfifo', [s.request]);
    if (r.status !== 0) return; // no mkfifo here
    assert.throws(() => applyUpdate(s.opts), /not a plain file/);
    assert.deepEqual(s.calls, []);
  });

  test('a huge request is refused (root reads at most 64 KB)', () => {
    const s = setup({ body: JSON.stringify({ version: 'v1.0.0', pad: 'x'.repeat(70 << 10) }) });
    assert.throws(() => applyUpdate(s.opts), /larger than/);
    assert.deepEqual(s.calls, []);
  });
});

describe('rollback()', () => {
  const SHA = 'f'.repeat(40);
  const fake = () => { const calls = []; return { calls, run: (cmd, args, opts) => { calls.push([cmd, ...args]); return cmd === 'git' && args[2] === 'rev-parse' ? SHA : ''; } }; };

  test('goes to an older release with no "newer" check, scripts off', () => {
    const f = fake();
    assert.equal(rollback('v1.0.0', { run: f.run }), 'rolled back to v1.0.0');
    assert.deepEqual(f.calls, [
      ['git', '-C', APP, 'fetch', '-q', '--tags', 'origin'],
      ['git', '-C', APP, 'rev-parse', 'refs/tags/v1.0.0^{commit}'],
      ['git', '-C', APP, 'checkout', '-q', SHA],
      ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['systemctl', 'restart', 'assistant.service'],
    ]);
  });

  test('takes only release tags', () => {
    for (const v of ['main', '-x', 'v1.0', undefined, 'v1.0.0;id']) {
      const f = fake();
      assert.throws(() => rollback(v, { run: f.run }), /not a release tag/, String(v));
      assert.deepEqual(f.calls, []);
    }
  });
});

describe('newer()', () => {
  test('compares release tags as numbers', () => {
    assert.equal(newer('v1.10.0', 'v1.9.0'), true);
    assert.equal(newer('v1.9.0', 'v1.10.0'), false);
    assert.equal(newer('v2.0.0', 'v1.99.99'), true);
    assert.equal(newer('v1.0.1', 'v1.0.0'), true);
    assert.equal(newer('v1.0.0', 'v1.0.0'), false);
    assert.equal(newer('v0.9.9', 'v1.0.0'), false);
  });
});

describe('noLink()', () => {
  const box = () => { const d = path.join(tmp, `l${++n}`); fs.mkdirSync(path.join(d, 'home', 'data'), { recursive: true }); return d; };

  test('real folders and files, and parts that do not exist yet, pass', () => {
    const d = box();
    const top = path.join(d, 'home');
    fs.writeFileSync(path.join(top, 'data', '.env'), 'x');
    assert.equal(noLink(path.join(top, 'data', '.env'), top), path.join(top, 'data', '.env'));
    assert.equal(noLink(path.join(top, 'data', 'new', 'deeper', 'f'), top), path.join(top, 'data', 'new', 'deeper', 'f'));
    assert.equal(noLink(top, top), top);
  });

  test('a symlinked folder on the way is refused, with its name in the message', () => {
    const d = box();
    const top = path.join(d, 'home');
    fs.mkdirSync(path.join(d, 'etc'));
    fs.symlinkSync(path.join(d, 'etc'), path.join(top, 'data', 'browser'));
    assert.throws(() => noLink(path.join(top, 'data', 'browser', 'x.import.json'), top), (e) => e.message.includes(`${path.join(top, 'data', 'browser')} is a symlink`) && /Remove it/.test(e.message));
  });

  test('a symlink as the last part is refused, also a dangling one', () => {
    const d = box();
    const top = path.join(d, 'home');
    fs.symlinkSync('/etc/shadow', path.join(top, 'data', '.env'));
    fs.symlinkSync(path.join(d, 'nothing'), path.join(top, 'data', 'dangling'));
    assert.throws(() => noLink(path.join(top, 'data', '.env'), top), /is a symlink/);
    assert.throws(() => noLink(path.join(top, 'data', 'dangling'), top), /is a symlink/);
  });

  test('the top itself as a symlink is refused', () => {
    const d = box();
    fs.symlinkSync(path.join(d, 'home'), path.join(d, 'link'));
    assert.throws(() => noLink(path.join(d, 'link', 'data'), path.join(d, 'link')), /is a symlink/);
  });

  test('a path outside the top (or climbing out with ..) is refused', () => {
    const d = box();
    const top = path.join(d, 'home');
    assert.throws(() => noLink('/etc/passwd', top), /is not inside/);
    assert.throws(() => noLink(path.join(top, '..', 'x'), top), /is not inside/);
  });

  test('the default top is the assistant\'s home', () => {
    assert.throws(() => noLink('/etc/passwd'), /is not inside \/home\/assistant/);
  });
});

// giveBot with as: [] runs the same tar pipe as the current user (in a test there is no
// `assistant` user and no root), so the copy itself is checked for real.
describe('giveBot()', () => {
  const box = () => {
    const d = path.join(tmp, `g${++n}`);
    fs.mkdirSync(path.join(d, 'owner', 'data', 'browser'), { recursive: true });
    fs.mkdirSync(path.join(d, 'bot'), { recursive: true });
    fs.writeFileSync(path.join(d, 'owner', 'data', '.env'), 'A=1\n', { mode: 0o600 });
    fs.writeFileSync(path.join(d, 'owner', 'data', 'browser', 'x.import.json'), '{}');
    fs.symlinkSync('browser/x.import.json', path.join(d, 'owner', 'data', 'link'));
    return { d, owner: path.join(d, 'owner'), bot: path.join(d, 'bot') };
  };
  const mode = (f) => fs.statSync(f).mode & 0o777;

  test('copies a folder: contents, modes (.env stays 0600), symlinks as symlinks', () => {
    const b = box();
    assert.equal(giveBot(path.join(b.owner, 'data'), path.join(b.bot, 'base', 'data'), { as: [], top: b.bot }), true);
    const to = path.join(b.bot, 'base', 'data');
    assert.equal(fs.readFileSync(path.join(to, '.env'), 'utf8'), 'A=1\n');
    assert.equal(mode(path.join(to, '.env')), 0o600);
    assert.equal(fs.readFileSync(path.join(to, 'browser', 'x.import.json'), 'utf8'), '{}');
    assert.equal(fs.readlinkSync(path.join(to, 'link')), 'browser/x.import.json');
  });

  test('copies a single file and overwrites an older copy', () => {
    const b = box();
    const to = path.join(b.bot, 'data', '.env');
    giveBot(path.join(b.owner, 'data', '.env'), to, { as: [], top: b.bot });
    fs.writeFileSync(path.join(b.owner, 'data', '.env'), 'A=2\n');
    giveBot(path.join(b.owner, 'data', '.env'), to, { as: [], top: b.bot });
    assert.equal(fs.readFileSync(to, 'utf8'), 'A=2\n');
  });

  test('a missing source: false, nothing is run', () => {
    const b = box();
    const calls = [];
    assert.equal(giveBot(path.join(b.owner, 'nope'), path.join(b.bot, 'nope'), { run: (...a) => calls.push(a), top: b.bot }), false);
    assert.deepEqual(calls, []);
  });

  test('a symlink on the assistant\'s side is refused before anything runs, and nothing is written through it', () => {
    const b = box();
    const victim = path.join(b.d, 'victim');
    fs.mkdirSync(victim);
    fs.symlinkSync(victim, path.join(b.bot, 'data'));
    const calls = [];
    assert.throws(() => giveBot(path.join(b.owner, 'data', '.env'), path.join(b.bot, 'data', '.env'), { run: (...a) => calls.push(a), top: b.bot }), /data is a symlink/);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(victim), []);
  });

  test('as root it unpacks as the assistant: runuser -u assistant -- comes last, the paths are arguments', () => {
    const b = box();
    const calls = [];
    giveBot(path.join(b.owner, 'data'), path.join(b.bot, 'base', 'data'), { run: (cmd, args) => calls.push([cmd, ...args]), top: b.bot });
    assert.equal(calls.length, 1);
    const [cmd, c, script, zero, src, name, dest, ...as] = calls[0];
    assert.deepEqual([cmd, c, zero, src, name, dest], ['bash', '-c', 'bash', b.owner, 'data', path.join(b.bot, 'base')]);
    assert.deepEqual(as, ['runuser', '-u', 'assistant', '--']);
    assert.match(script, /pipefail/);
    assert.ok(!script.includes(b.owner), 'no path inside the script text');
  });

  test('a failed read on the owner\'s side fails the copy (pipefail)', () => {
    const b = box();
    const src = path.join(b.owner, 'data', 'browser');
    fs.chmodSync(src, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads it anyway
      assert.throws(() => giveBot(src, path.join(b.bot, 'browser'), { as: [], top: b.bot }));
    } finally { fs.chmodSync(src, 0o755); }
  });

  test('the base names must match', () => {
    const b = box();
    assert.throws(() => giveBot(path.join(b.owner, 'data'), path.join(b.bot, 'other'), { run: () => {}, top: b.bot }), /same name/);
  });
});

describe('publicKey()', () => {
  const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq0b1Uq2Sx6QmF9cJjHn3m2cR5sLbYz8kT0wE1vXyZa assistant-own-user';
  test('one ed25519 line passes, trimmed', () => {
    assert.equal(publicKey(`${KEY}\n`), KEY);
  });
  test('anything else is refused (it would be uploaded to GitHub)', () => {
    for (const t of ['root:$6$abc:19000:0:99999:7:::', `${KEY}\n${KEY}`, '', '-----BEGIN OPENSSH PRIVATE KEY-----', 'ssh-rsa AAAAB3Nza x']) {
      assert.throws(() => publicKey(t), /not one ed25519 public key/, t);
    }
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

  test('the usage tells root how to roll back by hand, and that updates go only forward', () => {
    const out = main(['--help']);
    assert.match(out, /^\s*rollback vX\.Y\.Z .*sudo node own-user\.js rollback v\d+\.\d+\.\d+/m);
    assert.match(out, /newer than the installed one/);
  });

  test('rollback with no or a bad tag: "not a release tag" before anything else (no sudo needed to see it)', () => {
    delete process.env.SUDO_USER;
    for (const a of [['rollback'], ['rollback', 'main'], ['rollback', '--owner'], ['rollback', 'v1.2']]) {
      assert.throws(() => main(a), /^Error: not a release tag/, a.join(' '));
    }
  });

  test('rollback with a good tag but not as root: "run with sudo"', { skip: process.getuid?.() === 0 && 'running as root' }, () => {
    assert.throws(() => main(['rollback', 'v1.0.0']), /run with sudo/);
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
