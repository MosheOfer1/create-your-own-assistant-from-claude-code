#!/usr/bin/env node
// The service entry point (systemd / launchd run this). Channels come in stage 2: until then
// the terminal channel runs, which is what the simulator uses too.
import { CliChannel } from './channels/cli.js';
import { loadConfig } from './config.js';
import { createGateway } from './gateway.js';

const config = loadConfig();
const channels = { cli: () => new CliChannel() };
const name = Object.keys(config.channels || {}).find((c) => channels[c]) || 'cli';
const gw = await createGateway({ config, channel: channels[name]() });
console.log(`gateway: up, channel ${name}, ${Object.keys(config.modules || {}).length} modules`);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await gw.stop(); process.exit(0); });
