import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The gateway's code folder. The agent may never write here.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Everything of one assistant (config, data, its folder) lives here; setup.js uses the same.
export const BASE = process.env.ASSISTANT_HOME || path.join(os.homedir(), '.assistant');

// Settings with their defaults. config.json (written by the setup skill) overrides them;
// secrets come from the environment (.env in the data folder, 0600), never from config.json.
export const DEFAULTS = {
  language: 'en', // the owner's language: the gateway's own lines and the assistant's replies
  ownerName: 'the owner',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  dataDir: path.join(BASE, 'data'), // state, auth, secrets: never in git
  agentCwd: path.join(BASE, 'home'), // the agent's own folder
  claudeBin: 'claude',
  model: 'sonnet',
  // Claude Code's built-in tools the agent gets (module MCP tools come on top). Fewer tools =
  // fewer tokens a conversation, and none that schedule cloud runs or spawn agents by themselves.
  tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite'],
  warm: true, // one claude process stays up between turns (~4 s faster)
  warmIdleMin: 30,
  batchMs: 1500, // messages this close together become one turn
  sessionIdleHours: 6, // a new conversation after this long without a turn
  contextMaxK: 90, // a new conversation when one step reads more tokens than this
  approvalTimeoutMin: 10, // then a request is parked
  approvalHoldHours: 24, // and a late yes still counts this long
  freeShell: false, // true only when the gateway runs as its own user: plain commands run without asking
  lockHost: false, // true on a shared machine: the agent's file tools stay out of system and other folders
  channels: { cli: {} },
  modules: {},
};

// The private repo's config.json (made by the setup skill) wins over a plain one.
export const configFile = () => process.env.ASSISTANT_CONFIG
  || [path.join(BASE, 'repo', 'config.json'), path.join(BASE, 'config.json')].find((f) => fs.existsSync(f)) || path.join(BASE, 'config.json');

export function loadConfig(file = configFile()) {
  const own = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = { ...DEFAULTS, ...own };
  for (const k of ['dataDir', 'agentCwd']) config[k] = path.resolve(config[k].replace(/^~(?=$|\/)/, os.homedir()));
  const env = path.join(config.dataDir, '.env');
  if (fs.existsSync(env)) process.loadEnvFile(env);
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.agentCwd, { recursive: true });
  config.root = ROOT;
  return config;
}
