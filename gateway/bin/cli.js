#!/usr/bin/env node
// Terminal simulator: you are the owner, the terminal is the chat. The real agent and the real
// approval flow run; no WhatsApp. "f: text" = a forwarded message. Ctrl+D to quit.
//   ASSISTANT_CONFIG=path/to/config.json npm run cli     (default ~/.assistant/config.json)
//   npm run cli -- --echo                                (no claude: replies echo, for a quick check)
import { CliChannel } from '../src/channels/cli.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/gateway.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node bin/cli.js [--echo]\n  Type as the owner. "f: text" = forwarded. "yes"/"no" answers approvals. Ctrl+D quits.');
  process.exit(0);
}
const echo = process.argv.includes('--echo');
const config = loadConfig();
const channel = new CliChannel();
const agentFactory = echo ? () => ({ run: async ({ prompt }) => ({ text: `echo: ${prompt.split('\n').at(-1)}`, sessionId: 'echo' }) }) : undefined;
const gw = await createGateway({ config, channel, agentFactory, log: (l) => console.error(`· ${l}`) });
console.error(`· ready. Agent folder: ${config.agentCwd}. Type a message.`);
channel.onClose = async () => { await gw.router.inflow; await gw.router.queue; await gw.stop(); process.exit(0); };
