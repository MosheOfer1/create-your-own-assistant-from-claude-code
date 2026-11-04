import crypto from 'node:crypto';
import { NO, YES } from './i18n.js';

// "yes", "no", "yes 3", "כן #3" → { decision, id }; anything else → null.
export function parseReply(text = '') {
  const m = text.trim().toLowerCase().match(/^(\S+)(?:\s+#?(\d+))?$/u);
  if (!m) return null;
  const decision = YES.includes(m[1]) ? 'allow' : NO.includes(m[1]) ? 'deny' : null;
  return decision && { decision, id: m[2] ? Number(m[2]) : null };
}

// Open approval requests. A request waits timeoutMs inside the agent's turn; then it is parked:
// the turn goes on, and for holdMs a late "yes N" still counts (onLate carries it out).
// With a store, ids never restart at 1 (an old "yes 3" must not approve a new #3) and parked
// requests survive a restart.
export class Approvals {
  constructor({ timeoutMs, holdMs = 0, onLate = null, store = null, now = Date.now }) {
    Object.assign(this, { timeoutMs, holdMs, onLate, store, now });
    this.nextId = Number(store?.get('approvalNextId') || 1);
    this.items = new Map();
    for (const s of store?.get('approvalsOpen') || []) {
      const left = (s.until || 0) - now();
      if (!holdMs || left <= 0 || !s.request) continue;
      const item = { ...s, resolve: () => {}, parked: true };
      item.timer = setTimeout(() => this.resolve(item.id, 'deny', 'expired'), left);
      item.timer.unref?.();
      this.items.set(item.id, item);
      this.nextId = Math.max(this.nextId, item.id + 1);
    }
    this.save();
  }

  save() {
    this.store?.set('approvalNextId', this.nextId);
    this.store?.set('approvalsOpen', [...this.items.values()].map(({ id, nonce, request, at, until }) => (
      { id, nonce, request, at, until: until || at + this.timeoutMs + this.holdMs })));
  }

  // request: { tool_name, input }. Resolves { allow, reason } when answered or parked.
  create(request) {
    const id = this.nextId++;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const item = { id, nonce: crypto.randomBytes(12).toString('hex'), request, resolve, parked: false, at: this.now() };
    item.timer = setTimeout(() => this.park(id), this.timeoutMs);
    item.timer.unref?.();
    this.items.set(id, item);
    this.save();
    return { id, nonce: item.nonce, promise };
  }

  park(id) {
    const item = this.items.get(id);
    if (!item || item.parked) return;
    if (!this.holdMs) return this.resolve(id, 'deny', 'timeout');
    item.parked = true;
    item.until = this.now() + this.holdMs;
    item.timer = setTimeout(() => this.resolve(id, 'deny', 'expired'), this.holdMs);
    item.timer.unref?.();
    this.save();
    item.resolve({ allow: false, reason: 'parked', id });
  }

  resolve(id, decision, reason = 'owner') {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.items.delete(id);
    this.save();
    if (!item.parked) item.resolve({ allow: decision === 'allow', reason });
    else if (!['expired', 'stopped'].includes(reason)) this.onLate?.(item, decision);
    return true;
  }

  pending() { return [...this.items.values()]; }
  waiting() { return this.pending().filter((i) => !i.parked); }
  byNonce(nonce) { return this.pending().find((i) => i.nonce === nonce) || null; }

  // The owner's text as an answer: { id, decision } or null. A bare "yes" answers only when
  // exactly one turn waits; a parked request needs its number.
  answer(text) {
    const r = parseReply(text);
    if (!r) return null;
    const ids = this.waiting().map((i) => i.id);
    const id = r.id ?? (ids.length === 1 ? ids[0] : null);
    if (id == null || !this.resolve(id, r.decision)) return null;
    return { id, decision: r.decision };
  }
}

// What a tool call will do, in one block, always in full: the owner must never approve a tail
// they did not see. A request whose text is longer than SHOW_MAX is refused (router.decide).
export const SHOW_MAX = 3000;
const block = (s) => `\`\`\`${s ?? ''}\`\`\``;
export function describe(tool, input = {}, t, describers = []) {
  for (const d of describers) {
    const s = d(tool, input, t);
    if (s) return s;
  }
  if (tool === 'Bash') return `${t.runCommand}\n${block(input.command)}`;
  const file = `${t.changeFile} ${input.file_path || input.notebook_path}`;
  if (tool === 'Write') return `${file}\n${block(input.content)}`;
  if (tool === 'Edit') return `${file}\n− ${block(input.old_string)}\n+ ${block(input.new_string)}`;
  if (tool === 'MultiEdit') return [file, ...(input.edits || []).map((e) => `− ${block(e.old_string)}\n+ ${block(e.new_string)}`)].join('\n');
  if (tool === 'NotebookEdit') return `${file}\n${block(input.new_source)}`;
  return `${tool}\n${JSON.stringify(input)}`;
}
