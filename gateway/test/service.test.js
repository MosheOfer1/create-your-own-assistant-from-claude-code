import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
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

  test('there is only the gateway agent: old label/args/every options change nothing', () => {
    const t = plistText({ ...opts, label: 'update', args: ['x', 'update'], every: 300 });
    assert.equal(t, plistText(opts));
    assert.ok(!t.includes('local.assistant.update'));
    assert.ok(!t.includes('StartInterval'));
    assert.equal(t.split('<key>Label</key>').length - 1, 1);
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

describe('update()', () => {
  // sync and restartFn are injected: nothing real (git, systemctl, launchctl) is reached.
  const make = (result) => {
    const calls = { sync: [], restart: 0 };
    const sync = async (opts) => { calls.sync.push(opts); if (result instanceof Error) throw result; return result; };
    const restartFn = () => { calls.restart++; return 'restarted-by-fake'; };
    return { calls, sync, restartFn };
  };

  test('returns a Promise', async () => {
    const f = make('none');
    const p = update({ sync: f.sync, restartFn: f.restartFn });
    assert.ok(p instanceof Promise);
    await p;
  });

  test('sync says "restart": sync is forced, restartFn runs once, its result is returned', async () => {
    const f = make('restart');
    const out = await update({ base: '/b', app: '/a', sync: f.sync, restartFn: f.restartFn });
    assert.equal(out, 'restarted-by-fake');
    assert.deepEqual(f.calls.sync, [{ force: true }]);
    assert.equal(f.calls.restart, 1);
  });

  test('sync says "none": "up to date" and no restart', async () => {
    const f = make('none');
    const out = await update({ base: '/b', app: '/a', sync: f.sync, restartFn: f.restartFn });
    assert.equal(out, 'up to date');
    assert.deepEqual(f.calls.sync, [{ force: true }]);
    assert.equal(f.calls.restart, 0);
  });

  test('an async restartFn value is passed through', async () => {
    const out = await update({ sync: async () => 'restart', restartFn: async () => 'restarted later' });
    assert.equal(out, 'restarted later');
  });

  test('a throwing sync rejects update() and nothing is restarted', async () => {
    const f = make(new Error('boom'));
    await assert.rejects(update({ sync: f.sync, restartFn: f.restartFn }), /boom/);
    assert.equal(f.calls.restart, 0);
  });

  test('a throwing restartFn rejects update()', async () => {
    await assert.rejects(update({ sync: async () => 'restart', restartFn: () => { throw new Error('no systemd'); } }), /no systemd/);
  });

  test('default sync with a base that has no repo: "up to date" (real makeSync, nothing to pull)', async () => {
    const base = path.join(tmp, `u${++n}`, 'base');
    fs.mkdirSync(base, { recursive: true });
    let restarted = 0;
    const out = await update({ base, app: path.join(tmp, 'no-app'), restartFn: () => { restarted++; } });
    assert.equal(out, 'up to date');
    assert.equal(restarted, 0);
  });
});

describe('main()', () => {
  test('main() returns a Promise', async () => {
    const p = main([]);
    assert.ok(p instanceof Promise);
    await p;
  });

  test('no args, --help and -h resolve to the usage', async () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const out = await main(args);
      assert.match(out, /^Usage: service\.js COMMAND/);
      for (const word of ['install', 'uninstall', 'status', 'restart', 'logs', 'update']) assert.ok(out.includes(word), word);
    }
  });

  test('an unknown command rejects with the usage in the message', async () => {
    await assert.rejects(main(['frobnicate']), (e) => /^unknown command frobnicate\nUsage: service\.js COMMAND/.test(e.message));
  });

  test('a near miss is still unknown (case sensitive)', async () => {
    await assert.rejects(main(['Install']), /unknown command Install/);
    await assert.rejects(main(['--version']), /unknown command/);
  });

  test('the usage describes update as a manual pull and mentions no timer', async () => {
    const out = await main(['-h']);
    assert.match(out, /update\s+pull the private repo now/);
    assert.ok(!/timer|every \d|minutes/i.test(out));
  });
});
