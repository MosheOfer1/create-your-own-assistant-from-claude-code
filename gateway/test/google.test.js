import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Agent } from '../src/agent.js';
import { userClaudeDirty, userMcpServers } from '../src/gateway.js';
import { Policy } from '../src/policy.js';
import google, { privateEvent } from '../modules/google/index.js';

const G = 'mcp__claude_ai_Gmail__';
const C = 'mcp__claude_ai_Google_Calendar__';
const D = 'mcp__claude_ai_Google_Drive__';

test('off unless the gateway runs as its own user', () => {
  const logs = [];
  assert.deepEqual(google({ ownUser: false }, { log: (l) => logs.push(l) }), {});
  assert.match(logs[0], /own user/);
  assert.equal(google({ ownUser: true }).claudeAi, true);
});

test('reads free and tainting; own-account changes free when clean; mail out, sharing, invites always ask', () => {
  const m = google({ ownUser: true });
  const p = new Policy({ agentCwd: '/tmp/a', root: '/tmp/r', modules: [m] });
  for (const t of [`${G}search_threads`, `${G}get_thread`, `${C}list_events`, `${D}read_file_content`]) {
    assert.ok(p.allowed.includes(t), t);
    assert.equal(p.untrusted(t), true, t);
  }
  for (const t of [`${G}create_draft`, `${G}label_thread`, `${D}create_file`]) {
    assert.equal(p.autoAllow(t, {}), true, t);
    assert.equal(p.autoAllow(t, {}, { tainted: true }), false, t);
  }
  assert.equal(p.autoAllow(`${C}create_event`, { summary: 'dentist' }), true);
  assert.equal(p.autoAllow(`${C}create_event`, { summary: 'x', attendees: [{ email: 'a@b.com' }] }), false);
  assert.equal(p.autoAllow(`${C}update_event`, { sendUpdates: 'all' }), false);
  for (const t of [`${G}send_message`, `${G}send_draft`, `${G}reply`, `${G}forward`, `${D}share_file`, `${C}delete_event`, `${C}respond_to_event`]) {
    assert.equal(p.gated(t), true, t);
    assert.equal(p.autoAllow(t, {}), false, t);
  }
  // Not listed: asks (trash is reversible, but still the owner's call).
  assert.equal(p.autoAllow(`${G}trash_thread`, {}), false);
});

test('privateEvent', () => {
  assert.equal(privateEvent({}), true);
  assert.equal(privateEvent({ event: { attendees: ['x@y.z'] } }), false);
  assert.equal(privateEvent({ send_updates: 'externalOnly' }), false);
});

test('the agent loads connectors (user settings, no strict MCP) only with claudeAi as its own user', () => {
  const base = { model: 'sonnet', timezone: 'UTC', language: 'en', ownerName: 'D', approvalTimeoutMin: 1 };
  const args = (o) => new Agent({ mcpConfig: '/m.json', allowedTools: ['Read'], ...o }).args();
  const on = args({ config: { ...base, ownUser: true }, claudeAi: true });
  assert.equal(on[on.indexOf('--setting-sources') + 1], 'user');
  assert.ok(!on.includes('--strict-mcp-config'));
  for (const off of [args({ config: { ...base, ownUser: false }, claudeAi: true }), args({ config: { ...base, ownUser: true } })]) {
    assert.equal(off[off.indexOf('--setting-sources') + 1], '');
    assert.ok(off.includes('--strict-mcp-config'));
  }
});

test('userClaudeDirty: a clean ~/.claude passes; CLAUDE.md, skills, hooks or allow rules do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  try {
    assert.equal(userClaudeDirty(path.join(dir, 'none')), null);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{}');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    fs.mkdirSync(path.join(dir, 'skills'));
    assert.equal(userClaudeDirty(dir), null); // an empty skills folder is fine
    // What Claude makes by itself at login: empty folders and a hidden bucket marker.
    fs.mkdirSync(path.join(dir, 'plugins', 'synced', 'acct', 'x'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', 'synced', '.bucket-acct'), '');
    assert.equal(userClaudeDirty(dir), null);
    fs.writeFileSync(path.join(dir, 'plugins', 'synced', 'acct', 'x', 'plugin.json'), '{}');
    assert.match(userClaudeDirty(dir), /plugins/); // a real plugin is not
    fs.rmSync(path.join(dir, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(*)'] } }));
    assert.match(userClaudeDirty(dir), /settings/);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: {} }));
    assert.match(userClaudeDirty(dir), /settings/);
    fs.rmSync(path.join(dir, 'settings.json'));
    fs.mkdirSync(path.join(dir, 'skills', 'x'));
    assert.equal(userClaudeDirty(dir), null); // an empty folder is still nothing
    fs.writeFileSync(path.join(dir, 'skills', 'x', 'SKILL.md'), '# x');
    assert.match(userClaudeDirty(dir), /skills/);
    fs.rmSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'hi');
    assert.match(userClaudeDirty(dir), /CLAUDE\.md/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('userMcpServers: MCP servers in ~/.claude.json also keep the connectors off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  try {
    const f = path.join(dir, '.claude.json');
    assert.equal(userMcpServers(f), null);
    fs.writeFileSync(f, JSON.stringify({ numStartups: 3 }));
    assert.equal(userMcpServers(f), null);
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { x: { command: 'y' } } }));
    assert.match(userMcpServers(f), /MCP servers/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
