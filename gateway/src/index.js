#!/usr/bin/env node
// The service entry point (systemd / launchd run this). Channels from config.channels, in order:
// the first is the main one, the others are backups. E.g.
//   "channels": { "whatsapp": { "assistantNumber": "+1555...", "ownerNumber": "+1555..." }, "telegram": {} }
import path from 'node:path';
import { CliChannel } from './channels/cli.js';
import { Channels } from './channels/join.js';
import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';
import { State } from './state.js';

const config = loadConfig();
const state = new State(path.join(config.dataDir, 'channels.json'));
const make = {
  cli: () => new CliChannel(),
  whatsapp: async (o) => new (await import('./channels/whatsapp.js')).WhatsAppChannel({ ...o, authDir: path.join(config.dataDir, 'whatsapp-auth') }),
  telegram: async () => new (await import('./channels/telegram.js')).TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN, state }),
};
const channels = {};
for (const [name, opts] of Object.entries(config.channels || { cli: {} })) {
  if (!make[name]) throw new Error(`unknown channel ${name}`);
  channels[name] = await make[name](opts || {});
}
const channel = new Channels({ channels, language: config.language });
const gw = await createGateway({ config, channel });
console.log(`gateway: up, channels ${Object.keys(channels).join(', ')}`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await gw.stop(); process.exit(0); });
