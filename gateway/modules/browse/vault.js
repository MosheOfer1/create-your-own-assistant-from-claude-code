import fs from 'node:fs';
import path from 'node:path';

// The owner's details for forms and logins: ID number, phone, address, passwords. The agent
// sees only the names; the gateway types the values into the page itself (fill). A value with a
// site (a password) is typed only on that site. The file is in dataDir (0600), which the agent's
// tools cannot read.
export class Vault {
  constructor(file) { this.file = file; }

  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).items || {}; } catch { return {}; }
  }

  write(items) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  names() {
    return Object.entries(this.read()).map(([name, v]) => (v.site ? `${name} (only on ${v.site})` : name));
  }

  set(name, value, site) {
    const items = this.read();
    items[name] = site ? { value, site } : { value };
    this.write(items);
  }

  delete(name) {
    const items = this.read();
    if (!Object.hasOwn(items, name)) return false;
    delete items[name];
    this.write(items);
    return true;
  }

  // The value for this page, or an error the agent may see (never the value).
  get(name, url) {
    const item = this.read()[name];
    if (!item) throw new Error(`no "${name}" in the vault; ask the owner to add it: /vault ${name} <value>`);
    if (item.site && !onSite(url, item.site)) throw new Error(`"${name}" is only for ${item.site}, and this page is ${host(url) || 'no site'}`);
    return item;
  }
}

const host = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
export const onSite = (url, site) => {
  const h = host(url);
  const s = String(site).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return Boolean(h) && new URL(url).protocol === 'https:' && (h === s || h.endsWith(`.${s}`));
};

// "/vault", "/כספת": list. "/vault NAME VALUE": save. "/vault NAME@site.com VALUE": save for
// that site only. "/vault delete NAME" (מחק): remove. Returns the reply, or null when it is not
// a vault command. The reply never repeats the value.
export function vaultCommand(vault, text) {
  const m = /^\/(vault|כספת)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const rest = (m[2] || '').trim();
  if (!rest) {
    const n = vault.names();
    return n.length ? `🔐 בכספת: ${n.join(', ')}` : '🔐 הכספת ריקה. הוספה: /כספת תז 123456789 · סיסמה לאתר: /כספת סיסמה@btl.gov.il ****';
  }
  const del = /^(delete|מחק)\s+(\S+)$/i.exec(rest);
  if (del) return vault.delete(del[2]) ? `🗑️ ${del[2]} נמחק מהכספת` : `אין ${del[2]} בכספת`;
  const set = /^(\S+?)(?:@(\S+))?\s+([\s\S]+)$/.exec(rest);
  if (!set) return 'שימוש: /כספת שם ערך · /כספת שם@אתר ערך · /כספת מחק שם';
  const [, name, site, value] = set;
  vault.set(name, value.trim(), site);
  return `🔐 ${name} נשמר${site ? ` (רק ל-${site})` : ''}. אפשר למחוק את ההודעה שלך מהצ'אט.`;
}
