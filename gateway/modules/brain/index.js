import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain } from './store.js';

// The second brain module. Options (config.modules.brain):
//   dir: the Markdown folder (default <agentCwd>/brain; point it at an existing Obsidian vault)
//   when the folder (or its parent) is a git repo, each change is committed (commit: false turns it off);
//   push: true → also pushed
//   recallChars (1500), coreChars (1500)
// Core = the owner's own rules and preferences, in the system prompt. Recall = other matching
// facts and notes, added before a turn only when something matches.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export default function brainModule(config, { exec = execFile, log = console.log } = {}) {
  const dir = config.dir || path.join(config.agentCwd, 'brain');
  const brain = new Brain({ dir, dbFile: path.join(config.dataDir, 'brain.sqlite') });
  const recent = []; // the owner's last messages: a rule must quote one of them
  let timer = null;

  // Changes become a commit after a quiet 30 s (and a push if asked).
  // The brain is a repo itself (a vault) or the brain/ folder of the private repo. Never further
  // up: a home folder that happens to be a git repo must not get the assistant's commits.
  const inGit = () => [dir, path.dirname(path.resolve(dir))].some((d) => fs.existsSync(path.join(d, '.git')));
  const commit = () => {
    if (config.commit === false || !inGit()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      exec('git', ['-C', dir, 'add', '-A'], (e1) => {
        if (e1) return log(`brain: git add failed: ${e1.message}`);
        exec('git', ['-C', dir, 'commit', '-q', '-m', 'assistant: memory update'], (e2) => {
          if (!e2 && config.push) exec('git', ['-C', dir, 'push', '-q'], (e3) => e3 && log(`brain: push failed: ${e3.message}`));
        });
      });
    }, 30_000);
    timer.unref?.();
  };

  const core = () => {
    const rows = brain.facts().filter((f) => f.source === 'owner' && ['rule', 'preference'].includes(f.type));
    let out = '';
    for (const f of rows) {
      const line = `- ${f.text} (#${f.id})\n`;
      if (out.length + line.length > (config.coreChars || 1500)) break;
      out += line;
    }
    return out && `## What the owner told you (their rules and preferences)\n${out}`;
  };

  function api(a) {
    if (a.action === 'search') {
      const hits = brain.search(a.query, Math.min(Number(a.limit) || 8, 20));
      return { ok: true, text: hits.length ? hits.map((h) => `${h.key} — ${h.title}\n  ${h.snippet}`).join('\n') : 'nothing found' };
    }
    if (a.action === 'remember') {
      // A quote from the owner's own recent words makes it the owner's; only those can be rules.
      // At least a few words: "the" is in almost every message.
      const said = a.quote && norm(a.quote).length >= 8 && norm(a.quote).includes(' ') && recent.some((m) => norm(m).includes(norm(a.quote)));
      if (a.type === 'rule' && !said) return { ok: false, error: 'a rule needs `quote`: the owner\'s exact words from this conversation' };
      const f = brain.addFact({ text: a.text, type: a.type, scope: a.scope, source: said ? 'owner' : 'agent' });
      commit();
      return { ok: true, text: `remembered #${f.id} (${f.type}, from ${f.source})` };
    }
    if (a.action === 'forget') {
      const done = brain.removeFact(a.id);
      if (done) commit();
      return done ? { ok: true, text: `forgot #${a.id}` } : { ok: false, error: `no fact #${a.id}` };
    }
    if (a.action === 'note') {
      const rel = brain.writeNote(a.path, String(a.content || ''), { append: !!a.append });
      commit();
      return { ok: true, text: `saved ${rel}` };
    }
    return { ok: false, error: `unknown action ${a.action}` };
  }

  // Before a turn: matching facts and notes (not the core ones, they are in the prompt already).
  function recall(text) {
    // Only the owner's own words count for a quote: not forwarded text, not a quoted reply.
    // Formats (router.js): "[Replying to: «…»]", "[Forwarded message, …:]\n«…»", "[Forwarded, …:]\n<text>".
    const own = String(text)
      .replace(/\[Replying to: «[\s\S]*?»\]/g, '')
      .replace(/\[Forwarded[^\]]*\]\n?(«[\s\S]*?»|[\s\S]*?(?=\n\n|$))/g, '');
    recent.push(own.slice(0, 2000));
    if (recent.length > 6) recent.shift();
    const coreIds = new Set(brain.facts().filter((f) => f.source === 'owner' && ['rule', 'preference'].includes(f.type)).map((f) => `memory/facts.md#${f.id}`));
    let out = '';
    for (const h of brain.search(text, 8)) {
      if (coreIds.has(h.key)) continue;
      const line = `- ${h.key.startsWith('memory/facts.md#') ? h.snippet : `${h.key}: ${h.snippet}`}\n`;
      if (out.length + line.length > (config.recallChars || 1500)) break;
      out += line;
    }
    return out && `[From your memory (background; may be outdated):\n${out.trim()}]`;
  }

  return {
    mcp: { brain: { command: process.execPath, args: ['--no-warnings', path.join(HERE, 'mcp.js')] } },
    // The assistant's own memory: writing it reaches nobody, so it needs no approval. After
    // outside text (tainted) a write asks: a page could plant a "rule" that every later
    // conversation then reads in its prompt.
    allowed: ['mcp__brain__search'],
    autoAllow: (tool, input, { tainted } = {}) => !tainted && /^mcp__brain__(remember|forget|note)$/.test(tool),
    routes: { '/brain': api },
    prompt: () => [`## Memory\nYour second brain is Markdown in ${dir} (the owner may read it in Obsidian). Use mcp__brain__search before saying you do not know something about the owner. `
      + 'Save lasting facts with mcp__brain__remember: preferences, people, projects. When the owner said it themselves, pass their exact words as `quote` (a rule, "always…" / "never…", needs one). Do not save one-off details.', core()].filter(Boolean).join('\n\n'),
    context: recall,
    brain,
    api,
    start() { brain.sync(); },
    stop() { clearTimeout(timer); brain.close(); },
  };
}
