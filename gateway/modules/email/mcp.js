#!/usr/bin/env node
// The agent's email tools. The mailbox connection lives in the gateway; these call POST /mail.
import { ctl, serve } from '../../mcp/stdio.js';

const call = (action) => async (a) => {
  const r = await ctl('/mail', { action, ...a });
  if (!r.ok) throw new Error(r.error);
  return r.text;
};
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const mail = { to: { type: 'string' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' } };

serve('mail', {
  search: { description: 'Search the mailbox. Gmail: Gmail search syntax (from:x newer_than:7d is:unread). Newest first.', schema: obj({ query: { type: 'string' }, limit: { type: 'number' } }), run: call('search') },
  read: { description: 'Read one mail by uid: headers, text, attachment list.', schema: obj({ uid: { type: 'number' } }, ['uid']), run: call('read') },
  save_attachment: { description: 'Save an attachment of a mail into your inbox folder, to Read it.', schema: obj({ uid: { type: 'number' }, index: { type: 'number' } }, ['uid']), run: call('save_attachment') },
  draft: { description: 'Save a draft in the owner\'s mailbox (nothing is sent).', schema: obj(mail, ['body']), run: call('draft') },
  send: { description: 'Send an email (the owner approves first). For a reply also give reply_to_uid (keeps the thread).', schema: obj({ ...mail, reply_to_uid: { type: 'number' } }, ['to', 'body']), run: call('send') },
});
