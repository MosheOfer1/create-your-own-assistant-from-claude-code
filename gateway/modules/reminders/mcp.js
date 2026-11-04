#!/usr/bin/env node
// The agent's reminder tools. The scheduler lives in the gateway; these call POST /schedule.
import { ctl, serve } from '../../mcp/stdio.js';

const timing = {
  when: { type: 'string', description: `Local time (${process.env.TZ_NAME || 'owner time zone'}), "YYYY-MM-DD HH:MM"` },
  in_minutes: { type: 'number', description: 'Instead of when: minutes from now' },
  repeat: { type: 'string', enum: ['none', 'daily', 'workdays', 'weekly'], description: 'weekly = the weekday of `when`. Default none' },
};
const call = async (body) => {
  const r = await ctl('/schedule', body);
  if (!r.ok) throw new Error(r.error);
  return r.text;
};

serve('schedule', {
  remind: {
    description: 'Set a reminder: at that time the text is sent to the owner. Nothing else happens.',
    schema: { type: 'object', properties: { text: { type: 'string', description: 'The reminder as the owner should read it, in their language' }, ...timing }, required: ['text'] },
    run: (a) => call({ action: 'remind', ...a }),
  },
  task: {
    description: 'Schedule an agent task: at that time the assistant runs the prompt as a new turn and sends the result. For a plain reminder use remind.',
    schema: { type: 'object', properties: { prompt: { type: 'string', description: 'What to do then, as an instruction' }, ...timing }, required: ['prompt'] },
    run: (a) => call({ action: 'task', ...a }),
  },
  list: { description: 'List open reminders and tasks with their ids', schema: { type: 'object', properties: {} }, run: () => call({ action: 'list' }) },
  cancel: { description: 'Cancel a reminder or task by id', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: (a) => call({ action: 'cancel', ...a }) },
});
