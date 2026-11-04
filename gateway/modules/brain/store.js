import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The second brain: Markdown files in a folder (an Obsidian vault works), searched with SQLite
// FTS5 trigram (Hebrew prefixes like "ו" / "ה" still match). The index is a cache; the files are
// the truth.
//
// Facts live in memory/facts.md, one per line, the details in a comment Obsidian hides:
//   - Dana is vegetarian <!-- id:3 type:preference scope:food source:owner date:2026-11-04 -->
// type: fact | preference | rule | person | project. source: owner (their own words) | agent.
// Only the owner's words make rules (a rewritten free-text memory drifted: one-offs became rules).
export const TYPES = ['fact', 'preference', 'rule', 'person', 'project'];
const FACT = /^- (.+?) <!-- id:(\d+) (.*?)-->\s*$/;
const SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

export function parseFacts(text = '') {
  const out = [];
  for (const line of text.split('\n')) {
    const m = FACT.exec(line);
    if (!m) continue;
    const meta = Object.fromEntries(m[3].trim().split(/\s+/).filter(Boolean).map((kv) => kv.split(':')).map(([k, ...v]) => [k, v.join(':')]));
    out.push({ id: Number(m[2]), text: m[1], ...meta });
  }
  return out;
}
export const factLine = (f) => `- ${f.text.replace(/\s+/g, ' ').replace(/-->/g, '→')} <!-- id:${f.id} type:${f.type} scope:${f.scope || '-'} source:${f.source} date:${f.date} -->`;

// The words of a message as an FTS query: 3+ letters, no very common words, OR'ed and quoted.
const COMMON = new Set('the and for you are with this that have what when how can will was not but all any של את על עם זה מה לא כן גם אני אתה היא הוא יש אין או אבל רק כל אם כי עוד אז'.split(' '));
// A Hebrew word with a one-letter prefix (ו ה ב ל כ מ ש) also searches without it:
// "הצמחונית" finds "צמחונית" (the other way round trigram matching does by itself).
export function ftsQuery(text = '', max = 12) {
  const words = [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !COMMON.has(w)))].slice(0, max);
  const terms = new Set(words.flatMap((w) => (/^[והבלכמש][א-ת]{3,}$/.test(w) ? [w, w.slice(1)] : [w])));
  return terms.size ? [...terms].map((w) => `"${w}"`).join(' OR ') : null;
}

export class Brain {
  constructor({ dir, dbFile, now = Date.now }) {
    Object.assign(this, { dir: path.resolve(dir), now });
    fs.mkdirSync(path.join(this.dir, 'memory'), { recursive: true });
    this.factsFile = path.join(this.dir, 'memory', 'facts.md');
    if (!fs.existsSync(this.factsFile)) fs.writeFileSync(this.factsFile, '# Facts\n\nWhat the assistant knows. Edit freely; keep the comment at the end of each line.\n\n');
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, mtime REAL);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(key UNINDEXED, title, body, tokenize='trigram');`);
  }

  // Brings the index up to date with the files (changed by the agent, the owner or Obsidian).
  sync() {
    const seen = new Set();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.md')) this.indexFile(p, seen);
      }
    };
    walk(this.dir);
    for (const { key } of this.db.prepare('SELECT key FROM docs').all()) if (!seen.has(key)) this.drop(key);
  }

  indexFile(p, seen) {
    const rel = path.relative(this.dir, p);
    const mtime = fs.statSync(p).mtimeMs;
    const known = this.db.prepare('SELECT mtime FROM docs WHERE key = ?').get(rel);
    if (p === this.factsFile) {
      // Each fact is its own row, so a search finds the line, not the whole file.
      seen.add(rel);
      for (const f of parseFacts(fs.readFileSync(p, 'utf8'))) seen.add(`${rel}#${f.id}`);
      if (known?.mtime === mtime) return;
      for (const { key } of this.db.prepare("SELECT key FROM docs WHERE key LIKE ? || '#%'").all(rel)) this.drop(key);
      for (const f of parseFacts(fs.readFileSync(p, 'utf8'))) this.put(`${rel}#${f.id}`, mtime, `${f.type}${f.scope && f.scope !== '-' ? ` ${f.scope}` : ''}`, f.text);
      this.db.prepare('INSERT OR REPLACE INTO docs VALUES (?, ?)').run(rel, mtime);
      return;
    }
    seen.add(rel);
    if (known?.mtime === mtime) return;
    const body = fs.readFileSync(p, 'utf8');
    this.put(rel, mtime, (/^#\s+(.+)$/m.exec(body)?.[1] || path.basename(rel, '.md')).trim(), body);
  }

  put(key, mtime, title, body) {
    this.drop(key);
    this.db.prepare('INSERT INTO docs VALUES (?, ?)').run(key, mtime);
    this.db.prepare('INSERT INTO fts VALUES (?, ?, ?)').run(key, title, body);
  }

  drop(key) {
    this.db.prepare('DELETE FROM docs WHERE key = ?').run(key);
    this.db.prepare('DELETE FROM fts WHERE key = ?').run(key);
  }

  // [{ key, title, snippet }], best first.
  search(text, limit = 5) {
    const q = ftsQuery(text);
    if (!q) return [];
    this.sync();
    // A fact comes back whole (a cut fact can lose the part that matters); a note as a snippet.
    return this.db.prepare(`SELECT key, title, body, snippet(fts, 2, '«', '»', '…', 64) AS snippet FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?`).all(q, limit)
      .map((r) => ({ key: r.key, title: r.title, snippet: (r.key.includes('#') ? r.body : r.snippet).replace(/\s*<!--.*?-->/g, '').replace(/\s+/g, ' ') }));
  }

  facts() { return parseFacts(fs.readFileSync(this.factsFile, 'utf8')); }

  addFact({ text, type = 'fact', scope = '-', source = 'agent' }) {
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
    if (!String(text).trim()) throw new Error('empty fact');
    const id = Math.max(0, ...this.facts().map((f) => f.id)) + 1;
    const f = { id, text: String(text).trim().slice(0, 500), type, scope: String(scope).replace(/\s+/g, '-') || '-', source, date: new Date(this.now()).toISOString().slice(0, 10) };
    fs.appendFileSync(this.factsFile, `${factLine(f)}\n`);
    return f;
  }

  removeFact(id) {
    const lines = fs.readFileSync(this.factsFile, 'utf8').split('\n');
    const keep = lines.filter((l) => Number(FACT.exec(l)?.[2]) !== Number(id));
    if (keep.length === lines.length) return false;
    fs.writeFileSync(this.factsFile, keep.join('\n'));
    return true;
  }

  // A note page. rel stays inside the brain, ends in .md, no dot folders.
  writeNote(rel, content, { append = false } = {}) {
    const p = path.resolve(this.dir, String(rel));
    const r = path.relative(this.dir, p);
    if (!r || r.startsWith('..') || path.isAbsolute(r) || !r.endsWith('.md') || r.split(path.sep).some((s) => s.startsWith('.'))) throw new Error('notes are .md files inside the brain folder');
    if (p === this.factsFile) throw new Error('facts go through remember / forget');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (append) fs.appendFileSync(p, `${content.endsWith('\n') ? content : `${content}\n`}`); else fs.writeFileSync(p, content);
    return r;
  }

  close() { this.db.close(); }
}
