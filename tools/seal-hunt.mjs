#!/usr/bin/env node
// Seal and unseal the "For Unto Us" hunt.
//
// The plaintext hunt lives in hunt-private/hunt.json (git-ignored, never served). This tool turns it
// into star-hunt/hunt.sealed.js, which is safe to commit to the public repo: apart from a few public
// fields (title, intro, the verse phrases, ...) everything is AES-256-GCM encrypted.
//
//   node tools/seal-hunt.mjs seal   [--in hunt-private/hunt.json] [--out star-hunt/hunt.sealed.js]
//                                   [--new-codes] [--new-start-key] [--stamp star-hunt/version.js | --no-stamp]
//   node tools/seal-hunt.mjs unseal [--in star-hunt/hunt.sealed.js] [--out hunt-private/hunt.json | -] [--force]
//   node tools/seal-hunt.mjs new-passphrase [--words 5]
//   node tools/seal-hunt.mjs stamp  [--stamp star-hunt/version.js]
//
// seal and unseal read the MC passphrase from the environment variable STAR_HUNT_PASSPHRASE.
//
// Sealed format (format 1). Every binary value is standard base64, except entry ids, which are lowercase hex.
//   card    { kdf: 'PBKDF2-SHA256', iterations: 200000, salt }
//           For a card code C (normalized: upper case, letters and digits only) derive 64 bytes with
//           PBKDF2-HMAC-SHA256(password = UTF-8 of C, salt, iterations). Bytes 0-31 as hex are the entry id,
//           bytes 32-63 are the AES-256-GCM key for that entry.
//   entries [{ id, iv, ct }] one per station and per decoy, shuffled. iv is 12 bytes; ct is the AES-GCM
//           ciphertext with its 16-byte tag appended (the WebCrypto layout). The plaintext is UTF-8 JSON,
//           padded with trailing spaces so every entry has the same length:
//             station { kind: 'station', n, title, phrase, story, scriptures, ponder, challenge, art, nextClue }
//                     (nextClue is the riddle for clue n+1; the last station has none)
//             decoy   { kind: 'decoy' }
//   start   { iv, ct } -> { clue } (the riddle for clue 1), sealed with a random 32-byte START KEY. The MC
//           console writes the start key (base64) to meta/startKey when the hunt starts.
//   mc      { kdf: 'PBKDF2-SHA256', iterations: 600000, salt, iv, ct } -> { hunt, startKey }: the whole
//           private JSON plus the start key, sealed with PBKDF2-HMAC-SHA256(normalized passphrase) -> 32-byte key.
// star-hunt/seal.js does the same in the browser; tools/seal-test.mjs proves the two agree.
//
// No dependencies: Node 22's built-in WebCrypto (the same API the browser uses).

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';

const subtle = globalThis.crypto.subtle;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FORMAT = 1;
export const CARD_ITERATIONS = 200000;
export const MC_ITERATIONS = 600000;
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
export const CODE_LENGTH = 6;
export const TASK_TYPES = ['order', 'word', 'together', 'gifts'];
// Station fields that go into the station's sealed entry. Everything else (code, hide, clue, kids, hint,
// hint2, answer, solution, and any field added later) stays in the MC copy only.
export const ENTRY_FIELDS = ['title', 'phrase', 'story', 'scriptures', 'ponder', 'challenge', 'art'];
// Top-level fields that are public in the sealed file. Anything else at the top level stays private.
export const PUBLIC_FIELDS = ['title', 'subtitle', 'intro', 'decoyMessage', 'notYet', 'finale', 'cover'];
const PAD_BLOCK = 256;

// ---------- encodings (must match star-hunt/seal.js) ----------
const utf8 = s => new TextEncoder().encode(s);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const hex = bytes => Buffer.from(bytes).toString('hex');
const random = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

// Card codes: case, spaces and dashes don't matter.
export const normCode = raw => String(raw ?? '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Passphrases: case, surrounding space, and the separators between words don't matter
// ("Candle River" opens what "candle-river" sealed).
export const normPassphrase = raw => String(raw ?? '').normalize('NFKC').trim().toLowerCase()
  .replace(/[\s_.\-‐-―]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- crypto ----------
async function pbkdf2(password, salt, iterations, bits) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, bits));
}
const aesKey = raw => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function deriveCard(code, saltB64, iterations = CARD_ITERATIONS) {
  const bits = await pbkdf2(normCode(code), unb64(saltB64), iterations, 512);
  return { id: hex(bits.subarray(0, 32)), key: await aesKey(bits.slice(32)) };
}
async function deriveMC(passphrase, saltB64, iterations = MC_ITERATIONS) {
  return aesKey(await pbkdf2(normPassphrase(passphrase), unb64(saltB64), iterations, 256));
}
async function seal(key, value, padTo = 0) {
  let bytes = utf8(JSON.stringify(value));
  if (padTo > bytes.length) { const p = new Uint8Array(padTo).fill(0x20); p.set(bytes); bytes = p; }
  const iv = random(12);
  return { iv: b64(iv), ct: b64(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))) };
}
async function unseal(key, box) {
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}

// ---------- opening (the same three operations star-hunt/seal.js offers) ----------
// openCard(sealed, code) -> { kind: 'station', n, ... } | { kind: 'decoy' } | null
export async function openCard(sealed, code) {
  const c = normCode(code);
  if (!c) return null;
  const { id, key } = await deriveCard(c, sealed.card.salt, sealed.card.iterations);
  const entry = sealed.entries.find(e => e.id === id);
  return entry ? unseal(key, entry) : null;
}
// openStart(sealed, startKeyB64) -> { clue } | null
export async function openStart(sealed, startKeyB64) {
  try { return await unseal(await aesKey(unb64(startKeyB64)), sealed.start); } catch { return null; }
}
// openMC(sealed, passphrase) -> { hunt, startKey } | null
export async function openMC(sealed, passphrase) {
  if (!normPassphrase(passphrase)) return null;
  return unseal(await deriveMC(passphrase, sealed.mc.salt, sealed.mc.iterations), sealed.mc);
}

// ---------- validation ----------
const isText = v => typeof v === 'string' && v.trim() !== '';
export function validateHunt(h, { checkCodes = true } = {}) {
  const errors = [], warnings = [];
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { errors: ['The hunt must be a JSON object.'], warnings };
  for (const k of ['title', 'intro']) if (!isText(h[k])) errors.push(`Missing "${k}".`);
  if (!Array.isArray(h.stations) || !h.stations.length) errors.push('"stations" must be a non-empty array.');
  const stations = Array.isArray(h.stations) ? h.stations : [];
  const decoys = h.decoys == null ? [] : h.decoys;
  if (!Array.isArray(decoys)) errors.push('"decoys" must be an array.');
  stations.forEach((s, i) => {
    const at = `Station ${i + 1}${s && isText(s.title) ? ` (${s.title})` : ''}`;
    if (!s || typeof s !== 'object') { errors.push(`${at} is not an object.`); return; }
    for (const k of ['phrase', 'title', 'clue', 'story']) if (!isText(s[k])) errors.push(`${at}: missing "${k}".`);
    for (const k of ['hide', 'kids', 'hint', 'hint2']) if (!isText(s[k])) warnings.push(`${at}: no "${k}", so the MC can't release it.`);
    if (s.scriptures != null) {
      if (!Array.isArray(s.scriptures)) errors.push(`${at}: "scriptures" must be an array.`);
      else s.scriptures.forEach((v, j) => { if (!v || !isText(v.ref) || !isText(v.text)) errors.push(`${at}: scripture ${j + 1} needs "ref" and "text".`); });
    }
    const c = s.challenge;
    if (c != null) {
      if (!c || !TASK_TYPES.includes(c.type)) errors.push(`${at}: challenge.type must be one of ${TASK_TYPES.join(', ')}.`);
      else {
        if (!isText(c.prompt)) errors.push(`${at}: challenge needs a "prompt".`);
        if (c.type === 'order' && !(Array.isArray(c.items) && c.items.length >= 2 && c.items.every(isText))) errors.push(`${at}: an order task needs at least 2 "items".`);
        if (c.type === 'word' && !(Array.isArray(c.answers) && c.answers.length && c.answers.every(isText))) errors.push(`${at}: a word task needs "answers".`);
        if (c.type === 'gifts' && i !== stations.length - 1) warnings.push(`${at}: a gifts task is meant for the last station.`);
      }
    }
    if (s.art != null && !(s.art && isText(s.art.src))) errors.push(`${at}: "art" needs a "src".`);
    if (s.art && !(s.art.w > 0 && s.art.h > 0)) warnings.push(`${at}: art has no "w"/"h" (pages need them to reserve space).`);
  });
  if (decoys.length && !(h.decoyMessage && isText(h.decoyMessage.title) && isText(h.decoyMessage.text))) errors.push('"decoyMessage" needs "title" and "text".');
  if (!Array.isArray(h.notYet) || !h.notYet.length || !h.notYet.every(isText)) errors.push('"notYet" must be a non-empty array of lines.');
  if (!(h.finale && isText(h.finale.heading) && isText(h.finale.text))) warnings.push('No "finale" { heading, text }.');
  if (checkCodes) {
    const seen = new Map();
    const check = (code, where) => {
      if (!isText(code)) { errors.push(`${where}: no "code" (run seal with --new-codes to make them).`); return; }
      if (code !== normCode(code) || code.length < 4 || code.length > 16) errors.push(`${where}: code "${code}" must be 4-16 upper-case letters and digits.`);
      if (seen.has(code)) errors.push(`${where}: code is the same as ${seen.get(code)}.`);
      seen.set(code, where);
    };
    stations.forEach((s, i) => s && check(s.code, `Station ${i + 1}`));
    if (Array.isArray(decoys)) decoys.forEach((d, i) => check(d && d.code, `Decoy ${i + 1}`));
  }
  return { errors, warnings };
}

// Fresh random codes for every station and decoy (mutates the hunt).
export function assignNewCodes(h) {
  const used = new Set();
  const make = () => {
    let c;
    do { c = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(''); } while (used.has(c));
    used.add(c);
    return c;
  };
  // Put the code first in each object so it is easy to find when editing the private file.
  const withCode = ({ code, ...rest }) => ({ code: make(), ...rest });
  h.stations = h.stations.map(withCode);
  if (h.decoys) h.decoys = h.decoys.map(withCode);
  return h;
}

function shuffled(list) {
  const idx = list.map((_, i) => i);
  do {
    for (let i = idx.length - 1; i > 0; i--) { const j = randomInt(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  } while (idx.length > 1 && idx.every((v, i) => v === i)); // never leave them in station order
  return idx.map(i => list[i]);
}

// ---------- sealing ----------
// sealHunt(hunt, passphrase, { startKey }) -> the sealed object (what window.HUNT_SEALED holds)
export async function sealHunt(hunt, passphrase, { startKey } = {}) {
  const { errors } = validateHunt(hunt);
  if (errors.length) throw new Error('The hunt has problems:\n  ' + errors.join('\n  '));
  if (!normPassphrase(passphrase)) throw new Error('The passphrase is empty.');
  const stations = hunt.stations, decoys = hunt.decoys || [];
  const keyBytes = startKey ? unb64(startKey) : random(32);
  if (keyBytes.length !== 32) throw new Error('The start key must be 32 bytes.');
  startKey = b64(keyBytes);

  const card = { kdf: 'PBKDF2-SHA256', iterations: CARD_ITERATIONS, salt: b64(random(16)) };
  const plain = [
    ...stations.map((s, i) => {
      const e = { kind: 'station', n: i + 1 };
      for (const k of ENTRY_FIELDS) if (s[k] !== undefined) e[k] = s[k];
      if (i + 1 < stations.length) e.nextClue = stations[i + 1].clue;
      return { code: s.code, e };
    }),
    ...decoys.map(d => ({ code: d.code, e: { kind: 'decoy' } })),
  ];
  // Pad every entry to the same length so a decoy or the last station can't be told apart by size.
  const padTo = Math.ceil(Math.max(...plain.map(p => utf8(JSON.stringify(p.e)).length)) / PAD_BLOCK) * PAD_BLOCK;
  const entries = [];
  for (const p of shuffled(plain)) {
    const { id, key } = await deriveCard(p.code, card.salt, card.iterations);
    entries.push({ id, ...(await seal(key, p.e, padTo)) });
  }
  const startBox = await seal(await aesKey(keyBytes), { clue: stations[0].clue }, PAD_BLOCK * Math.ceil((utf8(stations[0].clue).length + 16) / PAD_BLOCK));
  const mcSalt = b64(random(16));
  const mcBox = await seal(await deriveMC(passphrase, mcSalt, MC_ITERATIONS), { hunt, startKey });

  const out = { format: FORMAT, sealedAt: new Date().toISOString() };
  for (const k of PUBLIC_FIELDS) if (hunt[k] !== undefined) out[k] = hunt[k];
  out.verse = { ref: (hunt.verse && hunt.verse.ref) || 'Isaiah 9:6', phrases: stations.map(s => s.phrase) };
  out.stationCount = stations.length;
  out.card = card;
  out.start = startBox;
  out.entries = entries;
  out.mc = { kdf: 'PBKDF2-SHA256', iterations: MC_ITERATIONS, salt: mcSalt, ...mcBox };
  return out;
}

// Re-open everything just sealed and compare with the source. Throws on any mismatch.
export async function verifySealed(sealed, hunt, passphrase) {
  const fail = msg => { throw new Error('Self-check failed: ' + msg); };
  const mc = await openMC(sealed, passphrase);
  if (!mc) fail('the MC copy does not open with the passphrase.');
  if (JSON.stringify(mc.hunt) !== JSON.stringify(hunt)) fail('the MC copy differs from the source.');
  const start = await openStart(sealed, mc.startKey);
  if (!start || start.clue !== hunt.stations[0].clue) fail('clue 1 does not open with the start key.');
  for (const [i, s] of hunt.stations.entries()) {
    const e = await openCard(sealed, s.code);
    if (!e || e.kind !== 'station' || e.n !== i + 1 || e.title !== s.title) fail(`station ${i + 1}'s card does not open its entry.`);
  }
  for (const [i, d] of (hunt.decoys || []).entries()) {
    const e = await openCard(sealed, d.code);
    if (!e || e.kind !== 'decoy') fail(`decoy ${i + 1}'s card does not open its entry.`);
  }
  return mc.startKey;
}

// ---------- files ----------
const HEADER = `// For Unto Us: the sealed hunt. Generated by \`node tools/seal-hunt.mjs seal\`; do not edit by hand.
// Edit hunt-private/hunt.json (not in the repo; \`node tools/seal-hunt.mjs unseal\` recreates it) and seal again.
// Only the fields at the top are public. Each card's entry opens with that card's code, clue 1 opens with
// the start key the MC publishes at Start, and the "mc" copy opens with the MC passphrase.
`;
export const sealedToJs = sealed => HEADER + 'window.HUNT_SEALED = ' + JSON.stringify(sealed, null, 2) + ';\n';
export function parseSealedJs(text) {
  const m = /window\.HUNT_SEALED\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text);
  if (!m) throw new Error('Not a sealed hunt file (no window.HUNT_SEALED = {...}).');
  const sealed = JSON.parse(m[1]);
  if (sealed.format !== FORMAT) throw new Error(`Sealed format ${sealed.format} is not supported (expected ${FORMAT}).`);
  return sealed;
}
export const buildStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
export const versionJs = stamp => `// Build stamp for cache-busting. Written by \`node tools/seal-hunt.mjs seal\` (or \`stamp\`); do not edit.
// Pages load this file fresh (version.js?t=<now>) and every other file with ?v=<build>, so a phone never
// mixes cached old files with new ones. See the head snippet in the screen builders' API notes.
window.STAR_HUNT_BUILD = '${stamp}';
// StarHuntAsset('art/x.jpg') -> 'art/x.jpg?v=<build>'
window.StarHuntAsset = function (path) {
  path = String(path);
  return path + (path.indexOf('?') < 0 ? '?' : '&') + 'v=' + encodeURIComponent(window.STAR_HUNT_BUILD);
};
// StarHuntLoad(['css/base.css', 'config.js', ...]) writes the <link> and <script> tags in this order.
// Call it from an inline <script> in <head> while the page is still loading.
window.StarHuntLoad = function (paths) {
  for (var i = 0; i < paths.length; i++) {
    var url = window.StarHuntAsset(paths[i]).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    document.write(/\\.css$/.test(paths[i]) ? '<link rel="stylesheet" href="' + url + '">' : '<script src="' + url + '"><\\/script>');
  }
};
`;

// ---------- passphrases ----------
// 1,500+ common, easy-to-spell English words; homophones and words with tricky spellings are left out.
export const WORDS = `
able acorn acrobat active actor admire agile airport album alert almond alphabet amber ample anchor
ancient angel answer ant anthem ape applaud apple apricot apron aquarium archery arena arrive arrow
artist aspen atlas attend attic aurora author autumn avenue avocado award baby backpack bacon badge
badger bagel bake baker bakery balance balcony ball ballet balloon bamboo banana bandana banjo banker
banner banquet barber bargain barn baseball basil basket bat bathtub baton battery beacon beaker beanbag
beaver beetle begin bench bicycle bike binder birch birthday bison black blanket blend blender bless
blessing blimp blink blizzard bloom blossom bluff boast boat bobcat bold bonfire bookcase borrow bottle
bounce bouncy bowl bowling box boxing bracelet branch brave bread breaker breeze breezy bridge brigade
bright brighten brisk broad bronze brook broom brother brown brownie brush bubble bubbly bucket buckle
budge bugle builder bulldog bulletin bundle bungalow bunny burrito bus butter button cab cabbage cabin
cabinet cable cackle cactus cadet cake calendar calf calm camel camera camper campus canal canary candle
candy canoe canoeing canopy canteen canyon capsule captain car caramel caravan cardinal careful cargo
carnival carol carousel carpet carriage carry cartoon carve cascade cashew cashier castle cat catch cave
cedar celery cello chair chalk champion chapel chapter charcoal chariot charm chase chatter checkers
cheer cheerful cheery cheese chef chemist cherry cherub chess chestnut chick chimney chipmunk chorus
chowder chuckle chunky church cinder circle circus citizen city clam clap clarinet classic clean clear
clever cliff climb clock closet cloud clover clown coach coaster cobalt cobbler cobra coconut cocoon
collect colony colt comedy comet comfort comfy compass composer comrade concert contest convoy cook
cookie copper corn cosmic costume cottage cotton couch cougar count cousin cove cover cow cowbell cowboy
coyote crab cracker cradle crafty crane crate crater crawl crayon cream creamy create cricket crimson
crisp crow crown crumpet crunch crunchy crystal cub cuddle cuddly cumin cup cupcake curator curling
curly curry curtain cushion custard cyan cycling dabble dainty daisy dance dancer dapper daring dart
dash dawn daybreak daydream dazzle dazzling decade decide deliver delta denim dentist depot desk diamond
dig dingo dinosaur diploma discover dish dispatch diving doctor dog dolphin domino donkey door doorbell
doorway dozen dragon draw drawer dream dreamy dresser dribble drift drink drive driver drum drumbeat
duck dumpling dune dusk dusty eager eagle early earmuff earth easel easy eat eclair editor eel egg
eggplant egret elbow elegant elephant elevator eleven elk embark embassy ember emblem emerald emu encore
engine engineer enjoy enter envelope equator eraser escape estuary even evening exact explore explorer
fable fabric falcon falconer family fan fancy fanfare farm farmer farmland fast father faucet fearless
feather fence fencing fern ferret ferry festival festive fetch fiddle fidget field fierce fiesta fig
figurine filament finch fine firefly firm fish fishbowl five fix fizzy flag flagpole flame flannel
flapjack flashy fleece float florist flotilla fluffy flute flutter fly foal fog fold folklore follow
fond football foothill forecast forest forgive fork forklift fortress fossil fountain fox foxglove
fragment fragrant frame freckle fresh freshman friend friendly frisky frog frolic frontier frost
frosting frosty fudge funnel fuzzy gadget galaxy gallant gallery gallop garage garden gardener garland
garlic gather gazebo gazelle gecko gemstone generous gentle gerbil geyser giant gigantic giggle ginger
gingham giraffe give glacier glad glasses gleaming gleeful glide glider glisten glitter globe glossy
glove glow goat gobble goblet gold golden goldfish gondola goodness goose gopher graceful gracious grand
granite granola grape grass grassy grateful gravity gravy green greeting grin gritty grocer grove grow
guard guide guitar gully gulp gumball gumdrop halftime hallway hammer hammock hamster handbook handy
happy harp harvest hatch hawk hayride hazelnut hazy headband headlamp healthy hearty hedgehog helium
helmet help helpful hen herald hero heron highway hike hiking hill hillside hilltop hinge hippo hobby
hockey holiday holly homework honest honey honeybee hook hop hopeful horizon hospital hound house hug
hum humble hundred hurdles hustle hut ibis iceberg icebox icicle icy igloo iguana imagine impala indigo
inkwell inlet insect inspire invent inventor iris ivory ivy jackal jacket jade jaguar jam jar jasmine
jaunty javelin jelly jet jigsaw jingle jog jolly journey jovial joyful jubilee judge juggle juggler
juggling juice juicy jukebox jump junction jungle kale karate kayak kazoo keen keep keepsake kettle
keyboard keystone kick kind kindly kindness kingdom kinship kitchen kite kitten kiwi knock koala
lacewing lacrosse ladder ladle ladybug lagoon lake lakeside lamb lamp landmark lanky lantern lanyard
large lark laugh laughter launch laundry lavender lavish lawyer leaf leafy learn legend lemon lemonade
lemur lentil leopard letter lettuce library lifeboat lift lilac lily lilypad lime limerick lineup linger
lion listen lively lizard llama lobby lobster locket lodestar lofty longboat lookout lotus lowland loyal
lucky lullaby lumber lunchbox lush macaroni magenta magic magical magician magnet magpie mailbox
majestic mallard mammal manatee mandolin manger mango mansion maple marathon marble march marigold
marina market marmot maroon marsh marzipan masthead mat mattress meadow meatball mechanic medley mellow
melody melon mend merchant mesa message meteor midday midnight mighty mild milk mill millpond mingle
minivan mink minnow mint minty miracle mirror mistral misty mitten mix modern mole monkey month moon
moonbeam mop mosaic moss mossy moth mother mountain mouse muffin muffler mug mulberry mule munch museum
music musical musician mustard nacho nap napkin narwhal natural nature navy neat nebula necklace nectar
needle net newt nibble nifty nimble nine noble noodle noon notebook notice nudge number nurse nurture
nutmeg nutty oak oakleaf oarsman oasis oat oatmeal oboe ocean ocelot octopus office officer olive onion
open optician orange orbit orca orchard orchid orderly ornament osprey otter outpost oven overcoat owl
oyster paddle paddock padlock pageant paint painter palace pan pancake panda panorama panther pantry
papaya parade park parka parrot parsley parsnip passport pasta pastry pasture pathway patient pavilion
peaceful peach peacock peanut pearl pebble pecan pelican pencil penguin pennant pepper perch perky petal
pharmacy piano pick pickle pickup pie pig pigeon piglet pillow pilot pine pinecone pink pinnacle
pinwheel pioneer pitch pitcher pizza plaid planet plant planter plate plateau platypus play playful
plaza plucky plunge pocket poem poet polished polite polka polo pond ponder pony poodle pool popcorn
popover poppy porch porridge possum postcard postman pot potato potluck potter prairie prance pretzel
promise prompt protect proud prowl pudding puddle puffin puffy pumpkin pupil puppet puppy purple push
puzzle python quack quail quarry quartet quest quick quiet quilt quilting quirky quiver quokka rabbit
race radiance radiant radio radish raft rainbow raincoat rainfall raisin rake ramble rampart ranch
ranger rapid rapids rattle raven ravioli reach ready recital recliner redwood reef reindeer rejoice
relax relay reporter rescue reunion ribbon rice rich riddle ride ridge ringlet river roadmap roam robin
robot robust rock rocket rocky rooftop roomy rooster rope rosebud rosy rowdy rowing royal ruby rugby
rugged ruler rummage run rust rustic rustle saddle safe saffron sailboat sailing salad salmon salsa
salty sand sandbar sandbox sandwich sandy sapling sardine satchel sauce saunter sausage savvy sawmill
scallop scamper scarf scarlet scenic school schooner scooter scout scribble sculptor scurry seahorse
seashell seashore seaside season secret seesaw sentinel serenade sesame seven shadow shaggy shamrock
share shark sheep shelf shelter shepherd sheriff shimmer shine shiny ship shipyard shoelace shop shore
shovel shrimp shuffle shy sidewalk signal silent silky silver simple sincere sing singer sink sister six
sizzle skate skating sketch ski skiing skillet skim skip skitter skunk sky skylark skyline sled sledding
sleek sleep sleepy sleet slide slipknot slipper sloth slurp smart smile smiley smooth smoothie snail
snake snappy sneeze snooze snorkel snow snowcap snowfall snowman snowy snug snuggle soap soccer sock
sofa soft softball solid solve song songbird sorbet sort soup spark sparkle sparkler sparkly sparrow
spatula speedy spicy spider spin spinach spindle spirit splash sponge spoon spotless spotted spring
springy sprinkle sprint spry spyglass squash squeak squeeze squid stable stack stadium stamp stapler
star starfish starling starry station steady steeple stellar stingray stir stocking stomp stone stool
stork storm stormy story stout stream stretch string strudel strum studio sturdy subway sugar sugary
suitcase summer summit sunbeam sundial sunlit sunny sunrise sunroom sunset super surfing surgeon swallow
swamp swan sweater swift swim swimming swing swirl syrup table tabletop taco tadpole tailor talk tall
tan tangy tanker tapestry taxi teach teacher teacup teal teammate teapot temple ten tender tennis tent
terrace terrier textbook thankful thicket thimble think thistle thousand three thrifty throw thunder
ticket tickle tidy tiger tinsel tiny tiptoe toast toasty today toddle toffee tomato tonight toolbelt
toolbox topsoil toucan tough towel tower town toy tractor train trainer tram tranquil trapeze travel
tray treasure tree treetop trellis tricycle trim trinket trivia trolley trophy tropical trot trout
trowel truck true truffle trumpet trust trusty tuba tugboat tulip tumble tumbler tuna tundra tunnel
turkey turnip turnpike turtle tuxedo twelve twenty twilight twinkle twinkly twirl umbrella umpire uncle
unicorn unicycle unwrap upbeat upland vacation vagabond valiant valley van vanilla vase vast velvet
vessel vibrant victory village vinegar violet violin visit vital vivid volcano voyage vulture waddle
waffle wagon waiter walk wallet walnut walrus wander warbler wardrobe warm wash wasp watch water wave
wavy weasel weekend welcome wetland wheat whirl whisper whistle white wiggle willow windmill window
windy wingspan wink winter wiry wise wish wishbone witty wizard wobble wolf wombat wooden woodland woody
workshop worm worship wreath wren wriggle writer yak yard yarn yawn year yearbook yellow yodel yoga
young zany zebra zesty zigzag zipper zippy zoo zoom
`.trim().split(/\s+/);
export function newPassphrase(words = 5) {
  return Array.from({ length: words }, () => WORDS[randomInt(WORDS.length)]).join('-');
}

// ---------- command line ----------
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (['new-codes', 'new-start-key', 'no-stamp', 'force', 'help'].includes(k)) opts[k] = true;
    else opts[k] = v ?? argv[++i];
  }
  return opts;
}
const exists = p => access(p).then(() => true, () => false);
const rel = p => relative(process.cwd(), p) || p;
const say = msg => process.stderr.write(msg + '\n');
function passphraseFromEnv() {
  const p = process.env.STAR_HUNT_PASSPHRASE;
  if (!p || !normPassphrase(p)) throw new Error('Set the MC passphrase in the environment variable STAR_HUNT_PASSPHRASE.');
  return p;
}
async function writeVersion(path) {
  const stamp = buildStamp();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, versionJs(stamp));
  return stamp;
}

async function cmdSeal(o) {
  const inPath = resolve(o.in || resolve(ROOT, 'hunt-private/hunt.json'));
  const outPath = resolve(o.out || resolve(ROOT, 'star-hunt/hunt.sealed.js'));
  const passphrase = passphraseFromEnv();
  if (normPassphrase(passphrase).length < 16) say('Warning: that passphrase is short. `node tools/seal-hunt.mjs new-passphrase` makes a strong one.');
  const hunt = JSON.parse(await readFile(inPath, 'utf8'));
  const pre = validateHunt(hunt, { checkCodes: !o['new-codes'] });
  for (const w of pre.warnings) say('Warning: ' + w);
  if (pre.errors.length) throw new Error('The hunt has problems:\n  ' + pre.errors.join('\n  '));
  if (o['new-codes']) {
    assignNewCodes(hunt);
    await writeFile(inPath, JSON.stringify(hunt, null, 2) + '\n');
    say(`Wrote ${hunt.stations.length + (hunt.decoys || []).length} new card codes into ${rel(inPath)}. Print the cards again.`);
  }
  // Keep the start key of the previous sealed file when it opens with this passphrase, so resealing during
  // a game doesn't strand players whose phones already use the published key.
  let startKey, reused = false;
  if (!o['new-start-key'] && await exists(outPath)) {
    try {
      const prev = await openMC(parseSealedJs(await readFile(outPath, 'utf8')), passphrase);
      if (prev && prev.startKey) { startKey = prev.startKey; reused = true; }
    } catch { /* not a sealed file we can open: make a new key */ }
  }
  const sealed = await sealHunt(hunt, passphrase, { startKey });
  await verifySealed(parseSealedJs(sealedToJs(sealed)), hunt, passphrase);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, sealedToJs(sealed));
  say(`Sealed ${hunt.stations.length} stations and ${(hunt.decoys || []).length} decoys into ${rel(outPath)}.`);
  say('Checked: every card opens its own entry, clue 1 opens with the start key, the MC copy opens with the passphrase.');
  say(reused ? 'Start key: kept from the previous sealed file.' : 'Start key: new (a game already started must be started again from the MC console).');
  if (!o['no-stamp']) {
    const vPath = resolve(o.stamp || resolve(ROOT, 'star-hunt/version.js'));
    say(`Build ${await writeVersion(vPath)} written to ${rel(vPath)}.`);
  }
}

async function cmdUnseal(o) {
  const inPath = resolve(o.in || resolve(ROOT, 'star-hunt/hunt.sealed.js'));
  const out = o.out || resolve(ROOT, 'hunt-private/hunt.json');
  const sealed = parseSealedJs(await readFile(inPath, 'utf8'));
  const mc = await openMC(sealed, passphraseFromEnv());
  if (!mc) throw new Error('That passphrase does not open ' + rel(inPath) + '.');
  const text = JSON.stringify(mc.hunt, null, 2) + '\n';
  if (out === '-') { process.stdout.write(text); return; }
  const outPath = resolve(out);
  if (await exists(outPath)) {
    const cur = await readFile(outPath, 'utf8');
    if (cur === text) { say(`${rel(outPath)} already matches ${rel(inPath)}.`); return; }
    if (!o.force) throw new Error(`${rel(outPath)} exists and differs from the sealed hunt. Use --force to overwrite it, or --out - to print.`);
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text);
  say(`Wrote ${rel(outPath)} (${mc.hunt.stations.length} stations, ${(mc.hunt.decoys || []).length} decoys).`);
}

const USAGE = `Usage:
  STAR_HUNT_PASSPHRASE=... node tools/seal-hunt.mjs seal   [--in hunt-private/hunt.json] [--out star-hunt/hunt.sealed.js]
                                                           [--new-codes] [--new-start-key] [--stamp star-hunt/version.js | --no-stamp]
  STAR_HUNT_PASSPHRASE=... node tools/seal-hunt.mjs unseal [--in star-hunt/hunt.sealed.js] [--out hunt-private/hunt.json | -] [--force]
  node tools/seal-hunt.mjs new-passphrase [--words 5]
  node tools/seal-hunt.mjs stamp [--stamp star-hunt/version.js]`;

async function main(argv) {
  const o = parseArgs(argv);
  const cmd = o._[0];
  if (cmd === 'seal') return cmdSeal(o);
  if (cmd === 'unseal') return cmdUnseal(o);
  if (cmd === 'new-passphrase') { process.stdout.write(newPassphrase(Number(o.words) || 5) + '\n'); return; }
  if (cmd === 'stamp') {
    const vPath = resolve(o.stamp || resolve(ROOT, 'star-hunt/version.js'));
    say(`Build ${await writeVersion(vPath)} written to ${rel(vPath)}.`);
    return;
  }
  say(USAGE);
  if (!o.help && cmd !== 'help') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(err => { say('Error: ' + err.message); process.exitCode = 1; });
}
