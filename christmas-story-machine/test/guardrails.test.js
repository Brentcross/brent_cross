import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewGuestText, isSafeNarration, fallbackCaption, tidy } from '../server/guardrails.js';

test('ordinary family stories pass', () => {
  for (const t of [
    'We saw a shooting star over the barn!',
    'Grandpa Dick told us about the Christmas he got a pocket knife.',
    'The turkey was huge and Uncle Bob fell asleep on the couch.',
    'Grandma passed away last spring and we lit a candle for her.',
  ]) assert.equal(reviewGuestText(t).ok, true, t);
});

test('profanity and mature content are held for the host', () => {
  assert.equal(reviewGuestText('this is sh1t').ok, false);
  assert.equal(reviewGuestText('a fucking great night').ok, false);
  assert.equal(reviewGuestText('fine', 'title with porn').ok, false);
});

test('AI narration never spoils Santa or mentions alcohol', () => {
  assert.equal(isSafeNarration('Santa is not real, kids.'), false);
  assert.equal(isSafeNarration('Dad had a beer by the fire.'), false);
  assert.equal(isSafeNarration('Visit https://example.com'), false);
  assert.equal(isSafeNarration('A cozy night of cocoa and carols.'), true);
});

test('fallback captions are warm and name the contributor', () => {
  const c = fallbackCaption({ type: 'drawing', name: 'Max', age: 4, seed: 'a' });
  assert.match(c, /Max/);
  assert.ok(isSafeNarration(c));
  assert.match(fallbackCaption({ type: 'photo', name: 'Sue', seed: 'b' }), /Sue/);
});

test('tidy trims and shortens on a word boundary', () => {
  assert.equal(tidy('  hello \n world  '), 'hello world');
  assert.ok(tidy('word '.repeat(100), 30).endsWith('…'));
});
