#!/usr/bin/env node
// The agent's browser tools. The browser lives in the gateway; these call POST /browse.
import { ctl, serve } from '../../mcp/stdio.js';

const call = (action) => async (a) => {
  const r = await ctl('/browse', { action, ...a });
  if (!r.ok) throw new Error(r.error);
  return r.text;
};
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const target = { type: 'string', description: 'Visible text of a link/button/label, or a CSS selector' };

serve('browse', {
  open: { description: 'Open a public web page; returns its title, URL and main text.', schema: obj({ url: { type: 'string' } }, ['url']), run: call('open') },
  text: { description: 'Main text of the current page (all=true: everything).', schema: obj({ max: { type: 'number' }, all: { type: 'boolean' } }), run: call('text') },
  links: { description: 'Visible links and buttons (text -> href); word filters.', schema: obj({ word: { type: 'string' } }), run: call('links') },
  click: { description: 'Click a visible link or button.', schema: obj({ target }, ['target']), run: call('click') },
  type: { description: 'Fill a field (by label, placeholder or CSS) with text.', schema: obj({ target, text: { type: 'string' } }, ['target', 'text']), run: call('type') },
  press: { description: 'Press a key (Enter, Tab, Escape, ArrowDown…).', schema: obj({ key: { type: 'string' } }, ['key']), run: call('press') },
  vault: { description: "Names of the owner's saved details (ID, phone, passwords for given sites). Values are never shown.", schema: obj({}), run: call('vault') },
  fill: { description: "Type a saved vault item into a field; you never see the value. A password works only on its site.", schema: obj({ target, item: { type: 'string', description: 'Vault name, as mcp__browse__vault lists it' } }, ['target', 'item']), run: call('fill') },
  code: { description: 'Ask the owner in the chat for a code they got (SMS, mail) and type it into the field. Waits up to 4 minutes.', schema: obj({ target, from: { type: 'string', description: 'Who sent it, e.g. ביטוח לאומי' } }, ['target']), run: call('code') },
  shot: { description: 'Screenshot of the page; returns a PNG path to Read.', schema: obj({}), run: call('shot') },
});
