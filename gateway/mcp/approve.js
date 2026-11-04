#!/usr/bin/env node
// The permission-prompt tool (`claude -p --permission-prompt-tool mcp__approve__ask`).
// Claude Code calls it before any tool that is not pre-allowed; the gateway decides or asks the owner.
import { ctl, serve } from './stdio.js';

serve('approve', {
  ask: {
    description: 'Ask the owner to approve a tool call',
    schema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    async run({ tool_name, input }) {
      let d;
      try { d = await ctl('/approval', { tool_name, input }); } catch (e) { d = { allow: false, message: `The gateway is unreachable: ${e.message}` }; }
      return d.allow
        ? { behavior: 'allow', updatedInput: d.input || input }
        : { behavior: 'deny', message: d.message || (d.reason === 'timeout' ? 'The owner did not answer in time.' : 'The owner denied this action.') };
    },
  },
});
