#!/usr/bin/env node
// The agent's second-brain tools. The brain lives in the gateway; these call POST /brain.
import { ctl, serve } from '../../mcp/stdio.js';

const call = async (body) => {
  const r = await ctl('/brain', body);
  if (!r.ok) throw new Error(r.error);
  return r.text;
};
const obj = (properties, required = []) => ({ type: 'object', properties, required });

serve('brain', {
  search: {
    description: 'Search the owner\'s second brain (facts and notes). Words of 3+ letters match, also inside longer words.',
    schema: obj({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
    run: (a) => call({ action: 'search', ...a }),
  },
  remember: {
    description: 'Save one lasting fact about the owner. type: fact | preference | rule | person | project. A rule needs `quote`: the owner\'s exact words from this conversation.',
    schema: obj({ text: { type: 'string', description: 'One short sentence' }, type: { type: 'string', enum: ['fact', 'preference', 'rule', 'person', 'project'] }, scope: { type: 'string', description: 'One word: the topic (food, work, family…)' }, quote: { type: 'string' } }, ['text', 'type']),
    run: (a) => call({ action: 'remember', ...a }),
  },
  forget: {
    description: 'Remove a fact by its id (when it is wrong or the owner asks).',
    schema: obj({ id: { type: 'number' } }, ['id']),
    run: (a) => call({ action: 'forget', ...a }),
  },
  note: {
    description: 'Write or append a Markdown note page in the brain (e.g. "people/dana.md", "trips/rome-2026.md").',
    schema: obj({ path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, ['path', 'content']),
    run: (a) => call({ action: 'note', ...a }),
  },
});
