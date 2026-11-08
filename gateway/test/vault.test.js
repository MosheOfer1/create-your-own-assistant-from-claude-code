import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { onSite, Vault, vaultCommand } from '../modules/browse/vault.js';

const fresh = () => new Vault(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'vault.json'));

test('commands save, list and delete; the reply never repeats the value', () => {
  const v = fresh();
  assert.match(vaultCommand(v, '/כספת'), /ריקה/);
  const r = vaultCommand(v, '/כספת תז 123456789');
  assert.doesNotMatch(r, /123456789/);
  vaultCommand(v, '/vault סיסמה@btl.gov.il S3cr et!');
  assert.deepEqual(v.names(), ['תז', 'סיסמה (only on btl.gov.il)']);
  assert.equal(v.read()['סיסמה'].value, 'S3cr et!');
  assert.doesNotMatch(vaultCommand(v, '/כספת'), /S3cr|123456789/);
  assert.match(vaultCommand(v, '/כספת מחק תז'), /נמחק/);
  assert.deepEqual(v.names(), ['סיסמה (only on btl.gov.il)']);
  assert.equal(vaultCommand(v, 'hello'), null);
  assert.equal(fs.statSync(v.file).mode & 0o777, 0o600);
});

test('a site value works only on https pages of that site', () => {
  assert.ok(onSite('https://www.btl.gov.il/login', 'btl.gov.il'));
  assert.ok(onSite('https://b2b.btl.gov.il/x', 'https://btl.gov.il/'));
  assert.ok(!onSite('http://btl.gov.il/', 'btl.gov.il'));
  assert.ok(!onSite('https://btl.gov.il.evil.com/', 'btl.gov.il'));
  assert.ok(!onSite('https://evilbtl.gov.il/', 'btl.gov.il'));
  const v = fresh();
  v.set('pw', 'x', 'btl.gov.il');
  v.set('id', '1');
  assert.throws(() => v.get('pw', 'https://evil.com/'), /only for btl\.gov\.il/);
  assert.equal(v.get('pw', 'https://www.btl.gov.il/').value, 'x');
  assert.equal(v.get('id', 'https://any.com/').value, '1');
  assert.throws(() => v.get('nope', 'https://a.com/'), /no "nope"/);
});
