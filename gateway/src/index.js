#!/usr/bin/env node
// The service entry point (systemd / launchd run this). Channels from config.channels, in order:
// the first is the main one, the others are backups. E.g.
//   "channels": { "whatsapp": { "assistantNumber": "+1555...", "ownerNumber": "+1555..." }, "telegram": {} }
import path from 'node:path';
import { CliChannel } from './channels/cli.js';
import { Channels } from './channels/join.js';
import { BASE, loadConfig, ROOT } from './config.js';
import { createGateway } from './gateway.js';
import { State } from './state.js';
import { makeSync } from './sync.js';

const config = loadConfig();
const state = new State(path.join(config.dataDir, 'channels.json'));
const make = {
  cli: () => new CliChannel(),
  whatsapp: async (o) => new (await import('./channels/whatsapp.js')).WhatsAppChannel({ ...o, authDir: path.join(config.dataDir, 'whatsapp-auth') }),
  telegram: async () => new (await import('./channels/telegram.js')).TelegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN, state }),
};
const channels = {};
// A channel that cannot start (a missing token) is left out with a log line; the others run.
for (const [name, opts] of Object.entries(config.channels || { cli: {} })) {
  try {
    if (!make[name]) throw new Error('unknown channel');
    channels[name] = await make[name](opts || {});
  } catch (e) { console.log(`gateway: channel ${name} left out: ${e.message}`); }
}
if (!Object.keys(channels).length) throw new Error('no channel could start; check config.json channels');
const channel = new Channels({ channels, language: config.language });
const gw = await createGateway({ config, channel });
console.log(`gateway: up, channels ${Object.keys(channels).join(', ')}`);
const quit = async () => { await gw.stop(); process.exit(0); }; // systemd / launchd start it again
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, quit);

// The private repo: pulled before a turn (at most once a minute) and once a day, never on a timer.
const sync = makeSync({ base: BASE, app: path.dirname(ROOT), ownUser: config.ownUser });
Object.assign(gw.router.hooks, { beforeTurn: () => sync(), restart: quit });
const pull = async () => { if (await sync({ force: true }) === 'restart' && !gw.router.current) await quit(); };
setInterval(pull, 24 * 3600_000).unref();
// Also once at start, so after a reboot or a long time down it is current before the first message.
// No loop: right after a restart the pull finds nothing new.
setTimeout(pull, 5000).unref();
