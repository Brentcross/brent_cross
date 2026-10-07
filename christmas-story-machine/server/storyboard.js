// Offline storyboarder: turns a typed story into scenes drawn from the art
// library, without any AI. Used when Claude is off or unavailable (and by the
// interactive preview). It works beat by beat:
//   1. split the story into beats at sentence ends and time/sequence words
//      ("then", "in the morning", "after dinner"...);
//   2. for each beat, score where the action happens, when, who is there and
//      what objects are mentioned — carrying place and time forward when a
//      beat doesn't say ("Then they were all gone!" stays in the same room);
//   3. merge neighbouring beats that would draw the same picture.
// Pure functions, no dependencies.

// ---------------------------------------------------------------- places (scored, strongest wins)
const PLACES = [
  ['kitchen', /\b(kitchen|bak(e|ed|es|ing)|oven|stove|cook(ed|ing)?|counter)\b/g, 3],
  ['kitchen', /\b(cookies?|gingerbread|dough|frosting|sprinkles|pie|dinner|breakfast)\b/g, 1],
  ['cozy-living-room', /\b(under the tree|living room|fireplace|chimney|by the fire|couch|sofa|stockings?|unwrap(ped|ping)?|opened (our |the )?presents)\b/g, 3],
  ['cozy-living-room', /\b(fire|hearth|rug|blankets?|pajamas)\b/g, 2],
  ['cozy-living-room', /\b(tree|presents?|gifts?|ornaments?|decorat(e|ed|ing))\b/g, 1.5],
  ['nativity-stable', /\b(baby jesus|manger|nativity|bethlehem|stable)\b/g, 4],
  ['church', /\b(church|chapel|mass|choir|pews?|sacrament|congregation)\b/g, 4],
  ['winter-village', /\b(snowman|snowmen|snowball|sledd?(ing|e)?|snow ?angels?|skating|outside in the snow)\b/g, 3],
  ['winter-village', /\b(drove|drive|driving|car|road trip|neighbou?rs?|caroling|carolling)\b/g, 2],
  ['snowy-forest', /\b(forest|woods|hike|hiking|cut(ting)? (down )?(a|the|our) tree)\b/g, 3],
  ['beach', /\b(beach|ocean|sand|swim(ming)?)\b/g, 3],
  ['summer-day', /\b(summer|park|picnic|camping)\b/g, 3],
  ['home-exterior', /\b(farm|front (door|porch|yard)|our house|grandma'?s house|grandpa'?s house|lights on the house)\b/g, 2],
  ['starry-sky', /\b(stars|night sky|shooting star|look(ed)? up at)\b/g, 1.5],
  ['snowy-night', /\b(outside|snow(ing|ed|fall)?|sleigh ride|north pole)\b/g, 1],
  ['snowy-night', /\b(santa|sleigh|reindeer|rudolph|elves|elf)\b/g, 0.5],
];

// ---------------------------------------------------------------- things to draw
const THINGS = [
  ['christmas-tree', /\b(christmas tree|the tree|our tree|a tree|tree)\b/],
  ['presents', /\b(presents?|gifts?|unwrap(ped|ping)?|wrapping)\b/],
  ['cookies', /\b(cookies?|treats|biscuits)\b/],
  ['cocoa', /\b(cocoa|coco|hot chocolate|hot coco|milk|mug)\b/],
  ['gingerbread', /\b(gingerbread)\b/],
  ['candles', /\b(candles?|candlelight)\b/],
  ['stockings', /\b(stockings?)\b/],
  ['wreath', /\b(wreath)\b/],
  ['string-lights', /\b(lights)\b/],
  ['bells', /\b(bells?)\b/],
  ['snowman', /\b(snowman|snowmen)\b/],
  ['sled', /\b(sled|sledd?ing)\b/],
  ['reindeer', /\b(reindeer|rudolph)\b/],
  ['sleigh', /\b(sleigh)\b/],
  ['santa', /\b(santa|st\.? nick|father christmas)\b/],
  ['angel', /\b(angels?)\b/],
  ['shepherd', /\b(shepherds?)\b/],
  ['sheep', /\b(sheep|lambs?)\b/],
  ['manger', /\b(manger|baby jesus)\b/],
  ['donkey', /\b(donkey)\b/],
  ['wise-man', /\b(wise ?m[ae]n|magi|kings)\b/],
  ['dog', /\b(dogs?|puppy|puppies)\b/],
  ['cat', /\b(cats?|kitten)\b/],
  ['piano', /\b(piano)\b/],
  ['books', /\b(books?|read(ing)? (the|a|us))\b/],
  ['car', /\b(car|drove|driving)\b/],
  ['star', /\b(star|stars)\b/],
  ['moon', /\b(moon)\b/],
  ['dove', /\b(dove)\b/],
  ['house', /\b(house)\b/],
];
const PEOPLE = [
  ['grandparent', /\b(grandma|grandpa|grandmother|grandfather|granny|nana|papa|gramps|abuela|abuelo|oma|opa|grandparents)\b/],
  ['adult', /\b(mom|mommy|mum|mother|dad|daddy|father|aunt|auntie|uncle|parents)\b/],
  ['child', /\b(brother|sister|cousins?|baby|kids|children|son|daughter|siblings?)\b/],
];
const PERSON = new Set(['child', 'adult', 'grandparent', 'family', 'santa', 'shepherd', 'wise-man', 'angel']);
// Things that only make sense in some places.
const OUTDOOR_ONLY = new Set(['snowman', 'sled', 'sleigh', 'reindeer', 'car', 'house', 'donkey', 'sheep', 'moon']);
const INDOOR = new Set(['cozy-living-room', 'kitchen']);

// Sequence words that start a new moment.
const BREAK = /(?:,\s*|\s+)(?=(?:and\s+)?(?:then|after that|afterwards?|later|the next (?:morning|day)|in the morning|that night|when we woke up|when i woke up|on christmas morning|finally|after dinner|after (?:that|we)\b))/i;

const words = (s) => (String(s).match(/\S+/g) || []).length;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function splitBeats(text) {
  const sentences = clean(text).match(/[^.!?…]+[.!?…]*["”')]?/g)?.map((s) => s.trim()).filter(Boolean) || [clean(text)];
  const beats = [];
  for (const s of sentences) {
    const parts = s.split(BREAK).map((p) => p.trim()).filter(Boolean);
    // keep very short fragments with their neighbour
    for (const p of parts) {
      if (beats.length && (p.length < 25 || beats[beats.length - 1].length < 25) && !/[.!?…]["”')]?$/.test(beats[beats.length - 1])) beats[beats.length - 1] += ' ' + p;
      else beats.push(p);
    }
  }
  return beats.map((b) => cap(b.replace(/^(?:and\s+)/i, '')));
}

// Who is telling the story, drawn by age when they say "I", "me" or "we".
function narratorElement(age) {
  const a = Number(age);
  if (!Number.isFinite(a) || age === '' || age == null) return 'adult';
  if (a < 16) return 'child';
  if (a >= 60) return 'grandparent';
  return 'adult';
}

export function analyzeBeat(text, prev, { age } = {}) {
  const t = ' ' + text.toLowerCase().replace(/[’']/g, "'") + ' ';
  // Santa is only drawn when he is in the scene, not when something is "for Santa".
  const forSanta = /\b(for|to|from|letter to|wait(ing|ed)? for|leave (it )?for)\s+santa\b/;
  const t2 = forSanta.test(t) ? t.replace(/\b(for|to|from|letter to|wait(ing|ed)? for|leave (it )?for)\s+santa('s)?\b/g, ' ') : t;

  // place
  const scores = new Map();
  for (const [place, re, w] of PLACES) {
    const n = (t2.match(re) || []).length;
    if (n) scores.set(place, (scores.get(place) || 0) + n * w);
  }
  let setting = null;
  let best = 0;
  for (const [p, s] of scores) if (s > best) [setting, best] = [p, s];
  if (!setting || (best < 1.5 && prev)) setting = prev?.setting || setting || 'cozy-living-room';

  // time
  let timeOfDay = prev?.timeOfDay || 'night';
  if (/\b(morning|woke up|breakfast|sunrise|afternoon|sunny|daytime|during the day|that day)\b/.test(t)) timeOfDay = 'day';
  else if (/\b(evening|sunset|dusk|supper)\b/.test(t)) timeOfDay = 'evening';
  else if (/\b(night|tonight|midnight|dark|bedtime|christmas eve)\b/.test(t)) timeOfDay = 'night';
  if (['beach', 'summer-day'].includes(setting)) timeOfDay = 'day';

  // mood
  let mood = prev?.mood || 'cozy';
  if (/\b(jesus|pray|prayed|prayer|church|holy|bless|blessed|miss (her|him|them)|passed away|in heaven|remember)\b/.test(t)) mood = 'reverent';
  else if (/\b(laugh|laughed|funny|silly|giggl)/.test(t)) mood = 'funny';
  else if (/\b(santa|magic|magical|reindeer|elves|sparkl)/.test(t2)) mood = 'magical';
  else if (/\b(played|fun|excited|yay|best|happy|sang|danced)\b/.test(t)) mood = 'joyful';
  else if (/\b(quiet|peaceful|calm|snow fell)\b/.test(t)) mood = 'peaceful';

  // people
  // "When I was a little girl…" draws the storyteller as a child until the story returns to today.
  let flashback = prev?.flashback || false;
  if (/\bwhen i was (a |an |)(little|young|small|kid|child|boy|girl|teenager|\d+)/.test(t)) flashback = true;
  else if (/\b(still|now|today|these days|every year)\b/.test(t)) flashback = false;
  const people = [];
  for (const [el, re] of PEOPLE) if (re.test(t)) people.push(el);
  if (/\blittle [A-Z][a-z]+/.test(text) && !people.includes('child')) people.push('child'); // "little Rose"
  const iSpeak = /\b(i|me|my|i'm|i've|we|us|our)\b/.test(t);
  if (/\b(i|me|my|i'm|i've)\b/.test(t)) people.unshift(flashback ? 'child' : narratorElement(age));
  else if (/\b(we|us|our)\b/.test(t) && !people.length) {
    // "we" after a scene with two or more people means those same people
    const before = (prev?.elements || []).filter((e) => ['child', 'adult', 'grandparent'].includes(e));
    people.push(...(before.length >= 2 ? before : ['family']));
  }

  // things
  const things = [];
  for (const [el, re] of THINGS) if (re.test(el === 'santa' ? t2 : t)) things.push(el);
  // "them / it / they" points back at the things in the previous scene
  const before = (prev?.elements || []).filter((e) => !PERSON.has(e) && e !== 'christmas-tree');
  if (/\b(them|they|it)\b/.test(t) && before.length) for (const e of before) if (!things.includes(e)) things.push(e);
  // "they were all gone" after leaving treats out → an empty plate with crumbs
  const gone = /\b(all gone|were gone|was gone|gone|crumbs|empty plate|ate (them|it|all|every))\b/.test(t);
  if (gone && (things.includes('cookies') || things.includes('empty-plate') || /crumbs/.test(t) && (prev?.elements || []).some((e) => e === 'cookies' || e === 'empty-plate'))) {
    for (const food of ['cookies', 'cocoa', 'gingerbread']) {
      const i = things.indexOf(food);
      if (i >= 0) things.splice(i, 1);
    }
    if (!things.includes('empty-plate')) things.push('empty-plate');
  }
  // a beat that names no objects keeps the key props of the previous scene in the same place
  if (!things.length && prev && prev.setting === setting) things.push(...prev.elements.filter((e) => !PERSON.has(e) && e !== 'cookies').slice(0, 2));
  if (setting === 'cozy-living-room' && !things.includes('christmas-tree') && !things.includes('piano')) things.unshift('christmas-tree');
  if (setting === 'nativity-stable' && !things.includes('manger')) things.unshift('manger');

  let elements = [...new Set([...people, ...things])];
  if (INDOOR.has(setting)) elements = elements.filter((e) => !OUTDOOR_ONLY.has(e));
  // If nobody is named but the story is about people doing things, show the family.
  if (!elements.some((e) => PERSON.has(e)) && iSpeak) elements.unshift('family');
  if (!elements.length) elements.push(INDOOR.has(setting) ? 'christmas-tree' : 'star');
  // Keep pictures readable: people first (max 3), then up to 3 things, 5 total.
  const ppl = elements.filter((e) => PERSON.has(e)).slice(0, 3);
  const obj = elements.filter((e) => !PERSON.has(e)).slice(0, 5 - ppl.length);
  return { setting, timeOfDay, mood, elements: [...ppl, ...obj], flashback };
}

const same = (a, b) => a.setting === b.setting && a.timeOfDay === b.timeOfDay && a.elements.join() === b.elements.join();

export function storyboard(text, { age, maxChars = 220, maxScenes = 8 } = {}) {
  const beats = splitBeats(text);
  const scenes = [];
  let prev = null;
  for (const beat of beats) {
    const { flashback, ...scene } = analyzeBeat(beat, prev, { age });
    const last = scenes[scenes.length - 1];
    if (last && (same(last, scene) || beat.length < 20) && (last.narration + ' ' + beat).length <= maxChars) {
      last.narration += ' ' + beat;
    } else if (last && beat.length > maxChars) {
      // very long sentence: show it across scenes of the same picture
      for (const part of beat.match(new RegExp(`.{1,${maxChars - 20}}(\\s|$)`, 'g')).map((x) => x.trim())) scenes.push({ narration: part, ...scene });
    } else {
      scenes.push({ narration: beat, ...scene });
    }
    prev = { ...scene, flashback };
  }
  while (scenes.length > maxScenes) {
    let bi = 0;
    for (let i = 1; i < scenes.length - 1; i++) if (scenes[i].narration.length + scenes[i + 1].narration.length < scenes[bi].narration.length + scenes[bi + 1].narration.length) bi = i;
    scenes.splice(bi, 2, { ...scenes[bi], narration: `${scenes[bi].narration} ${scenes[bi + 1].narration}` });
  }
  return scenes;
}

export function chooseStyle(text, sceneCount) {
  // Short stories become animated scenes (up to three moments);
  // longer or many-moment memories become a narrated Ken Burns slideshow.
  return words(text) <= 70 && sceneCount <= 3 ? 'animated' : 'slideshow';
}
