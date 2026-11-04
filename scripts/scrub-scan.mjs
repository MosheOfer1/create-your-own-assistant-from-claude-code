#!/usr/bin/env node
// Personal-data scanner. Finds your private strings (names, phones, hosts...)
// before they reach a public repo. The pattern list lives OUTSIDE the repo.
//
// Pattern file (default ~/.config/scrub-patterns.txt, or $SCRUB_PATTERNS):
//   one pattern per line, case-insensitive; '#' starts a comment.
//   plain text      -> literal match
//   re:<regex>      -> regular expression (e.g. re:\bacme\b)
//   a phone number  -> digits match with any spaces, dashes, dots or brackets between
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage: scrub-scan.mjs [options] [file...]
  (no files)        scan tracked + untracked, not ignored files of the git repo here
  --staged          scan the staged version of staged files (pre-commit)
  --history         scan every commit of every branch: diffs, messages, authors
  --patterns FILE   pattern file (default $SCRUB_PATTERNS or ~/.config/scrub-patterns.txt)
  --allow-missing   exit 0 with a note when the pattern file does not exist
  -h, --help        show this help
Exit: 0 clean, 1 hits found, 2 usage or setup error.`;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function parsePatterns(text) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    let src;
    if (line.startsWith('re:')) src = line.slice(3);
    else if (/^[+\d][\d\s\-.()]*$/.test(line) && line.replace(/\D/g, '').length >= 7)
      src = line.replace(/\D/g, '').split('').join('[\\s\\-.()]*');
    else src = escape(line);
    out.push({ id: i + 1, re: new RegExp(src, 'giu') });
  });
  return out;
}

// Show only a hint of the match, so logs do not repeat the secret.
const mask = (s) => (s.length <= 2 ? '*'.repeat(s.length) : s.slice(0, 2) + '*'.repeat(Math.min(s.length - 2, 6)));

export function scanText(text, patterns, where) {
  const hits = [];
  text.split('\n').forEach((l, n) => {
    for (const p of patterns) {
      for (const m of l.matchAll(p.re)) {
        if (m[0]) hits.push({ where, line: n + 1, col: m.index + 1, id: p.id, hint: mask(m[0]) });
      }
    }
  });
  return hits;
}

const git = (args) => execFileSync('git', args, { maxBuffer: 1 << 30 });
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function* sources(mode, files) {
  if (files.length) {
    for (const f of files) yield [f, readFileSync(f)];
    return;
  }
  if (mode === 'history') {
    const fmt = '--format=commit %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>%n%n%B';
    const log = git(['log', '--all', '-p', '--no-color', fmt]).toString('utf8');
    for (const chunk of log.split(/^(?=commit [0-9a-f]{40}$)/m).filter(Boolean)) {
      yield [`commit ${chunk.slice(7, 17)}`, Buffer.from(chunk)];
    }
    return;
  }
  const staged = mode === 'staged';
  const list = staged
    ? git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    : git(['ls-files', '-z', '-co', '--exclude-standard']);
  for (const f of list.toString('utf8').split('\0').filter(Boolean)) {
    yield [`(path) ${f}`, Buffer.from(f)];
    if (staged) yield [f, git(['show', `:${f}`])];
    else if (existsSync(f)) yield [f, readFileSync(f)];
  }
}

export function run(argv) {
  const files = [];
  let mode = 'tree';
  let patFile = process.env.SCRUB_PATTERNS || join(homedir(), '.config', 'scrub-patterns.txt');
  let allowMissing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return console.log(USAGE), 0;
    else if (a === '--staged') mode = 'staged';
    else if (a === '--history') mode = 'history';
    else if (a === '--allow-missing') allowMissing = true;
    else if (a === '--patterns') patFile = argv[++i];
    else if (a.startsWith('-')) return console.error(`Unknown option ${a}\n${USAGE}`), 2;
    else files.push(a);
  }
  if (!patFile || !existsSync(patFile)) {
    console.error(`scrub-scan: no pattern file at ${patFile}.`);
    return allowMissing ? 0 : 2;
  }
  const patterns = parsePatterns(readFileSync(patFile, 'utf8'));
  const hits = [];
  for (const [where, buf] of sources(mode, files)) {
    if (!isBinary(buf)) hits.push(...scanText(buf.toString('utf8'), patterns, where));
  }
  for (const h of hits) console.log(`${h.where}:${h.line}:${h.col}  pattern line ${h.id}  "${h.hint}"`);
  console.error(hits.length ? `scrub-scan: ${hits.length} hit(s). Remove them before you commit or publish.` : 'scrub-scan: clean.');
  return hits.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(run(process.argv.slice(2)));
