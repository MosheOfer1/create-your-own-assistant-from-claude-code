import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waText } from '../src/channels/wa-text.js';

test('markdown becomes whatsapp marks', () => {
  assert.equal(waText('## כותרת\n**חשוב** ו~~ישן~~'), '*כותרת*\n*חשוב* ו~ישן~');
  assert.equal(waText('- אחד\n- שניים'), '• אחד\n• שניים');
});

test('links become plain urls', () => {
  assert.equal(waText('ראה [האתר](https://www.mrcut.org/)'), 'ראה האתר https://www.mrcut.org/');
  assert.equal(waText('[mrcut.org](https://mrcut.org)'), 'https://mrcut.org');
  assert.equal(waText('<https://a.com/x>'), 'https://a.com/x');
});

test('a trailing sources block is dropped', () => {
  assert.equal(waText('הטלפון 053.\n\nSources: [Mr. Cut](https://www.mrcut.org/)'), 'הטלפון 053.');
  assert.equal(waText('תשובה\n\nמקורות:\n- https://a.com\n- https://b.com'), 'תשובה');
  assert.equal(waText('Sources of light are many'), 'Sources of light are many');
});

test('code blocks stay as they are', () => {
  assert.equal(waText('```\n**x** [a](https://b.c)\n```'), '```\n**x** [a](https://b.c)\n```');
});
