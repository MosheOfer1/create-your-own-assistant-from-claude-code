// Tests for scripts/scrub-scan.mjs. Zero deps; every test uses its own temp git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePatterns, scanText } from '../scripts/scrub-scan.mjs';

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'scrub-scan.mjs');
const PATTERNS = ['Zorblax', '0501234567', 're:\\bacme\\b'].join('\n');

// A fresh repo plus a pattern file kept outside of it.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'scrub-test-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const patFile = join(root, 'patterns.txt');
  mkdirSync(repo);
  mkdirSync(home);
  writeFileSync(patFile, PATTERNS);
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of ['SCRUB_PATTERNS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8' });
  const git = (...args) => {
    const r = sh('git', args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  return {
    git,
    patFile,
    put: (name, data) => writeFileSync(join(repo, name), data),
    scan: (...args) => sh('node', [SCANNER, '--patterns', patFile, ...args]),
    raw: (...args) => sh('node', [SCANNER, ...args]),
  };
}

test('literal in a tracked file: found case-insensitively, output is masked', () => {
  const t = setup();
  t.put('notes.txt', 'ok line\nmy friend ZORBLAX lives here\n');
  t.git('add', 'notes.txt');
  const r = t.scan();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /notes\.txt:2:11/);
  assert.match(r.stdout, /"ZO\*+"/);
  assert.doesNotMatch(r.stdout + r.stderr, /zorblax/i);
});

test('phone number matches with separators; regex respects word boundaries', () => {
  const t = setup();
  t.put('a.txt', 'call 050-123 4567 now\n');
  t.put('b.txt', 'works at Acme corp\n');
  t.put('c.txt', 'uses acmesuite daily\n');
  const r = t.scan();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a\.txt:1/);
  assert.match(r.stdout, /b\.txt:1/);
  assert.doesNotMatch(r.stdout, /c\.txt/);
});

test('planted string in a file name is found', () => {
  const t = setup();
  t.put('zorblax-plan.txt', 'harmless content\n');
  const r = t.scan();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\(path\) zorblax-plan\.txt/);
});

test('clean repo exits 0; binary file with NUL bytes is skipped', () => {
  const t = setup();
  t.put('clean.txt', 'nothing to see\n');
  assert.equal(t.scan().status, 0);
  t.put('blob.bin', Buffer.concat([Buffer.from('Zorblax'), Buffer.from([0, 1, 2])]));
  const r = t.scan();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stderr, /clean/);
});

test('--staged reports staged content only', () => {
  const t = setup();
  t.put('staged.txt', 'Zorblax\n');
  t.put('untracked.txt', 'Zorblax\n');
  t.git('add', 'staged.txt');
  const r = t.scan('--staged');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^staged\.txt:1/m);
  assert.doesNotMatch(r.stdout, /untracked/);
  // Staged blob is clean, working copy is dirty: --staged stays clean, default mode hits.
  const u = setup();
  u.put('f.txt', 'fine\n');
  u.git('add', 'f.txt');
  u.put('f.txt', 'Zorblax\n');
  assert.equal(u.scan('--staged').status, 0);
  assert.equal(u.scan().status, 1);
});

test('--history finds deleted content, commit messages and author names', () => {
  const deleted = setup();
  deleted.put('old.txt', 'secret Zorblax\n');
  deleted.git('add', '.');
  deleted.git('commit', '-q', '-m', 'add file');
  deleted.git('rm', '-q', 'old.txt');
  deleted.git('commit', '-q', '-m', 'remove file');
  assert.equal(deleted.scan().status, 0, 'working tree is clean');
  assert.equal(deleted.scan('--history').status, 1);

  const msg = setup();
  msg.put('x.txt', 'x\n');
  msg.git('add', '.');
  msg.git('commit', '-q', '-m', 'thanks to Zorblax');
  assert.equal(msg.scan('--history').status, 1);

  const author = setup();
  author.put('x.txt', 'x\n');
  author.git('add', '.');
  author.git('commit', '-q', '-m', 'plain', '--author=Zorblax <z@example.invalid>');
  const r = author.scan('--history');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /commit [0-9a-f]{10}:2:/); // line 2 is the "Author:" line
});

test('missing pattern file: exit 2, or 0 with --allow-missing; --help exits 0', () => {
  const t = setup();
  const missing = t.patFile + '.nope';
  assert.equal(t.raw('--patterns', missing).status, 2);
  assert.equal(t.raw('--patterns', missing, '--allow-missing').status, 0);
  const h = t.raw('--help');
  assert.equal(h.status, 0);
  assert.match(h.stdout, /Usage/);
});

test('allow: lines permit exactly that text; the same name elsewhere is still found', () => {
  const p = parsePatterns('zorblax\nallow:github.com/Zorblax/my-repo\n');
  assert.equal(scanText('see github.com/Zorblax/my-repo here', p, 'f').length, 0);
  const hits = scanText('mail zorblax@x.com and github.com/Zorblax/other', p, 'f');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].col, 6);
});
