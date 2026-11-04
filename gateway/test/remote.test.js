import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { CHECK, CLAUDE_SH, NODE_SH, checkoutScript, installScript, judge, main } from '../bin/remote.js';

let tmp;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-test-'))); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Text like CHECK prints on a healthy machine; `over` changes single lines.
const KEYS = ['os', 'cpus', 'ram_mb', 'node', 'git', 'claude', 'systemd_user', 'linger', 'userns_restricted'];
const healthy = (over = {}) => Object.entries({
  os: 'Linux 6.8.0-45-generic x86_64', cpus: '4', ram_mb: '3900', node: 'v22.23.0', git: 'git version 2.43.0', claude: '2.0.14 (Claude Code)',
  systemd_user: 'yes', linger: 'yes', userns_restricted: '0', ...over,
}).map(([k, v]) => `${k}: ${v}`).join('\n');

describe('judge()', () => {
  test('a healthy machine: ok, no problems, no notes', () => {
    const r = judge(healthy());
    assert.equal(r.ok, true);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.notes, []);
  });

  test('facts hold every line; values keep their colons and are trimmed', () => {
    const r = judge(`${healthy({ git: 'git version 2.43.0: extra:colon' })}\n`);
    assert.equal(r.facts.git, 'git version 2.43.0: extra:colon');
    assert.equal(r.facts.ram_mb, '3900');
    assert.deepEqual(Object.keys(r.facts), KEYS);
  });

  test('RAM below 1900 MB is a problem; 1900 is fine', () => {
    let r = judge(healthy({ ram_mb: '1899' }));
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /only 1899 MB RAM/);
    r = judge(healthy({ ram_mb: '1900' }));
    assert.equal(r.ok, true);
    assert.equal(judge(healthy({ ram_mb: '512' })).ok, false);
  });

  test('an empty ram_mb (awk failed) counts as too little', () => {
    const r = judge(healthy({ ram_mb: '' }));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /RAM/);
  });

  test('not Linux is a problem and names the OS', () => {
    const r = judge(healthy({ os: 'Darwin 23.4.0 arm64' }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems, ['not Linux (Darwin 23.4.0 arm64); use this computer instead']);
  });

  test('git missing is a problem', () => {
    const r = judge(healthy({ git: 'missing' }));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /git is missing/);
  });

  test('no systemd user session is a problem', () => {
    const r = judge(healthy({ systemd_user: 'no' }));
    assert.equal(r.ok, false);
    assert.match(r.problems[0], /no systemd user session/);
  });

  test('several problems are all reported', () => {
    const r = judge(healthy({ ram_mb: '1000', git: 'missing', systemd_user: 'no', os: 'Darwin 1 arm64' }));
    assert.equal(r.problems.length, 4);
    assert.equal(r.ok, false);
  });

  test('old node is a note, not a problem', () => {
    for (const node of ['v18.19.0', 'v21.9.9', 'missing', '']) {
      const r = judge(healthy({ node }));
      assert.equal(r.ok, true, node);
      assert.deepEqual(r.problems, [], node);
      assert.equal(r.notes.length, 1, node);
      assert.match(r.notes[0], /^node .*: Node 22\.\d+\.\d+ will be installed in ~\/\.local\/opt$/);
    }
    assert.deepEqual(judge(healthy({ node: 'v22.0.0' })).notes, []);
    assert.deepEqual(judge(healthy({ node: 'v24.1.0' })).notes, []);
  });

  test('missing claude is a note', () => {
    const r = judge(healthy({ claude: 'missing' }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.notes, ['Claude Code will be installed']);
  });

  test('linger other than yes is a note (no, or empty when loginctl is missing)', () => {
    for (const linger of ['no', '']) {
      const r = judge(healthy({ linger }));
      assert.equal(r.ok, true);
      assert.equal(r.notes.length, 1);
      assert.match(r.notes[0], /^linger is off: .*enable-linger/);
    }
  });

  test('userns_restricted 1 is a note; 0 is not', () => {
    const r = judge(healthy({ userns_restricted: '1' }));
    assert.equal(r.ok, true);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /restricts user namespaces/);
    assert.deepEqual(judge(healthy({ userns_restricted: '0' })).notes, []);
  });

  test('problems and notes at once: ok follows the problems only', () => {
    const r = judge(healthy({ ram_mb: '1000', node: 'v18.0.0', claude: 'missing', linger: 'no', userns_restricted: '1' }));
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.equal(r.notes.length, 4);
  });

  test('a missing ram_mb line is flagged as a problem', () => {
    const text = healthy().split('\n').filter((l) => !l.startsWith('ram_mb')).join('\n');
    assert.equal(judge(text).ok, false);
  });
});

describe('CHECK script', () => {
  const sh = (env, script = CHECK) => spawnSync('/bin/sh', ['-s'], { input: script, encoding: 'utf8', env, timeout: 30000 });
  const parse = (out) => out.trim().split('\n').map((l) => [l.split(':')[0], l.slice(l.indexOf(':') + 1).trim()]);

  test('is POSIX sh: runs under `sh -s` (read only) and prints every key exactly once, in order', () => {
    const r = sh({ PATH: process.env.PATH, HOME: tmp });
    assert.equal(r.status, 0, r.stderr);
    const rows = parse(r.stdout);
    assert.deepEqual(rows.map(([k]) => k), KEYS);
    assert.equal(new Set(rows.map(([k]) => k)).size, KEYS.length);
  });

  test('values are sane on this machine and judge() reads them', () => {
    const r = sh({ PATH: process.env.PATH, HOME: tmp });
    const v = Object.fromEntries(parse(r.stdout));
    assert.match(v.os, new RegExp(`^${os.type()} `));
    assert.match(v.cpus, /^\d+$/);
    if (os.platform() === 'linux') assert.match(v.ram_mb, /^\d+$/);
    assert.match(v.systemd_user, /^(yes|no)$/);
    assert.match(v.userns_restricted, /^\d+$/);
    const j = judge(r.stdout);
    assert.equal(typeof j.ok, 'boolean');
    assert.deepEqual(Object.keys(j.facts), KEYS);
  });

  test('tools that exist report their first version line; missing ones say "missing"', () => {
    // A PATH with a few real helpers and two fake tools: nothing else, so claude cannot be found.
    const bin = path.join(tmp, 'check-bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const t of ['uname', 'nproc', 'awk', 'head', 'cut', 'id', 'sort']) {
      const real = spawnSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
      if (real) fs.symlinkSync(real, path.join(bin, t));
    }
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v99.1.2\necho second line\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\necho "git version 9.9.9"\n', { mode: 0o755 });
    const home = path.join(tmp, 'check-home');
    fs.mkdirSync(home, { recursive: true });
    const r = sh({ PATH: bin, HOME: home });
    assert.equal(r.status, 0, r.stderr);
    const v = Object.fromEntries(parse(r.stdout));
    assert.equal(v.node, 'v99.1.2'); // only the first line
    assert.equal(v.git, 'git version 9.9.9');
    assert.equal(v.claude, 'missing');
    assert.deepEqual(Object.keys(v), KEYS);
    const j = judge(r.stdout);
    assert.ok(j.notes.some((x) => x === 'Claude Code will be installed'));
  });

  test('it only reads: running it creates nothing in HOME', () => {
    const home = path.join(tmp, 'check-home2');
    fs.mkdirSync(home, { recursive: true });
    sh({ PATH: process.env.PATH, HOME: home });
    assert.deepEqual(fs.readdirSync(home), []);
  });

  test('the script uses no sudo', () => {
    assert.ok(!/\bsudo\b/.test(CHECK));
  });
});

// main(): everything here either returns text or throws BEFORE any ssh. PATH is set to an empty
// directory, so even a mistake could not reach a real ssh binary (it would fail with ENOENT).
describe('main()', () => {
  const realPath = process.env.PATH;
  beforeEach(() => {
    const empty = path.join(tmp, 'empty-bin');
    fs.mkdirSync(empty, { recursive: true });
    process.env.PATH = empty;
  });
  afterEach(() => { process.env.PATH = realPath; });

  test('no args, --help and -h return the usage', () => {
    for (const args of [[], ['--help'], ['-h']]) {
      const out = main(args);
      assert.match(out, /^Usage: remote\.js COMMAND USER@HOST/);
      for (const w of ['check', 'install', 'login', 'logs']) assert.ok(out.includes(w), w);
    }
  });

  test('bad USER@HOST values throw before any ssh', () => {
    const bad = ['host', 'a b@c', 'u@h;rm', 'u@h;rm -rf ~', '@h', 'u@', '@', '', 'u@h h', 'u@h$(id)', 'u@h`id`', 'u@h|x', 'u@h&x', 'u@h\n', 'u @h', 'u@h:22', "u@h'x", 'u@h"x', 'u@@h', undefined];
    for (const host of bad) {
      for (const cmd of ['check', 'install', 'login', 'logs']) {
        assert.throws(() => main(host === undefined ? [cmd] : [cmd, host]), (e) => /^USER@HOST is required\nUsage: remote\.js/.test(e.message) && e.code === undefined, `${cmd} ${JSON.stringify(host)}`);
      }
    }
  });

  test('the host is checked before the command name is', () => {
    assert.throws(() => main(['bogus', 'nohost']), /^Error: USER@HOST is required/);
  });

  test('good hosts pass the check (unknown command is the only complaint)', () => {
    for (const host of ['dana@example.com', 'dana@10.0.0.5', 'a-b_c.d@host-1.local', 'root@localhost']) {
      assert.throws(() => main(['bogus', host]), (e) => e.message.startsWith('unknown command bogus\nUsage:'), host);
    }
  });

  test('login returns the ssh -t command, and runs nothing', () => {
    assert.equal(main(['login', 'dana@example.com']), "ssh -t dana@example.com '~/.local/bin/claude /login || claude /login'");
    assert.equal(main(['login', 'dana@10.0.0.5', '--version', 'v1']), "ssh -t dana@10.0.0.5 '~/.local/bin/claude /login || claude /login'");
  });

  test('login keeps --key: the printed command uses the same identity file', () => {
    const out = main(['login', 'dana@example.com', '--key', '/k/id']);
    assert.match(out, /^ssh -t -i \/k\/id dana@example\.com /);
  });

  test('a USER@HOST that starts with "-" is not accepted (it would reach ssh as an option)', () => {
    assert.throws(() => main(['login', '-v@example.com']), /USER@HOST is required/);
  });

  test('an unknown command with a good host throws and lists the usage', () => {
    assert.throws(() => main(['frobnicate', 'dana@example.com']), (e) => /^unknown command frobnicate\nUsage: remote\.js/.test(e.message));
  });
});

describe('main() own-user', () => {
  const INNER = `'N=$(command -v node || echo ~/.local/opt/node22/bin/node); sudo "$N" ~/.assistant/app/gateway/bin/own-user.js install'`;

  test('returns the ssh -t command that runs sudo with own-user.js install, and runs nothing', () => {
    const out = main(['own-user', 'dana@example.com']);
    assert.equal(out, `ssh -t dana@example.com ${INNER}`);
    assert.ok(out.includes('sudo "$N" ~/.assistant/app/gateway/bin/own-user.js install'));
  });

  test('--key puts -i <key> between -t and the host', () => {
    const out = main(['own-user', 'dana@example.com', '--key', '/k/id']);
    assert.equal(out, `ssh -t -i /k/id dana@example.com ${INNER}`);
  });

  test('a bad host or key is refused before anything is printed', () => {
    assert.throws(() => main(['own-user']), /USER@HOST is required/);
    assert.throws(() => main(['own-user', '-v@example.com']), /USER@HOST is required/);
    assert.throws(() => main(['own-user', 'dana@example.com', '--key', 'a b']), /not a valid key/);
  });

  test('the usage lists the own-user command', () => {
    assert.match(main(['--help']), /^\s*own-user /m);
  });
});

// The pieces of the install script, run for real under /bin/sh with a fake curl (no network):
// curl copies files from a local folder and logs the URLs it was asked for.
describe('install script pieces', () => {
  let n = 0;
  const which = (t) => spawnSync('/bin/sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
  // A PATH with only these tools (no real curl, node or claude) plus the fakes.
  function sandbox() {
    const d = path.join(tmp, `pieces${++n}`);
    const bin = path.join(d, 'bin');
    const files = path.join(d, 'files');
    const home = path.join(d, 'home');
    for (const x of [bin, files, home]) fs.mkdirSync(x, { recursive: true });
    for (const t of ['sh', 'bash', 'tar', 'xz', 'awk', 'sha256sum', 'mktemp', 'mkdir', 'rm', 'mv', 'cp', 'cat', 'basename', 'git', 'grep', 'head', 'touch', 'chmod']) {
      const real = which(t);
      if (real) fs.symlinkSync(real, path.join(bin, t));
    }
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho x86_64\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
out=; url=
while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift 2;; -*) shift;; *) url=$1; shift;; esac; done
echo "$url" >> "$FAKE_LOG"
src="$FAKE_FILES/$(basename "$url")"
[ -f "$src" ] || exit 22
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
`, { mode: 0o755 });
    const log = path.join(d, 'curl.log');
    const run = (script) => spawnSync('/bin/sh', ['-s'], { input: `set -e\n${script}\n`, encoding: 'utf8', timeout: 30000, env: { PATH: bin, HOME: home, FAKE_FILES: files, FAKE_LOG: log } });
    const urls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
    return { d, bin, files, home, run, urls };
  }
  const NAME = `node-v${/v(\d+\.\d+\.\d+)/.exec(NODE_SH)[1]}-linux-x64`;
  // A Node tarball like nodejs.org's (one folder, bin/node), and its SHASUMS256.txt.
  function nodeFiles(s, { hash } = {}) {
    const src = path.join(s.d, 'build', NAME, 'bin');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'node'), '#!/bin/sh\necho v22.99.0\n', { mode: 0o755 });
    const tarball = path.join(s.files, `${NAME}.tar.xz`);
    const r = spawnSync('tar', ['-C', path.join(s.d, 'build'), '-cJf', tarball, NAME]);
    assert.equal(r.status, 0, String(r.stderr));
    const real = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const lines = [`${'0'.repeat(64)}  node-v0.0.0-linux-x64.tar.xz`];
    if (hash !== null) lines.push(`${hash ?? real}  ${NAME}.tar.xz`);
    fs.writeFileSync(path.join(s.files, 'SHASUMS256.txt'), `${lines.join('\n')}\n`);
  }
  const skip = (!which('xz') || !which('sha256sum')) && 'xz or sha256sum is missing';

  test('Node: a tarball that matches SHASUMS256.txt is unpacked to ~/.local/opt/node22', { skip }, () => {
    const s = sandbox();
    nodeFiles(s);
    const r = s.run(NODE_SH);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(s.home, '.local', 'opt', 'node22', 'bin', 'node')));
    const base = `https://nodejs.org/dist/${/v\d+\.\d+\.\d+/.exec(NODE_SH)[0]}`;
    assert.deepEqual(s.urls(), [`${base}/${NAME}.tar.xz`, `${base}/SHASUMS256.txt`]);
  });

  test('Node: a tarball that does not match is refused, nothing is unpacked', { skip }, () => {
    const s = sandbox();
    nodeFiles(s, { hash: 'f'.repeat(64) });
    const r = s.run(NODE_SH);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not match nodejs\.org's SHASUMS256\.txt/);
    assert.equal(fs.existsSync(path.join(s.home, '.local', 'opt')), false);
  });

  test('Node: a SHASUMS256.txt without a line for the tarball is refused too', { skip }, () => {
    const s = sandbox();
    nodeFiles(s, { hash: null });
    const r = s.run(NODE_SH);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /does not match/);
    assert.equal(fs.existsSync(path.join(s.home, '.local', 'opt')), false);
  });

  test('Node: a failed download stops the script', { skip }, () => {
    const s = sandbox(); // no files: curl exits 22
    const r = s.run(`${NODE_SH}\necho still-running`);
    assert.notEqual(r.status, 0);
    assert.ok(!r.stdout.includes('still-running'));
  });

  test('Claude Code: the installer is saved to a file and run from there (no pipe)', () => {
    assert.ok(!/\|\s*(ba)?sh\b/.test(CLAUDE_SH), 'curl ... | bash');
    const s = sandbox();
    fs.writeFileSync(path.join(s.files, 'install.sh'), 'mkdir -p "$HOME/.local/bin"; printf "%s" "$0" > "$HOME/ran-from"; touch "$HOME/.local/bin/claude"; chmod +x "$HOME/.local/bin/claude"\n');
    const r = s.run(CLAUDE_SH);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(s.urls(), ['https://claude.ai/install.sh']);
    assert.match(fs.readFileSync(path.join(s.home, 'ran-from'), 'utf8'), /\/install\.sh$/); // bash got a file, not stdin
    assert.ok(fs.existsSync(path.join(s.home, '.local', 'bin', 'claude')));
  });

  test('Claude Code: a failed download stops the script, no installer runs', () => {
    const s = sandbox(); // no install.sh: curl exits 22
    const r = s.run(`${CLAUDE_SH}\necho still-running`);
    assert.notEqual(r.status, 0);
    assert.ok(!r.stdout.includes('still-running'));
  });

  test('Claude Code: already there in ~/.local/bin, nothing is downloaded', () => {
    const s = sandbox();
    fs.mkdirSync(path.join(s.home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(s.home, '.local', 'bin', 'claude'), '', { mode: 0o755 });
    assert.equal(s.run(CLAUDE_SH).status, 0);
    assert.deepEqual(s.urls(), []);
  });

  // A local "public repo" with tags; the app is a clone of it (git fetch stays on this disk).
  function repo(tags) {
    const s = sandbox();
    const env = { ...process.env, HOME: s.home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...a) => { const r = spawnSync('git', a, { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
    const origin = path.join(s.d, 'origin');
    git('init', '-q', '-b', 'main', origin);
    const at = {};
    for (const t of [...tags, null]) { // a last commit on main after every tag
      git('-C', origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', t || 'tip');
      if (t) { git('-C', origin, 'tag', t); at[t] = git('-C', origin, 'rev-parse', 'HEAD'); }
    }
    at.main = git('-C', origin, 'rev-parse', 'HEAD');
    const A = path.join(s.d, 'A');
    git('clone', '-q', origin, path.join(A, 'app'));
    const run = (version) => spawnSync('/bin/sh', ['-s'], { input: `set -e\nA='${A}'\n${checkoutScript(version)}\n`, encoding: 'utf8', env, timeout: 30000 });
    const head = () => git('-C', path.join(A, 'app'), 'rev-parse', 'HEAD');
    return { at, run, head };
  }

  test('no --version: the newest release tag by number (v1.10.0 over v1.9.0), not main, not an rc', () => {
    const g = repo(['v1.2.0', 'v1.10.0', 'v1.9.0', 'v2.0.0-rc1', 'latest']);
    const r = g.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'version: v1.10.0');
    assert.equal(g.head(), g.at['v1.10.0']);
  });

  test('no --version and no release tag: main, and it says so', () => {
    const g = repo(['latest']);
    const r = g.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'version: main (the repo has no release tag yet)');
    assert.equal(g.head(), g.at.main);
  });

  test('--version wins over the newest tag', () => {
    const g = repo(['v1.2.0', 'v1.3.0']);
    const r = g.run('v1.2.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'version: v1.2.0');
    assert.equal(g.head(), g.at['v1.2.0']);
  });

  test('a --version with shell characters never reaches the script', () => {
    for (const v of ["v1'; id; '", '$(id)', '-x', 'a b']) assert.throws(() => checkoutScript(v), /not a valid version/, v);
  });

  test('the whole script: no curl | sh, the checksum check, npm ci without install scripts', () => {
    for (const script of [installScript({}), installScript({ version: 'v1.0.0', repoUrl: 'git@github.com:a/b.git' })]) {
      assert.ok(!/\|\s*(ba)?sh\b/.test(script), 'a pipe into a shell');
      assert.ok(script.includes(NODE_SH) && script.includes(CLAUDE_SH));
      assert.match(script, /sha256sum -c/);
      assert.match(script, /npm ci --omit=dev --ignore-scripts /);
      assert.ok(!/checkout -q main\b/.test(script), 'main only as the fallback inside the script');
    }
  });
});
