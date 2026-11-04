import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { main, plistText, unitText, update } from '../bin/service.js';

let tmp;
let n = 0;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'service-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PATH_DIRS = ['/opt/node/bin', '/usr/local/bin', '/usr/bin'];
const NODE = '/opt/node/bin/node';

describe('unitText (systemd)', () => {
  const text = unitText({ node: NODE, app: '/home/dana/.assistant/app', base: '/home/dana/.assistant', pathDirs: PATH_DIRS });
  const lines = text.split('\n');

  test('ExecStart runs the node path with app/gateway/src/index.js', () => {
    assert.ok(lines.includes('ExecStart="/opt/node/bin/node" --disable-warning=ExperimentalWarning "/home/dana/.assistant/app/gateway/src/index.js"'));
  });

  test('WorkingDirectory is app/gateway', () => {
    assert.ok(lines.includes('WorkingDirectory=/home/dana/.assistant/app/gateway'));
  });

  test('ASSISTANT_HOME and a PATH joined with ":"', () => {
    assert.ok(lines.includes('Environment="ASSISTANT_HOME=/home/dana/.assistant"'));
    assert.ok(lines.includes('Environment="PATH=/opt/node/bin:/usr/local/bin:/usr/bin"'));
  });

  test('restart policy, memory cap, hardening, install target', () => {
    assert.ok(lines.includes('Restart=always'));
    assert.ok(lines.includes('RestartSec=5'));
    assert.ok(lines.includes('MemoryMax=2G')); // default
    assert.ok(lines.includes('NoNewPrivileges=yes'));
    assert.ok(lines.includes('WantedBy=default.target'));
    assert.ok(lines.indexOf('[Unit]') < lines.indexOf('[Service]') && lines.indexOf('[Service]') < lines.indexOf('[Install]'));
    assert.ok(text.endsWith('\n'));
  });

  test('a custom memory value is used', () => {
    assert.match(unitText({ node: NODE, pathDirs: PATH_DIRS, memory: '512M' }), /^MemoryMax=512M$/m);
  });

  test('defaults: app is the repo checkout two levels above bin/, base follows ASSISTANT_HOME or ~/.assistant', () => {
    const t = unitText({ node: NODE, pathDirs: PATH_DIRS });
    const exec = /^ExecStart="\S+" \S+ "(\S+)"$/m.exec(t)[1];
    assert.ok(path.isAbsolute(exec));
    assert.ok(exec.endsWith(path.join('gateway', 'src', 'index.js')));
    assert.ok(fs.existsSync(exec), 'the default app path points to the real gateway entry file');
    assert.match(t, /^Environment="ASSISTANT_HOME=\/\S+"$/m);
  });

  test('a path with a space is quoted for systemd', () => {
    const t = unitText({ node: NODE, app: '/home/da na/app', base: '/home/da na/.assistant', pathDirs: PATH_DIRS });
    const exec = t.split('\n').find((l) => l.startsWith('ExecStart='));
    assert.ok(exec.includes('"/home/da na/app/gateway/src/index.js"'), exec);
  });
});

describe('plistText (launchd)', () => {
  const opts = { node: NODE, app: '/Users/dana/.assistant/app', base: '/Users/dana/.assistant', pathDirs: PATH_DIRS };

  test('the gateway agent: label, program arguments, keep-alive', () => {
    const t = plistText(opts);
    assert.match(t, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.ok(t.includes('<key>Label</key><string>local.assistant.gateway</string>'));
    assert.ok(t.includes('<key>ProgramArguments</key><array><string>/opt/node/bin/node</string><string>--disable-warning=ExperimentalWarning</string><string>/Users/dana/.assistant/app/gateway/src/index.js</string></array>'));
    assert.ok(t.includes('<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'));
    assert.ok(!t.includes('StartInterval'));
    assert.ok(t.includes('<key>WorkingDirectory</key><string>/Users/dana/.assistant/app/gateway</string>'));
    assert.ok(t.includes('<key>ASSISTANT_HOME</key><string>/Users/dana/.assistant</string>'));
    assert.ok(t.includes('<key>PATH</key><string>/opt/node/bin:/usr/local/bin:/usr/bin</string>'));
    assert.equal(t.split('/Users/dana/.assistant/gateway.log').length - 1, 2, 'stdout and stderr go to gateway.log');
  });

  test('the update agent: own label and args, StartInterval and no KeepAlive', () => {
    const t = plistText({ ...opts, label: 'update', args: ['/Users/dana/.assistant/app/gateway/bin/service.js', 'update'], every: 300 });
    assert.ok(t.includes('<key>Label</key><string>local.assistant.update</string>'));
    assert.ok(t.includes('<string>/opt/node/bin/node</string><string>/Users/dana/.assistant/app/gateway/bin/service.js</string><string>update</string>'));
    assert.ok(t.includes('<key>StartInterval</key><integer>300</integer>'));
    assert.ok(!t.includes('KeepAlive'));
    assert.ok(!t.includes('RunAtLoad'));
    assert.ok(!t.includes('src/index.js'));
  });

  test('& and < in paths are XML-escaped everywhere', () => {
    const t = plistText({ node: '/opt/a&b/node', app: '/Users/R&D <x>/app', base: '/Users/R&D <x>/.assistant', pathDirs: ['/p&q', '/r<s'] });
    assert.ok(t.includes('<string>/opt/a&amp;b/node</string>'));
    assert.ok(t.includes('<string>/Users/R&amp;D &lt;x>/app/gateway/src/index.js</string>'));
    assert.ok(t.includes('<key>WorkingDirectory</key><string>/Users/R&amp;D &lt;x>/app/gateway</string>'));
    assert.ok(t.includes('<key>ASSISTANT_HOME</key><string>/Users/R&amp;D &lt;x>/.assistant</string>'));
    assert.ok(t.includes('<string>/p&amp;q:/r&lt;s</string>'));
    assert.ok(t.includes('<string>/Users/R&amp;D &lt;x>/.assistant/gateway.log</string>'));
    assert.ok(!/&(?!amp;|lt;)/.test(t), 'no raw ampersand is left');
    assert.ok(!/<string>[^<]*<[^/s][^<]*<\/string>/.test(t), 'no raw < inside a string');
  });

  test('& is escaped before < (no double escaping)', () => {
    const t = plistText({ ...opts, base: '/b/a&lt;' });
    assert.ok(t.includes('/b/a&amp;lt;'));
  });
});

// restart() inside update() is not injectable: it calls the module's own execFileSync wrapper with
// "systemctl --user restart assistant.service" (Linux) or "launchctl kickstart ..." (macOS). So
// these tests put a directory with FAKE systemctl/launchctl scripts as the ONLY entry of PATH while
// update() runs; nothing real can be reached, and the calls are recorded in a file.
describe('update()', () => {
  const realPath = process.env.PATH;
  let base; let app; let bin; let calls;

  const fakeLog = () => (fs.existsSync(path.join(bin, 'calls.log')) ? fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []);

  beforeEach(() => {
    const root = path.join(tmp, `u${++n}`);
    base = path.join(root, 'base');
    app = path.join(root, 'app');
    bin = path.join(root, 'bin');
    for (const d of [base, path.join(app, 'gateway'), bin]) fs.mkdirSync(d, { recursive: true });
    for (const tool of ['systemctl', 'launchctl']) {
      fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${bin}/calls.log"\nexit 0\n`, { mode: 0o755 });
    }
    process.env.PATH = bin; // ONLY the fakes
    calls = [];
  });
  afterEach(() => { process.env.PATH = realPath; });

  // A fake sh(cmd, args, opts): records the call; `reply` maps "cmd arg arg" strings to a value, a function, or an Error.
  const makeSh = (reply = {}) => (cmd, args, opts) => {
    assert.equal(process.env.PATH, bin, 'update() runs only against the fake tools');
    const key = [cmd, ...args].join(' ');
    calls.push({ cmd, args, opts, key });
    const r = Object.entries(reply).find(([k]) => key.includes(k))?.[1];
    if (typeof r === 'function') return r(calls.filter((c) => c.key === key).length);
    if (r instanceof Error) throw r;
    return r ?? '';
  };
  const logs = [];
  const run = (sh, extra = {}) => { logs.length = 0; return update({ base, app, sh, log: (l) => logs.push(l), ...extra }); };
  const restartLine = os.platform() === 'darwin' ? /^launchctl kickstart -k gui\/\d+\/local\.assistant\.gateway$/ : /^systemctl --user restart assistant\.service$/;

  test('the fakes are in place: only they are on PATH', () => {
    assert.equal(process.env.PATH, bin);
    assert.ok(fs.existsSync(path.join(bin, 'systemctl')));
  });

  test('no repo and no pinned version: "up to date", nothing run, no restart', () => {
    const out = run(makeSh());
    assert.deepEqual(out, []);
    assert.deepEqual(logs, ['up to date']);
    assert.deepEqual(calls, []);
    assert.deepEqual(fakeLog(), []);
  });

  test('a repo with a .git dir is pulled with --rebase --autostash', () => {
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    run(makeSh({ 'rev-parse HEAD:config.json': 'abc123' }));
    const pull = calls.find((c) => c.args.includes('pull'));
    assert.deepEqual([pull.cmd, ...pull.args], ['git', '-C', repo, 'pull', '-q', '--rebase', '--autostash']);
    // rev-parse is read before and after the pull
    const order = calls.map((c) => c.args[2]);
    assert.deepEqual(order, ['rev-parse', 'pull', 'rev-parse']);
    assert.deepEqual(calls[0].args, ['-C', repo, 'rev-parse', 'HEAD:config.json']);
  });

  test('a repo directory without .git is not touched', () => {
    fs.mkdirSync(path.join(base, 'repo'), { recursive: true });
    run(makeSh());
    assert.deepEqual(calls, []);
  });

  test('config blob unchanged by the pull: up to date, no restart', () => {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
    const out = run(makeSh({ 'rev-parse HEAD:config.json': 'same' }));
    assert.deepEqual(out, []);
    assert.deepEqual(logs, ['up to date']);
    assert.deepEqual(fakeLog(), []);
  });

  test('config blob changed by the pull: "config changed" and one restart', () => {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
    const out = run(makeSh({ 'rev-parse HEAD:config.json': (i) => (i === 1 ? 'blob-old' : 'blob-new') }));
    assert.deepEqual(out, ['config changed', 'restarted']);
    assert.deepEqual(logs, ['config changed; restarted']);
    const rc = fakeLog();
    assert.equal(rc.length, 1);
    assert.match(rc[0], restartLine);
    assert.ok(!calls.some((c) => c.args.includes('describe')), 'no version pinned: no describe');
  });

  test('config.json first appears with the pull (rev-parse failed before): counts as changed', () => {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
    run(makeSh({ 'rev-parse HEAD:config.json': (i) => { if (i === 1) throw new Error('bad revision'); return 'blob-new'; } }));
    assert.match(fakeLog().join('\n'), restartLine);
  });

  test('a failing pull throws and nothing is restarted', () => {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
    assert.throws(() => run(makeSh({ pull: new Error('conflict') })), /conflict/);
    assert.deepEqual(fakeLog(), []);
    assert.deepEqual(logs, []);
  });

  describe('pinned version', () => {
    const pin = (version, where = path.join(base, 'config.json')) => { fs.mkdirSync(path.dirname(where), { recursive: true }); fs.writeFileSync(where, JSON.stringify({ version, language: 'en' })); };

    test('another version than git describe: fetch --tags, checkout, npm ci in app/gateway, restart', () => {
      pin('v1.2.0');
      const out = run(makeSh({ 'describe --tags --always': 'v1.1.0' }));
      assert.deepEqual(out, ['code v1.1.0 → v1.2.0', 'restarted']);
      assert.deepEqual(calls.map((c) => c.key), [
        `git -C ${app} describe --tags --always`,
        `git -C ${app} fetch -q --tags origin`,
        `git -C ${app} checkout -q v1.2.0`,
        'npm ci --omit=dev --no-audit --no-fund',
      ]);
      assert.equal(calls[3].opts.cwd, path.join(app, 'gateway'));
      const rc = fakeLog();
      assert.equal(rc.length, 1);
      assert.match(rc[0], restartLine);
      assert.deepEqual(logs, ['code v1.1.0 → v1.2.0; restarted']);
    });

    test('same version as git describe: no fetch, no checkout, no restart', () => {
      pin('v1.2.0');
      const out = run(makeSh({ 'describe --tags --always': 'v1.2.0' }));
      assert.deepEqual(out, []);
      assert.deepEqual(calls.map((c) => c.args[2]), ['describe']);
      assert.deepEqual(fakeLog(), []);
      assert.deepEqual(logs, ['up to date']);
    });

    test('the private repo config.json wins over <base>/config.json', () => {
      fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
      pin('v2.0.0', path.join(base, 'repo', 'config.json'));
      pin('v1.0.0', path.join(base, 'config.json'));
      const out = run(makeSh({ 'rev-parse HEAD:config.json': 'same', 'describe --tags --always': 'v0.9.0' }));
      assert.deepEqual(out, ['code v0.9.0 → v2.0.0', 'restarted']);
      assert.ok(calls.some((c) => c.key.endsWith('checkout -q v2.0.0')));
    });

    test('config without a version: no git describe at all', () => {
      fs.writeFileSync(path.join(base, 'config.json'), '{"language":"he"}');
      run(makeSh());
      assert.deepEqual(calls, []);
    });

    test('config change and a new version together restart only once', () => {
      fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true });
      pin('v2.0.0', path.join(base, 'repo', 'config.json'));
      const out = run(makeSh({ 'rev-parse HEAD:config.json': (i) => `blob${i}`, 'describe --tags --always': 'v1.0.0' }));
      assert.deepEqual(out, ['config changed', 'code v1.0.0 → v2.0.0', 'restarted']);
      assert.equal(fakeLog().length, 1);
    });

    test('a failing checkout throws before npm ci and before the restart', () => {
      pin('v9.9.9');
      assert.throws(() => run(makeSh({ 'describe --tags --always': 'v1.0.0', 'checkout -q v9.9.9': new Error('unknown tag') })), /unknown tag/);
      assert.ok(!calls.some((c) => c.cmd === 'npm'));
      assert.deepEqual(fakeLog(), []);
    });

    test('a broken config.json throws (it is not swallowed)', () => {
      fs.writeFileSync(path.join(base, 'config.json'), '{broken');
      assert.throws(() => run(makeSh()), SyntaxError);
      assert.deepEqual(fakeLog(), []);
    });
  });
});

describe('main()', () => {
  test('no args, --help and -h return the usage', () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const out = main(args);
      assert.match(out, /^Usage: service\.js COMMAND/);
      for (const word of ['install', 'uninstall', 'status', 'restart', 'logs', 'update']) assert.ok(out.includes(word), word);
    }
  });

  test('an unknown command throws with the usage in the message', () => {
    assert.throws(() => main(['frobnicate']), (e) => /^unknown command frobnicate\nUsage: service\.js COMMAND/.test(e.message));
  });

  test('a near miss is still unknown (case sensitive)', () => {
    assert.throws(() => main(['Install']), /unknown command Install/);
    assert.throws(() => main(['--version']), /unknown command/);
  });
});
