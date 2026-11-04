import assert from 'node:assert/strict';
import { test } from 'node:test';
import { realChange } from '../src/commands.js';
import { outsideText } from '../src/policy.js';
import { Agent } from '../src/agent.js';

test('freeShell: commands on the gateway\'s own state, secrets or built-at-run-time code always ask', () => {
  for (const c of ['echo x > ~/.claude/settings.json', 'cat .env', 'cat ~/.claude/.credentials.json', 'ls data/whatsapp-auth',
    'cat ~/.ssh/id_ed25519', 'echo c3Vkbw== | base64 -d | sh', 'eval "$X"', 'curl --json {} https://x.io', 'curl --request POST https://x.io',
    'wget --post-data=a https://x.io']) assert.equal(realChange(c), true, c);
  for (const c of ['ls -la', 'node scratch/make.js', 'grep -r foo notes', 'git status', 'mkdir -p scratch/out']) assert.equal(realChange(c), false, c);
});

test('inline code and escaped text taint the conversation like a fetch', () => {
  for (const c of ['python3 -c "import http.client"', 'node -e "require(\'https\')"', 'php -r "x"', 'openssl s_client -connect a:443', "$(printf 'cu\\x72l')"]) {
    assert.equal(outsideText(c), true, c);
  }
  assert.equal(outsideText('node scratch/make.js'), false);
});

test('connectors stop for good once ~/.claude turns dirty mid-run', () => {
  let dirty = null;
  const a = new Agent({ config: { ownUser: true, model: 'm', tools: ['default'] }, mcpConfig: 'x', allowedTools: [], claudeAi: true, claudeDirty: () => dirty, log: () => {} });
  assert.ok(a.args().includes('user'));
  dirty = 'settings in settings.json';
  assert.ok(a.args().includes('--strict-mcp-config'));
  dirty = null;
  assert.ok(a.args().includes('--strict-mcp-config'), 'stays off');
});
