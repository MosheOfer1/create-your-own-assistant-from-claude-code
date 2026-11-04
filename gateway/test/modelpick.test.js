import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickModel, STICKY_MS } from '../src/modelpick.js';

test('pickModel: prefixes, think words, hard words, length, lists, files, sticky', () => {
  const strong = (text, o) => pickModel(text, o).strong;
  assert.deepEqual(pickModel('אופוס: מה קורה'), { strong: true, text: 'מה קורה', reason: 'asked' });
  assert.deepEqual(pickModel('sonnet, plan my week'), { strong: false, text: 'plan my week', reason: 'asked' });
  for (const t of ['תחשוב טוב על זה', 'think hard about it', 'תתכנן לי את השבוע', 'בקוד הזה יש באג', 'compare these two', 'draft a letter to the bank']) assert.equal(strong(t), true, t);
  for (const t of ['מה השעה', 'thanks!', 'קודם תגיד לי שלום', 'planet earth', 'remind me at 5']) assert.equal(strong(t), false, t);
  assert.equal(strong('x'.repeat(401)), true);
  assert.equal(strong('a\n1. one\n2. two'), true);
  assert.equal(strong('hi', { files: 1 }), true);
  assert.equal(strong('hi', { now: 10, strongUntil: 10 + STICKY_MS }), true);
  assert.equal(strong('hi', { now: 10, strongUntil: 5 }), false);
});
