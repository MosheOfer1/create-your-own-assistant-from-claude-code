#!/usr/bin/env node
// The agent's tools for other people. The WhatsApp link lives in the gateway; these call POST /people.
import { ctl, serve } from '../../mcp/stdio.js';

const call = (action) => async (a) => {
  const r = await ctl('/people', { action, ...a });
  if (!r.ok) throw new Error(r.error);
  return r.text;
};

serve('people', {
  find: {
    description: 'Look up a person in the owner\'s WhatsApp contacts by name or number. Returns names and numbers.',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: call('find'),
  },
  send: {
    description: 'Send a WhatsApp message to someone else, from the assistant\'s number. The owner sees the exact text and approves it first. '
      + 'Write it as the owner would want it read; say it is from the owner\'s assistant if that matters.',
    schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'A number in international format (+…), from find' },
        text: { type: 'string' },
        file: { type: 'string', description: 'Optional: a file in your own folder to send with it' },
      },
      required: ['to', 'text'],
    },
    run: call('send'),
  },
});
