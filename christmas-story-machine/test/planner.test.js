import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offlinePlan, chooseStyle } from '../server/ai.js';
import { renderSceneLayers, normalizePlanScene, SETTINGS, ELEMENTS } from '../server/art/scene.js';

test('short single-moment stories become animated scenes', () => {
  assert.equal(chooseStyle('Santa came and ate all the cookies!', 1), 'animated');
  const p = offlinePlan({ id: 'x', name: 'Lily', text: 'We built a snowman and the dog ate his carrot nose!' });
  assert.equal(p.style, 'animated');
  assert.equal(p.scenes[0].setting, 'winter-village');
  assert.ok(p.scenes[0].elements.includes('snowman'));
});

test('long memories become narrated slideshows split into scenes', () => {
  const text = 'When I was a girl we lived on a farm in Idaho. '.repeat(4) + 'Every Christmas Eve father read the story of the first Christmas by the fire. '.repeat(3) + 'Then we walked to the little church and the bells rang across the valley.';
  const p = offlinePlan({ id: 'y', name: 'Grandma', text });
  assert.equal(p.style, 'slideshow');
  assert.ok(p.scenes.length >= 2 && p.scenes.length <= 8);
  assert.ok(p.scenes.every((s) => s.narration.length <= 420));
  // Nothing of the story is lost.
  assert.equal(p.scenes.map((s) => s.narration).join(' ').replace(/\s+/g, ' '), text.trim().replace(/\s+/g, ' '));
});

test('the Nativity gets a reverent stable scene', () => {
  const p = offlinePlan({ id: 'z', name: 'Ben', text: 'Baby Jesus was born in a manger in Bethlehem and the shepherds came.' });
  assert.equal(p.scenes[0].setting, 'nativity-stable');
  assert.equal(p.scenes[0].mood, 'reverent');
});

test('scene plans are clamped to the curated art library', () => {
  const s = normalizePlanScene({ setting: 'haunted-house', elements: ['zombie', 'dog', 'dog', 'star'] });
  assert.equal(s.setting, 'snowy-night');
  assert.deepEqual(s.elements, ['dog', 'star']);
});

test('every setting and element renders to SVG', () => {
  for (const setting of SETTINGS) {
    const l = renderSceneLayers({ setting, elements: ELEMENTS.slice(0, 6) }, setting);
    assert.match(l.full, /^<svg/);
    assert.ok(!l.full.includes('NaN') && !l.full.includes('undefined'), setting);
  }
  for (const e of ELEMENTS) {
    const l = renderSceneLayers({ setting: 'cozy-living-room', elements: [e] }, e);
    assert.ok(!l.full.includes('NaN') && !l.full.includes('undefined'), e);
  }
});

test('each moment of a story gets its own matching picture', async () => {
  const { storyboard } = await import('../server/storyboard.js');
  const s = storyboard('I always like when mom and I would spend time in the kitchen to make cookies, then we would place them under the tree with a glass of hot coco for Santa to enjoy. Then in the morning they were all gone!', { age: 12 });
  assert.equal(s.length, 3);
  assert.equal(s[0].setting, 'kitchen');
  assert.deepEqual(s[0].elements.slice(0, 2), ['child', 'adult'], 'a 12-year-old and mom');
  assert.equal(s[1].setting, 'cozy-living-room');
  assert.ok(s[1].elements.includes('cookies') && s[1].elements.includes('cocoa'), '"them" means the cookies');
  assert.ok(!s.some((x) => x.elements.includes('santa')), 'Santa is not drawn when cookies are only left for him');
  assert.equal(s[0].timeOfDay, 'night');
  assert.equal(s[2].timeOfDay, 'day', 'only the morning scene is in daylight');
  assert.ok(s[2].elements.includes('empty-plate'), 'the cookies are gone');
});

test('"when I was a little girl" draws the storyteller as a child', async () => {
  const { storyboard } = await import('../server/storyboard.js');
  const s = storyboard('When I was a little girl, we lived on a farm. Every Christmas Eve my father read by the fire. I still remember it every year.', { age: 78 });
  assert.equal(s[0].elements[0], 'child');
  assert.equal(s[1].setting, 'cozy-living-room');
  assert.equal(s.at(-1).elements[0], 'grandparent');
});
