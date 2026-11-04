import fs from 'node:fs';
import path from 'node:path';

// The people WhatsApp tells the linked device about: names from the assistant's address book
// (app-state sync), the names people set for themselves, and the LID ↔ phone pairs. Only for
// finding a recipient. Who gets a message is always the owner's decision (an approval in the
// module that sends); nothing here sends anything.
//
// A record: { phone: '+15550100', name?, notify?, lid?: '123@lid' }. Kept in a 0600 JSON file.

export const userPart = (jid = '') => String(jid).split('@')[0].split(':')[0];

// International digits, or '' when it is not a plausible number. "+1 555-0100" and "001 555 0100"
// are the same number. A local number (one leading 0) has no country, so it is not a number here.
export function normalizePhone(s = '') {
  let d = String(s).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  return /^[1-9]\d{6,14}$/.test(d) ? d : '';
}

// Case, niqqud and other marks, and Hebrew final letters do not matter when finding a name:
// "יוסף" finds "יוסף", "יוסֵף" and a query "יוספ" typed mid-word.
const FINALS = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
export const fold = (s = '') => String(s).normalize('NFKD').replace(/[֑-ׇ̀-ͯ]/g, '')
  .replace(/[ךםןףץ]/g, (c) => FINALS[c]).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const SAVE_MS = 2000;

export class ContactBook {
  constructor({ file = null, log = () => {} } = {}) {
    Object.assign(this, { file, log });
    this.byPhone = new Map(); // digits → record
    this.lids = new Map(); // lid user part → { phone?, name?, notify? } (names wait here until the phone is known)
    if (file && fs.existsSync(file)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const c of j.contacts || []) if (normalizePhone(c.phone)) this.byPhone.set(normalizePhone(c.phone), c);
        for (const [k, v] of Object.entries(j.lids || {})) this.lids.set(k, v);
      } catch { /* a broken file starts empty; WhatsApp sends the contacts again */ }
    }
  }

  // One Baileys contact (contacts.upsert / contacts.update / messaging-history.set). id, lid and
  // phoneNumber may be @s.whatsapp.net or @lid in any mix. True when something changed.
  add({ id, lid, phoneNumber, name, notify, verifiedName } = {}) {
    const ids = [id, lid, phoneNumber].filter((j) => typeof j === 'string');
    const pnJid = ids.find((j) => j.endsWith('@s.whatsapp.net'));
    const lidJid = ids.find((j) => j.endsWith('@lid'));
    const lidUser = lidJid ? userPart(lidJid) : '';
    const fields = Object.fromEntries(Object.entries({ name, notify: notify || verifiedName })
      .filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim().slice(0, 100)]));
    const phone = (pnJid && normalizePhone(userPart(pnJid))) || (lidUser && this.lids.get(lidUser)?.phone) || '';
    if (!phone) {
      if (!lidUser || !Object.keys(fields).length) return false;
      this.lids.set(lidUser, { ...this.lids.get(lidUser), ...fields });
      return this.changed();
    }
    const parked = lidUser ? this.lids.get(lidUser) : null;
    if (lidUser) this.lids.set(lidUser, { phone });
    const prev = this.byPhone.get(phone);
    const next = { phone: `+${phone}`, ...prev, ...(parked?.name && { name: parked.name }), ...(parked?.notify && { notify: parked.notify }), ...fields,
      ...(lidUser && { lid: `${lidUser}@lid` }) };
    if (prev && JSON.stringify(next) === JSON.stringify(prev)) return false;
    this.byPhone.set(phone, next);
    return this.changed();
  }

  // Baileys 'lid-mapping.update': { lid, pn }. A name seen under the LID moves to the phone.
  map(lid, pn) { return lid && pn ? this.add({ id: pn, lid }) : false; }

  // The phone digits behind a LID, if known.
  phoneOfLid(lid) { return this.lids.get(userPart(lid))?.phone || ''; }

  get(phone) { return this.byPhone.get(normalizePhone(phone)) || null; }

  list() {
    return [...this.byPhone.values()].sort((a, b) => (a.name || a.notify || a.phone).localeCompare(b.name || b.notify || b.phone));
  }

  // By name: every word of the query is in the saved name or the WhatsApp name. By number: the
  // query's digits (4 or more; a leading 0 or + dropped) are in the phone. Best matches first.
  find(query = '', limit = 10) {
    const digitsOnly = /^[\d\s+()\-.]+$/.test(String(query).trim());
    const words = digitsOnly ? [] : fold(query).split(' ').filter(Boolean);
    const num = digitsOnly ? String(query).replace(/\D/g, '').replace(/^0+/, '') : '';
    const hits = [];
    for (const c of this.byPhone.values()) {
      let score = 0;
      if (words.length) {
        const hay = fold(`${c.name || ''} ${c.notify || ''}`);
        if (words.every((w) => hay.includes(w))) score = 1 + words.filter((w) => hay.split(' ').includes(w)).length + (c.name ? 1 : 0);
      } else if (num.length >= 4 && c.phone.includes(num)) score = c.phone === `+${num}` ? 3 : 1;
      if (score) hits.push({ c, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ c }) => ({ ...c }));
  }

  // Many contacts arrive at once (history sync): one write a moment later.
  changed() {
    if (!this.file) return true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), SAVE_MS);
    this.timer.unref?.();
    return true;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ contacts: [...this.byPhone.values()], lids: Object.fromEntries(this.lids) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log(`whatsapp: contacts not saved: ${e.message}`); }
  }

  // On stop: a write that still waits happens now.
  flush() { if (this.timer) this.save(); }
}
