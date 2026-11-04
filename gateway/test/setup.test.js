import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { parseEnv, promisify } from 'node:util';
import { STEPS, setEnv } from '../bin/setup.js';

const exec = promisify(execFile);
const SETUP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'setup.js');

let tmp;
let n = 0;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fresh assistant home (not created yet, so the tool makes it) and a fresh HOME per test.
function sandbox() {
  const root = path.join(tmp, `s${++n}`);
  const home = path.join(root, 'home'); // ASSISTANT_HOME
  const userHome = path.join(root, 'user'); // HOME
  fs.mkdirSync(userHome, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: userHome, ASSISTANT_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(userHome, '.gitconfig'),
    BROWSE_CHROME: '/nonexistent/fake-chrome', // so `check` never starts playwright
  };
  // Runs setup.js as a child process; never throws, returns { code, out, err }.
  const run = async (...args) => {
    try { const r = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', SETUP, ...args], { env, encoding: 'utf8' }); return { code: 0, out: r.stdout, err: r.stderr }; } catch (e) { return { code: e.code, out: e.stdout, err: e.stderr }; }
  };
  return { root, home, userHome, env, run, file: (...p) => path.join(home, ...p) };
}
const mode = (f) => fs.statSync(f).mode & 0o777;

describe('usage and errors', () => {
  test('no args prints the usage and exits 0', async () => {
    const s = sandbox();
    const r = await s.run();
    assert.equal(r.code, 0);
    assert.match(r.out, /^Usage: setup\.js COMMAND/);
    assert.match(r.out, /status/);
    assert.ok(!fs.existsSync(s.home), 'usage creates nothing');
  });

  test('--help and -h print the usage, exit 0', async () => {
    const s = sandbox();
    for (const flag of ['--help', '-h']) {
      const r = await s.run(flag);
      assert.equal(r.code, 0);
      assert.match(r.out, /^Usage: setup\.js COMMAND/);
    }
  });

  test('an unknown command exits 1 with an ERROR: line on stderr', async () => {
    const r = await sandbox().run('frobnicate');
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /^ERROR: unknown command frobnicate\n$/); // only the first line of the message
  });
});

describe('mark and status', () => {
  test('fresh status: nothing done, next is the first step', async () => {
    const r = await sandbox().run('status');
    assert.equal(r.code, 0);
    const lines = r.out.trimEnd().split('\n');
    assert.equal(lines.length, STEPS.length + 1);
    assert.equal(lines[0], '  language');
    assert.equal(lines.at(-1), `next: ${STEPS[0]}`);
  });

  test('done shows a check mark and moves "next" on; skipped shows a dash', async () => {
    const s = sandbox();
    assert.equal((await s.run('mark', 'language', 'done')).out.trim(), 'language: done');
    assert.equal((await s.run('mark', 'plan', 'skipped', 'not', 'now')).out.trim(), 'plan: skipped');
    const r = await s.run('status');
    const lines = r.out.trimEnd().split('\n');
    assert.equal(lines[0], '✔ language');
    assert.equal(lines[1], '– plan (not now)');
    assert.equal(lines[2], '  prereqs');
    assert.equal(lines.at(-1), 'next: prereqs');
  });

  test('a done step with a note shows the note; "next" is the first MISSING step, not the last done', async () => {
    const s = sandbox();
    await s.run('mark', 'prereqs', 'done', 'all', 'good');
    const r = await s.run('status');
    assert.match(r.out, /✔ prereqs \(all good\)/);
    assert.match(r.out.trimEnd(), /next: language$/);
  });

  test('clear removes a step again', async () => {
    const s = sandbox();
    await s.run('mark', 'language', 'done');
    assert.equal((await s.run('mark', 'language', 'clear')).out.trim(), 'language: clear');
    assert.match((await s.run('status')).out, /^ {2}language/);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.file('setup.json'), 'utf8')), {});
  });

  test('setup.json keeps status, an ISO time and the note', async () => {
    const s = sandbox();
    await s.run('mark', 'host', 'done', 'my', 'laptop');
    const st = JSON.parse(fs.readFileSync(s.file('setup.json'), 'utf8'));
    assert.equal(st.host.status, 'done');
    assert.equal(st.host.note, 'my laptop');
    assert.equal(new Date(st.host.at).toISOString(), st.host.at);
  });

  test('all steps done: next says nothing is left', async () => {
    const s = sandbox();
    for (const step of STEPS) await s.run('mark', step, 'done');
    const r = await s.run('status');
    assert.match(r.out, /next: nothing, all steps are done\n$/);
    assert.ok(!r.out.split('\n').slice(0, -2).some((l) => l.startsWith(' ')), 'every step line has a mark');
  });

  test('all steps skipped counts as complete too', async () => {
    const s = sandbox();
    for (const step of STEPS) await s.run('mark', step, 'skipped');
    assert.match((await s.run('status')).out, /next: nothing/);
  });

  test('unknown step, unknown status and missing args are errors', async () => {
    const s = sandbox();
    for (const args of [['mark', 'nope', 'done'], ['mark', 'language', 'maybe'], ['mark', 'language'], ['mark']]) {
      const r = await s.run(...args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /^ERROR: mark STEP done\|skipped\|clear\n$/);
    }
    assert.ok(!fs.existsSync(s.file('setup.json')), 'nothing was written');
  });

  test('a corrupt setup.json is treated as empty', async () => {
    const s = sandbox();
    fs.mkdirSync(s.home, { recursive: true });
    fs.writeFileSync(s.file('setup.json'), '{not json');
    const r = await s.run('status');
    assert.equal(r.code, 0);
    assert.match(r.out.trimEnd(), /next: language$/);
  });
});

describe('get and set', () => {
  test('get on an empty home is {} and a missing key is null', async () => {
    const s = sandbox();
    assert.deepEqual(JSON.parse((await s.run('get')).out), {});
    assert.equal((await s.run('get', 'nope')).out.trim(), 'null');
    assert.equal((await s.run('get', 'a.b.c')).out.trim(), 'null');
  });

  test('set with a plain string (not JSON) stores the string', async () => {
    const s = sandbox();
    const r = await s.run('set', 'ownerName', 'Dana');
    assert.equal(r.out.trim(), 'ownerName = "Dana"');
    assert.equal((await s.run('get', 'ownerName')).out.trim(), '"Dana"');
  });

  test('set with JSON values: string, number, bool, array, object, null', async () => {
    const s = sandbox();
    await s.run('set', 'language', '"he"');
    await s.run('set', 'warmIdleMin', '45');
    await s.run('set', 'freeShell', 'true');
    await s.run('set', 'tools', '["Bash","Read"]');
    await s.run('set', 'extra', '{"a":1}');
    const c = JSON.parse((await s.run('get')).out);
    assert.deepEqual(c, { language: 'he', warmIdleMin: 45, freeShell: true, tools: ['Bash', 'Read'], extra: { a: 1 } });
    await s.run('set', 'extra', 'null'); // null removes the key
    assert.ok(!('extra' in JSON.parse((await s.run('get')).out)));
  });

  test('nested keys create objects and keep their siblings', async () => {
    const s = sandbox();
    await s.run('set', 'modules.email.user', 'dana@example.com');
    await s.run('set', 'modules.email.host', 'imap.example.com');
    await s.run('set', 'modules.brain.push', 'true');
    assert.deepEqual(JSON.parse((await s.run('get')).out), {
      modules: { email: { user: 'dana@example.com', host: 'imap.example.com' }, brain: { push: true } },
    });
    assert.equal((await s.run('get', 'modules.email.user')).out.trim(), '"dana@example.com"');
    assert.deepEqual(JSON.parse((await s.run('get', 'modules.email')).out), { user: 'dana@example.com', host: 'imap.example.com' });
  });

  test('set over a non-object value replaces it with an object', async () => {
    const s = sandbox();
    await s.run('set', 'modules', '"x"');
    await s.run('set', 'modules.email.user', 'Dana');
    assert.deepEqual(JSON.parse((await s.run('get', 'modules')).out), { email: { user: 'Dana' } });
  });

  test('set without a value or key is an error', async () => {
    const s = sandbox();
    for (const args of [['set'], ['set', 'language']]) {
      const r = await s.run(...args);
      assert.equal(r.code, 1);
      assert.match(r.err, /^ERROR: set KEY JSON/);
    }
  });

  test('set refuses keys with a secret name, any case, also nested', async () => {
    const s = sandbox();
    for (const key of ['EMAIL_APP_PASSWORD', 'TELEGRAM_BOT_TOKEN', 'TRANSCRIBE_API_KEY', 'ANTHROPIC_API_KEY', 'email_app_password', 'Telegram_Bot_Token', 'modules.email.anthropic_api_key', 'x.TELEGRAM_BOT_TOKEN.y']) {
      const r = await s.run('set', key, 'hunter2-fake');
      assert.equal(r.code, 1, key);
      assert.match(r.err, /^ERROR: secrets go through `secret`/);
    }
    assert.ok(!fs.existsSync(s.file('config.json')), 'config.json never written');
    const files = fs.existsSync(s.home) ? fs.readdirSync(s.home) : [];
    for (const f of files) if (fs.statSync(s.file(f)).isFile()) assert.ok(!fs.readFileSync(s.file(f), 'utf8').includes('hunter2-fake'), `${f} has no secret`);
  });

  test('ASSISTANT_HOME is respected: config.json lands in the base dir', async () => {
    const s = sandbox();
    await s.run('set', 'language', '"he"');
    assert.ok(fs.existsSync(s.file('config.json')));
    assert.ok(!fs.existsSync(path.join(s.userHome, '.assistant')), 'the real-home default is not touched');
  });
});

describe('files, modes and the log', () => {
  test('config.json, setup.json, setup.log are 0600 and the base dir is 0700', async () => {
    const s = sandbox();
    await s.run('set', 'language', '"he"');
    await s.run('mark', 'language', 'done');
    for (const f of ['config.json', 'setup.json', 'setup.log']) assert.equal(mode(s.file(f)), 0o600, f);
    assert.equal(mode(s.home), 0o700);
  });

  test('log lines start with an ISO time and `log` appends text', async () => {
    const s = sandbox();
    assert.equal((await s.run('log', 'hello', 'Dana')).out.trim(), 'logged');
    await s.run('mark', 'plan', 'done', 'note');
    await s.run('set', 'language', '"he"');
    const lines = fs.readFileSync(s.file('setup.log'), 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 3);
    for (const l of lines) assert.match(l, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
    assert.match(lines[0], / hello Dana$/);
    assert.match(lines[1], / step plan: done \(note\)$/);
    assert.match(lines[2], / config language set$/);
  });

  test('set logs the key but never the value', async () => {
    const s = sandbox();
    await s.run('set', 'modules.email.user', 'dana-private@example.com');
    const log = fs.readFileSync(s.file('setup.log'), 'utf8');
    assert.match(log, /config modules\.email\.user set/);
    assert.ok(!log.includes('dana-private'));
  });

  test('a refused secret key leaves no trace of the value in any file', async () => {
    const s = sandbox();
    await s.run('mark', 'language', 'done');
    await s.run('set', 'EMAIL_APP_PASSWORD', 'abcd-efgh-fake');
    for (const f of fs.readdirSync(s.home)) assert.ok(!fs.readFileSync(s.file(f), 'utf8').includes('abcd-efgh-fake'), f);
  });
});

describe('has and setEnv', () => {
  test('has says no without a .env, and no for a name that is not there', async () => {
    const s = sandbox();
    assert.equal((await s.run('has', 'TELEGRAM_BOT_TOKEN')).out.trim(), 'no');
    fs.mkdirSync(s.file('data'), { recursive: true });
    fs.writeFileSync(s.file('data', '.env'), 'OTHER="x"\n');
    assert.equal((await s.run('has', 'TELEGRAM_BOT_TOKEN')).out.trim(), 'no');
  });

  test('has says yes after the .env is written, and never prints the value', async () => {
    const s = sandbox();
    fs.mkdirSync(s.file('data'), { recursive: true });
    fs.writeFileSync(s.file('data', '.env'), 'TELEGRAM_BOT_TOKEN="fake-token-123"\nEMAIL_APP_PASSWORD="x"\n');
    const r = await s.run('has', 'TELEGRAM_BOT_TOKEN');
    assert.equal(r.out.trim(), 'yes');
    assert.ok(!r.out.includes('fake-token'));
    assert.equal((await s.run('has', 'EMAIL_APP_PASSWORD')).out.trim(), 'yes');
  });

  test('has matches the whole name, not a prefix', async () => {
    const s = sandbox();
    fs.mkdirSync(s.file('data'), { recursive: true });
    fs.writeFileSync(s.file('data', '.env'), 'TELEGRAM_BOT_TOKEN_OLD="x"\n');
    assert.equal((await s.run('has', 'TELEGRAM_BOT_TOKEN')).out.trim(), 'no');
  });

  describe('setEnv', () => {
    let dir;
    beforeEach(() => { dir = path.join(tmp, `env${++n}`); });

    test('creates the file 0600 and the folder 0700', () => {
      const f = path.join(dir, 'data', '.env');
      setEnv(f, 'ANTHROPIC_API_KEY', 'sk-fake');
      assert.equal(mode(f), 0o600);
      assert.equal(mode(path.dirname(f)), 0o700);
      assert.deepEqual({ ...parseEnv(fs.readFileSync(f, 'utf8')) }, { ANTHROPIC_API_KEY: 'sk-fake' });
    });

    test('replaces an existing key, keeps the others, ends with a newline', () => {
      const f = path.join(dir, '.env');
      setEnv(f, 'A', '1');
      setEnv(f, 'B', '2');
      setEnv(f, 'A', '3');
      assert.deepEqual({ ...parseEnv(fs.readFileSync(f, 'utf8')) }, { B: '2', A: '3' });
      assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('A=')).length, 1);
      assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
    });

    test('does not touch a key that merely starts with the same letters', () => {
      const f = path.join(dir, '.env');
      setEnv(f, 'KEY_LONG', 'x');
      setEnv(f, 'KEY', 'y');
      assert.deepEqual({ ...parseEnv(fs.readFileSync(f, 'utf8')) }, { KEY_LONG: 'x', KEY: 'y' });
    });

    test('an existing loose (0644) .env ends up 0600 after setEnv', () => {
      const f = path.join(dir, '.env');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, 'A="1"\n');
      fs.chmodSync(f, 0o644);
      setEnv(f, 'B', '2');
      assert.equal(mode(f), 0o600);
    });

    const roundTrip = (name, value, opts = {}) => test(`round trip through parseEnv: ${name}`, opts, () => {
      const f = path.join(dir, '.env');
      setEnv(f, 'SECRET', value);
      assert.equal(parseEnv(fs.readFileSync(f, 'utf8')).SECRET, value);
    });
    roundTrip('plain', 'abc123');
    roundTrip('with spaces', 'a b  c');
    roundTrip('with a hash', 'abc # not a comment');
    roundTrip('with an equals sign', 'a=b=c');
    roundTrip('with single quotes', "it's Dana's");
    test('a value with a line break is refused (the .env format cannot hold it safely)', () => {
      assert.throws(() => setEnv(path.join(dir, '.env'), 'SECRET', 'line1\nline2'), /line break/);
    });
    roundTrip('with a double quote', 'say "hi"');
    roundTrip('with a backslash', 'C:\\temp\\x');
    roundTrip('empty', '');
    roundTrip('a number given as a string', '42');

    test('loadEnvFile reads the same values (the gateway uses loadEnvFile)', () => {
      const f = path.join(dir, '.env');
      setEnv(f, 'DANA_FAKE_ENV_NAME', 'a b c');
      const prev = process.env.DANA_FAKE_ENV_NAME;
      try {
        process.loadEnvFile(f);
        assert.equal(process.env.DANA_FAKE_ENV_NAME, 'a b c');
      } finally {
        if (prev === undefined) delete process.env.DANA_FAKE_ENV_NAME; else process.env.DANA_FAKE_ENV_NAME = prev;
      }
    });
  });
});

describe('with a private repo', () => {
  const gitEnv = (cwd) => ({ PATH: process.env.PATH, HOME: path.dirname(cwd), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
  const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { env: gitEnv(cwd), encoding: 'utf8' }).then((r) => r.stdout);

  async function repoSandbox(initial = { language: 'en' }) {
    const s = sandbox();
    const repo = s.file('repo');
    fs.mkdirSync(repo, { recursive: true });
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'Dana Test');
    await git(repo, 'config', 'user.email', 'dana@example.com');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'config.json'), `${JSON.stringify(initial)}\n`);
    await git(repo, 'add', 'config.json');
    await git(repo, 'commit', '-q', '-m', 'init');
    return { s, repo };
  }

  test('set writes the repo config.json (not <base>/config.json) and commits "setup: <key>"', async () => {
    const { s, repo } = await repoSandbox();
    const r = await s.run('set', 'modules.email.user', 'dana@example.com');
    assert.equal(r.code, 0, r.err);
    assert.ok(!fs.existsSync(s.file('config.json')), 'no stray base config.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8')), { language: 'en', modules: { email: { user: 'dana@example.com' } } });
    const log = (await git(repo, 'log', '--format=%s')).trim().split('\n');
    assert.deepEqual(log, ['setup: modules.email.user', 'init']);
    assert.equal((await git(repo, 'status', '--porcelain')).trim(), '', 'tree is clean');
  });

  test('get reads the repo config', async () => {
    const { s } = await repoSandbox({ language: 'he', ownerName: 'Dana' });
    assert.equal((await s.run('get', 'ownerName')).out.trim(), '"Dana"');
  });

  test('each set makes its own commit', async () => {
    const { s, repo } = await repoSandbox();
    await s.run('set', 'ownerName', 'Dana');
    await s.run('set', 'language', '"he"');
    assert.deepEqual((await git(repo, 'log', '--format=%s')).trim().split('\n'), ['setup: language', 'setup: ownerName', 'init']);
  });

  test('a refused secret key makes no commit', async () => {
    const { s, repo } = await repoSandbox();
    const r = await s.run('set', 'TELEGRAM_BOT_TOKEN', 'x');
    assert.equal(r.code, 1);
    assert.equal((await git(repo, 'rev-list', '--count', 'HEAD')).trim(), '1');
  });

  test('setting the same value twice is safe to run again', async () => {
    const { s } = await repoSandbox();
    assert.equal((await s.run('set', 'ownerName', 'Dana')).code, 0);
    const again = await s.run('set', 'ownerName', 'Dana');
    assert.equal(again.code, 0, again.err);
  });

  test('a repo dir without config.json falls back to <base>/config.json (no commit)', async () => {
    const s = sandbox();
    fs.mkdirSync(s.file('repo'), { recursive: true });
    await git(s.file('repo'), 'init', '-q');
    const r = await s.run('set', 'language', '"he"');
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(s.file('config.json')));
    assert.ok(!fs.existsSync(s.file('repo', 'config.json')));
  });

  test('repo push without a remote fails with an ERROR (nothing is sent anywhere)', async () => {
    const { s } = await repoSandbox();
    const r = await s.run('repo', 'push');
    assert.equal(r.code, 1);
    assert.match(r.err, /^ERROR: /);
  });

  test('repo create validates the name first (only invalid names here: no gh call)', async () => {
    const s = sandbox();
    for (const args of [['repo', 'create'], ['repo', 'create', 'a b'], ['repo', 'create', 'x;y'], ['repo', 'create', ''], ['repo', 'bogus'], ['repo']]) {
      const r = await s.run(...args);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, /^ERROR: repo create NAME \| repo push\n$/);
    }
  });
});

describe('check, secret, whatsapp', () => {
  test('check prints one "name: value" line per tool, in order', async () => {
    const r = await sandbox().run('check');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.split(':')[0]), ['os', 'node', 'git', 'gh', 'claude', 'ffmpeg', 'whisper', 'chrome']);
    for (const l of lines) assert.match(l, /^[a-z]+: \S/);
    assert.match(lines[0], new RegExp(`^os: ${os.platform()} \\S+ ${os.arch()}, \\d+ GB RAM$`));
    assert.equal(lines[7], 'chrome: /nonexistent/fake-chrome'); // BROWSE_CHROME is honoured
  });

  test('the node line says "too old" only when the major version is below 22', async () => {
    const r = await sandbox().run('check');
    const node = r.out.split('\n').find((l) => l.startsWith('node:'));
    assert.match(node, /^node: (missing|v\d+\.\d+\.\d+.*)$/);
    // `node` on PATH is what the tool inspects (not process.execPath).
    const { stdout } = await exec('node', ['--version']).catch(() => ({ stdout: '' }));
    const major = Number(stdout.trim().replace(/^v/, '').split('.')[0]);
    if (stdout) assert.equal(/ {2}\(too old: needs 22\+\)$/.test(node), major < 22, node);
    else assert.equal(node, 'node: missing');
  });

  test('a tool that is not on PATH shows as "missing"', async () => {
    const s = sandbox();
    s.env.PATH = path.join(s.root, 'empty-bin'); // nothing on PATH at all
    const r = await s.run('check');
    assert.equal(r.code, 0, r.err);
    for (const k of ['node', 'git', 'gh', 'claude', 'ffmpeg', 'whisper']) assert.match(r.out, new RegExp(`^${k}: missing$`, 'm'));
  });

  test('secret with an unknown name is an error (no window)', async () => {
    const s = sandbox();
    for (const name of ['NOT_A_SECRET', 'email_app_password']) {
      const r = await s.run('secret', name, '--url', 'http://localhost:1/x', '--say', 'hi');
      assert.equal(r.code, 1, name);
      assert.match(r.err, /^ERROR: unknown secret .*; one of EMAIL_APP_PASSWORD, TELEGRAM_BOT_TOKEN, TRANSCRIBE_API_KEY, ANTHROPIC_API_KEY\n$/, name);
    }
    const none = await s.run('secret');
    assert.equal(none.code, 1);
    assert.match(none.err, /unknown secret undefined/);
    assert.ok(!fs.existsSync(s.file('data', '.env')));
  });

  test('whatsapp without both numbers is an error', async () => {
    const s = sandbox();
    let r = await s.run('whatsapp');
    assert.equal(r.code, 1);
    assert.match(r.err, /^ERROR: set channels\.whatsapp\.assistantNumber and ownerNumber first\n$/);
    await s.run('set', 'channels.whatsapp.assistantNumber', '"972500000001"');
    r = await s.run('whatsapp');
    assert.equal(r.code, 1);
    assert.match(r.err, /ownerNumber first/);
    assert.ok(!fs.existsSync(s.file('data', 'whatsapp-auth')), 'no pairing started');
  });
});
