#!/usr/bin/env node
// Tests for the sealed hunt: tools/seal-hunt.mjs (Node) and star-hunt/seal.js (the browser, in Chromium).
//
//   node tools/seal-test.mjs                  everything, using the sample hunt in tools/fixtures/
//   node tools/seal-test.mjs --skip-browser   without Chromium
//   STAR_HUNT_PASSPHRASE=... node tools/seal-test.mjs
//                                             also checks the real star-hunt/hunt.sealed.js the same way (and
//                                             that it matches hunt-private/hunt.json when that file exists);
//                                             fails if that passphrase doesn't open it
//   node tools/seal-test.mjs --release        (or STAR_HUNT_RELEASE=1) before a real deploy: also fails if
//                                             star-hunt/hunt.sealed.js is still the sample (opens with the test
//                                             passphrase) or any public card code (the sample's, the old
//                                             hunt.js's) opens one of its cards
//
// What it proves: seal -> unseal is lossless; every station and decoy code opens its own entry and only
// that one; wrong codes open nothing; clue 1 opens only with the start key; the MC copy opens only with the
// passphrase; no secret text (codes, hiding spots, answers, solutions, hints, little-ones lines, riddles,
// station titles, stories, scriptures, ponder lines, task prompts) appears anywhere in the sealed file;
// entries are shuffled; and star-hunt/seal.js in Chromium derives the same ids and opens the same data
// as the Node tool, byte for byte.
//
// The browser part needs `playwright` importable from the repo (symlink a node_modules folder into the
// repo root) and Chromium: CHROMIUM=/path/to/chrome, or the first /opt/pw-browsers/chromium-*/chrome-linux*/chrome.
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import vm from 'node:vm';
import http from 'node:http';
import * as T from './seal-hunt.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tools/fixtures/sample-hunt.json');
const FIXTURE_SEALED = join(ROOT, 'tools/fixtures/sample-hunt.sealed.js');
const SITE_SEALED = join(ROOT, 'star-hunt/hunt.sealed.js');
const TOOL = join(ROOT, 'tools/seal-hunt.mjs');
const TEST_PASS = 'test-passphrase';
const skipBrowser = process.argv.includes('--skip-browser');
const releaseCheck = process.argv.includes('--release') || process.env.STAR_HUNT_RELEASE === '1';
const STRONG = 'candle-river-lamp-meadow-violin';   // a throwaway strong passphrase for the command-line tests
const subtle = globalThis.crypto.subtle;

// Failures always print; passing checks print with VERBOSE=1, otherwise each section shows a tally.
let failures = 0, passes = 0, sectionOk = 0, sectionName = '';
function expect(cond, msg) {
  if (cond) { passes++; sectionOk++; } else failures++;
  if (!cond || process.env.VERBOSE) console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  return !!cond;
}
function section(name) {
  if (sectionName) console.log(`   ${sectionOk} ok  ${sectionName}`);
  sectionName = name; sectionOk = 0;
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const randomB64 = n => b64(globalThis.crypto.getRandomValues(new Uint8Array(n)));
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
function randomCode(exclude) {
  let c;
  do { c = Array.from({ length: 6 }, () => T.CODE_ALPHABET[Math.floor(Math.random() * T.CODE_ALPHABET.length)]).join(''); } while (exclude.has(c));
  return c;
}

// Every string in the private hunt that must never be readable in the sealed file.
function secretsOf(h) {
  const out = [];
  const add = (label, v) => { if (typeof v === 'string' && v.trim().length >= 4) out.push([label, v]); };
  h.stations.forEach((s, i) => {
    const at = `station ${i + 1}`;
    for (const k of ['code', 'hide', 'answer', 'solution', 'clue', 'kids', 'hint', 'hint2', 'story', 'ponder', 'title']) add(`${at} ${k}`, s[k]);
    if (typeof s.clue === 'string') s.clue.split('\n').forEach((line, j) => { if (line.trim().length >= 12) add(`${at} riddle line ${j + 1}`, line.trim()); });
    (s.scriptures || []).forEach((v, j) => add(`${at} scripture ${j + 1} text`, v && v.text));
    if (s.challenge) {
      add(`${at} task prompt`, s.challenge.prompt);
      (s.challenge.items || []).forEach((x, j) => { if (typeof x === 'string' && x.length >= 12) add(`${at} task item ${j + 1}`, x); });
    }
  });
  (h.decoys || []).forEach((d, i) => { add(`decoy ${i + 1} code`, d.code); add(`decoy ${i + 1} hide`, d.hide); });
  if (h.finale) add('finale text', h.finale.text);   // sealed in the last station: it tends to name the last hiding place
  return out;
}

// Does key open entry? (raw AES-GCM, no id lookup)
async function opens(key, box) {
  try { await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(box.iv, 'base64') }, key, Buffer.from(box.ct, 'base64')); return true; }
  catch { return false; }
}

// ---------- the full set of checks for one sealed file ----------
async function checkSealed(label, text, passphrase, expectedHunt) {
  section(`${label}: structure and public fields`);
  let sealed;
  try { sealed = T.parseSealedJs(text); } catch (e) { expect(false, `${label} parses (${e.message})`); section(''); return null; }
  expect(text.startsWith('//') && /window\.HUNT_SEALED = \{/.test(text), 'sets window.HUNT_SEALED');
  const mc = await T.openMC(sealed, passphrase);
  if (!expect(mc && mc.hunt, 'the MC copy opens with the passphrase')) { section(''); return null; }
  const hunt = mc.hunt;
  if (expectedHunt) expect(isDeepStrictEqual(hunt, expectedHunt), 'the MC copy equals the private JSON exactly (lossless)');
  const stations = hunt.stations, decoys = hunt.decoys || [];
  const allowed = new Set(['format', 'sealedAt', ...T.PUBLIC_FIELDS, 'verse', 'stationCount', 'card', 'start', 'entries', 'mc']);
  const extra = Object.keys(sealed).filter(k => !allowed.has(k));
  expect(!extra.length, `only known top-level fields are public${extra.length ? ' (extra: ' + extra.join(', ') + ')' : ''}`);
  for (const k of T.PUBLIC_FIELDS) if (hunt[k] !== undefined) expect(isDeepStrictEqual(sealed[k], hunt[k]), `public "${k}" matches the private JSON`);
  expect(sealed.finale === undefined && !T.PUBLIC_FIELDS.includes('finale'), 'the finale is not public (it is sealed in the last station)');
  expect(isDeepStrictEqual(sealed.verse.phrases, stations.map(s => s.phrase)), 'verse.phrases lists every station phrase in order');
  expect(sealed.stationCount === stations.length, `stationCount is ${stations.length}`);
  expect(sealed.entries.length === stations.length + decoys.length, `${stations.length + decoys.length} entries (stations + decoys)`);
  expect(sealed.card.kdf === 'PBKDF2-SHA256' && sealed.card.iterations === 200000 && Buffer.from(sealed.card.salt, 'base64').length === 16, 'cards: PBKDF2-SHA256, 200,000 iterations, 16-byte salt');
  expect(sealed.mc.kdf === 'PBKDF2-SHA256' && sealed.mc.iterations === 600000 && Buffer.from(sealed.mc.salt, 'base64').length === 16, 'MC copy: PBKDF2-SHA256, 600,000 iterations, 16-byte salt');
  expect(sealed.entries.every(e => /^[0-9a-f]{64}$/.test(e.id) && Buffer.from(e.iv, 'base64').length === 12), 'entry ids are 32-byte hex, ivs are 12 bytes');
  expect(new Set(sealed.entries.map(e => e.id)).size === sealed.entries.length, 'entry ids are unique');
  expect(new Set(sealed.entries.map(e => e.ct.length)).size === 1, 'every entry has the same length (decoys look like stations)');

  section(`${label}: MC passphrase`);
  const variants = [`  ${passphrase.toUpperCase()}  `, passphrase.replace(/-/g, ' ')];
  for (const v of variants) expect((await T.openMC(sealed, v)) !== null, `passphrase variant ${JSON.stringify(v)} opens the MC copy`);
  for (const wrong of ['', 'wrong-passphrase', passphrase + 'x', passphrase.slice(0, -1)]) {
    expect((await T.openMC(sealed, wrong)) === null, `wrong passphrase ${JSON.stringify(wrong)} opens nothing`);
  }
  expect(Buffer.from(mc.startKey, 'base64').length === 32, 'the MC copy carries the 32-byte start key');

  section(`${label}: clue 1 and the start key`);
  const start = await T.openStart(sealed, mc.startKey);
  expect(start && start.clue === stations[0].clue && Object.keys(start).join() === 'clue', 'the start key opens clue 1 (and only the riddle)');
  const flipped = Buffer.from(mc.startKey, 'base64'); flipped[0] ^= 1;
  for (const [what, key] of [['a random key', randomB64(32)], ['the start key with one bit changed', b64(flipped)], ['a 16-byte key', randomB64(16)], ['garbage', '!!!'], ['nothing', '']]) {
    expect((await T.openStart(sealed, key)) === null, `${what} does not open clue 1`);
  }
  let startOpeners = 0;
  for (const s of [...stations, ...decoys]) {
    const { key } = await T.deriveCard(s.code, sealed.card.salt, sealed.card.iterations);
    if (await opens(key, sealed.start)) startOpeners++;
  }
  expect(!startOpeners, 'no card code opens clue 1');

  section(`${label}: every card opens its own entry and only that one`);
  const real = new Set([...stations, ...decoys].map(s => s.code));
  const positions = [];
  const cards = [...stations.map((s, i) => ({ code: s.code, station: s, n: i + 1 })), ...decoys.map(d => ({ code: d.code, decoy: true }))];
  for (const c of cards) {
    const e = await T.openCard(sealed, c.code);
    const { id, key } = await T.deriveCard(c.code, sealed.card.salt, sealed.card.iterations);
    const openedBy = [];
    for (const [j, entry] of sealed.entries.entries()) if (await opens(key, entry)) openedBy.push(j);
    const pos = sealed.entries.findIndex(x => x.id === id);
    positions.push(pos);
    expect(openedBy.length === 1 && openedBy[0] === pos, `${c.decoy ? 'decoy' : 'station ' + c.n} key decrypts exactly one entry, the one with its id`);
    if (c.decoy) { expect(isDeepStrictEqual(e, { kind: 'decoy' }), `decoy ${c.code} opens { kind: 'decoy' } and nothing more`); continue; }
    const s = c.station;
    const want = { kind: 'station', n: c.n };
    for (const k of T.ENTRY_FIELDS) if (s[k] !== undefined) want[k] = s[k];
    if (c.n < stations.length) want.nextClue = stations[c.n].clue;
    else if (hunt.finale !== undefined) want.finale = hunt.finale;
    expect(isDeepStrictEqual(e, want), `station ${c.n} opens exactly { kind, n, ${T.ENTRY_FIELDS.join(', ')}${c.n < stations.length ? ', nextClue' : hunt.finale !== undefined ? ', finale' : ''} }`);
    for (const v of [c.code.toLowerCase(), c.code.slice(0, 3) + ' - ' + c.code.slice(3), ` ${c.code}\n`]) {
      expect(isDeepStrictEqual(await T.openCard(sealed, v), e), `code typed as ${JSON.stringify(v)} opens the same entry`);
    }
  }
  expect(new Set(positions).size === cards.length, 'each card maps to a different entry');

  section(`${label}: wrong codes`);
  const wrongs = new Set(['', '-', 'ABC', 'ZZZZZZ', '000000']);
  for (const c of real) {
    for (const i of [0, 5]) {
      const alt = T.CODE_ALPHABET.split('').find(ch => ch !== c[i]);
      wrongs.add(c.slice(0, i) + alt + c.slice(i + 1));
    }
    wrongs.add(c + 'A'); wrongs.add(c.slice(1));
  }
  for (let i = 0; i < 12; i++) wrongs.add(randomCode(real));
  let wrongOk = 0;
  for (const w of wrongs) if (real.has(T.normCode(w)) || (await T.openCard(sealed, w)) === null) wrongOk++;
  expect(wrongOk === wrongs.size, `${wrongs.size} wrong codes (near misses, random, empty) all open nothing`);

  section(`${label}: entries are shuffled`);
  const stationPositions = positions.slice(0, stations.length);
  expect(!positions.every((p, i) => p === i), `entries are not in station order (station 1 is entry ${stationPositions[0] + 1}, decoys at ${positions.slice(stations.length).map(p => p + 1).join(', ') || 'none'})`);

  section(`${label}: no secret text in the sealed file`);
  const secrets = secretsOf(hunt);
  const leaks = secrets.filter(([, v]) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)));
  expect(!leaks.length, `none of ${secrets.length} secret strings appears in the file${leaks.length ? ': ' + leaks.map(l => l[0]).join('; ') : ''}`);
  expect(![...real].some(c => text.includes(c)), 'no card code appears in the file');
  return { sealed, hunt, startKey: mc.startKey, positions };
}

// ---------- tests ----------
const fixture = await readJson(FIXTURE);
const runTool = (args, env = {}) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, STAR_HUNT_PASSPHRASE: TEST_PASS, ...env } });

section('word list, passphrases, codes, validation');
expect(T.WORDS.length >= 1000, `the passphrase word list has ${T.WORDS.length} words (at least 1,000)`);
expect(new Set(T.WORDS).size === T.WORDS.length, 'no word is listed twice');
expect(T.WORDS.every(w => /^[a-z]{3,8}$/.test(w)), 'every word is 3-8 lower-case letters');
{
  const r = runTool(['new-passphrase']);
  const words = r.stdout.trim().split('-');
  expect(r.status === 0 && words.length === 5 && words.every(w => T.WORDS.includes(w)), `new-passphrase prints 5 listed words joined by hyphens (${r.stdout.trim()})`);
  const many = new Set(Array.from({ length: 50 }, () => T.newPassphrase()));
  expect(many.size === 50, '50 new passphrases are all different');
}
expect(T.normCode(' ab-c 12\n') === 'ABC12' && T.normCode(null) === '', 'normCode upper-cases and drops spaces and dashes');
expect(T.normPassphrase('  Candle River—Lamp ') === 'candle-river-lamp' && T.normPassphrase('candle_river.lamp') === 'candle-river-lamp', 'normPassphrase ignores case and word separators');
{
  const v = T.validateHunt(fixture);
  expect(!v.errors.length, `the sample hunt is valid${v.errors.length ? ': ' + v.errors.join(' ') : ''}`);
  const types = fixture.stations.map(s => s.challenge && s.challenge.type);
  expect(['order', 'word', 'together', 'gifts'].every(t => types.includes(t)), 'the sample hunt covers all four task types');
  expect((fixture.decoys || []).length === 2, 'the sample hunt has 2 decoys');
  const bad = structuredClone(fixture);
  bad.stations[1].code = bad.stations[0].code; delete bad.stations[2].clue; bad.stations[0].challenge = { type: 'dance', prompt: 'x' };
  const e = T.validateHunt(bad).errors.join('\n');
  expect(/same as/.test(e) && /missing "clue"/.test(e) && /challenge\.type/.test(e), 'validation catches a duplicate code, a missing riddle and an unknown task type');
}

// 1. A fresh seal of the sample hunt, in memory.
const fresh = await T.sealHunt(structuredClone(fixture), TEST_PASS);
const freshText = T.sealedToJs(fresh);
const freshResult = await checkSealed('fresh seal of the sample hunt', freshText, TEST_PASS, fixture);

// 2. The committed development file must match the fixture.
const committedText = await readFile(FIXTURE_SEALED, 'utf8');
const committed = await checkSealed('tools/fixtures/sample-hunt.sealed.js', committedText, TEST_PASS, fixture);

// 3. The command line: --new-codes, seal, unseal, start key reuse, the safety refusals, stamp.
section('command line');
const tmp = await mkdtemp(join(tmpdir(), 'seal-test-'));
try {
  const noCodes = structuredClone(fixture);
  for (const s of [...noCodes.stations, ...noCodes.decoys]) delete s.code;
  const hPath = join(tmp, 'hunt.json'), sPath = join(tmp, 'hunt.sealed.js'), backPath = join(tmp, 'back.json'), vPath = join(tmp, 'version.js');
  const P = { STAR_HUNT_PASSPHRASE: STRONG };
  await writeFile(hPath, JSON.stringify(noCodes, null, 2) + '\n');
  let r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp'], P);
  expect(r.status === 1 && /no "code"/.test(r.stderr), 'seal refuses a hunt without codes (and says to use --new-codes)');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--stamp', vPath], { STAR_HUNT_PASSPHRASE: '' });
  expect(r.status === 1 && /STAR_HUNT_PASSPHRASE/.test(r.stderr), 'seal refuses to run without STAR_HUNT_PASSPHRASE');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--new-codes', '--no-stamp'], { STAR_HUNT_PASSPHRASE: TEST_PASS });
  expect(r.status === 1 && /public test passphrase/.test(r.stderr) && !existsSync(sPath), 'seal refuses the public test passphrase for a real hunt');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--new-codes', '--no-stamp'], { STAR_HUNT_PASSPHRASE: 'short pass' });
  expect(r.status === 1 && /shorter than 16/.test(r.stderr) && !existsSync(sPath), 'seal refuses a passphrase under 16 characters');
  expect(isDeepStrictEqual(await readJson(hPath), noCodes), 'a refused seal leaves the private file alone (no codes written)');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--new-codes', '--stamp', vPath], P);
  expect(r.status === 0, `seal --new-codes succeeds${r.status ? ': ' + r.stderr : ''}`);
  const withCodes = await readJson(hPath);
  const codes = [...withCodes.stations, ...withCodes.decoys].map(s => s.code);
  const publicCodes = await T.publicCodes();
  expect(codes.every(c => new RegExp(`^[${T.CODE_ALPHABET}]{6}$`).test(c)), `--new-codes writes 6-character codes from ${T.CODE_ALPHABET}`);
  expect(new Set(codes).size === codes.length, '--new-codes makes every code unique');
  expect(!codes.some(c => publicCodes.has(c)) && publicCodes.size >= 19, `--new-codes avoids the ${publicCodes.size} public codes (sample + old hunt.js)`);
  expect(Object.keys(withCodes.stations[0])[0] === 'code', 'new codes go first in each station');
  expect(!codes.some(c => (r.stdout + r.stderr).includes(c)), 'seal does not print any code');
  expect(!/WARNING: --new-codes/.test(r.stderr), 'no new-codes warning when there was no sealed hunt before');
  const sealedText1 = await readFile(sPath, 'utf8');
  const res1 = await checkSealed('CLI seal with new codes', sealedText1, STRONG, withCodes);
  section('command line: unseal');

  r = runTool(['unseal', '--in', sPath, '--out', backPath], P);
  expect(r.status === 0 && (await readFile(backPath, 'utf8')) === (await readFile(hPath, 'utf8')), 'unseal recreates the private file byte for byte');
  r = runTool(['unseal', '--in', sPath, '--out', backPath], P);
  expect(r.status === 0 && /already matches/.test(r.stderr), 'unseal onto an identical file is a no-op');
  await writeFile(backPath, '{"edited": true}\n');
  r = runTool(['unseal', '--in', sPath, '--out', backPath], P);
  expect(r.status === 1 && /--force/.test(r.stderr), 'unseal will not overwrite a different file without --force');
  r = runTool(['unseal', '--in', sPath, '--out', backPath, '--force'], P);
  expect(r.status === 0 && isDeepStrictEqual(await readJson(backPath), withCodes), 'unseal --force overwrites it');
  r = runTool(['unseal', '--in', sPath, '--out', '-'], P);
  expect(r.status === 0 && isDeepStrictEqual(JSON.parse(r.stdout), withCodes), 'unseal --out - prints the hunt');
  r = runTool(['unseal', '--in', sPath, '--out', '-'], { STAR_HUNT_PASSPHRASE: 'not-the-passphrase' });
  expect(r.status === 1 && !r.stdout, 'unseal with the wrong passphrase fails and prints nothing');

  r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp'], P);
  const res2 = await checkSealed('CLI reseal', await readFile(sPath, 'utf8'), STRONG, withCodes);
  section('command line: reseal');
  expect(r.status === 0 && /kept/.test(r.stderr) && /--new-start-key/.test(r.stderr) && res1 && res2 && res1.startKey === res2.startKey,
    'resealing keeps the start key (a running game keeps working) and says to use --new-start-key after a rehearsal');
  expect(res1 && res2 && res1.sealed.card.salt !== res2.sealed.card.salt, 'resealing uses a fresh card salt');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp', '--new-start-key'], P);
  const res3 = await checkSealed('CLI reseal with a new start key', await readFile(sPath, 'utf8'), STRONG, withCodes);
  section('command line: start key, shuffling');
  expect(r.status === 0 && res3 && res3.startKey !== res2.startKey, '--new-start-key makes a new start key');
  const perms = [res1, res2, res3, freshResult, committed].filter(Boolean).map(x => x.positions.join());
  expect(new Set(perms).size > 1, `entry order differs between seals (${perms.join(' / ')})`);

  section('command line: refusals that protect a sealed hunt');
  const before = await readFile(sPath, 'utf8');
  const OTHER = 'otter-lantern-pocket-summit-violet';
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp', '--new-codes'], { STAR_HUNT_PASSPHRASE: OTHER });
  expect(r.status === 1 && /different passphrase; add --force/.test(r.stderr) && (await readFile(sPath, 'utf8')) === before && isDeepStrictEqual(await readJson(hPath), withCodes),
    'seal will not replace a hunt sealed with a different passphrase (and writes no new codes)');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp', '--new-codes'], P);
  const withCodes2 = await readJson(hPath);
  expect(r.status === 0 && /WARNING: --new-codes/.test(r.stderr) && /Print the cards again/.test(r.stderr) && withCodes2.stations[0].code !== withCodes.stations[0].code,
    '--new-codes over a sealed hunt that opens prints a loud warning about printed cards and progress');
  r = runTool(['seal', '--in', hPath, '--out', sPath, '--no-stamp', '--force'], { STAR_HUNT_PASSPHRASE: OTHER });
  expect(r.status === 0 && (await T.openMC(T.parseSealedJs(await readFile(sPath, 'utf8')), OTHER)) !== null, '--force replaces it');
  const samplePath = join(tmp, 'site.sealed.js');
  await writeFile(samplePath, committedText);
  r = runTool(['seal', '--in', hPath, '--out', samplePath, '--no-stamp'], P);
  const overSample = await T.openMC(T.parseSealedJs(await readFile(samplePath, 'utf8')), STRONG);
  expect(r.status === 0 && /held the sample hunt/.test(r.stderr) && overSample && committed && overSample.startKey !== committed.startKey,
    'a sealed sample hunt may be replaced without --force (with a new start key)');
  const junkPath = join(tmp, 'junk.js');
  await writeFile(junkPath, 'window.SOMETHING = 1;\n');
  r = runTool(['seal', '--in', hPath, '--out', junkPath, '--no-stamp'], P);
  expect(r.status === 1 && /not a sealed hunt file/.test(r.stderr) && (await readFile(junkPath, 'utf8')) === 'window.SOMETHING = 1;\n', 'seal will not replace a file that is not a sealed hunt');
  const copyPath = join(tmp, 'copy-of-sample.json');
  await writeFile(copyPath, JSON.stringify(fixture, null, 2) + '\n');
  r = runTool(['seal', '--in', copyPath, '--out', join(tmp, 'copy.sealed.js'), '--no-stamp'], P);
  expect(r.status === 1 && /is public/.test(r.stderr) && /station 1/.test(r.stderr), 'seal refuses a real hunt that reuses the sample\'s public codes');
  const oldCodes = structuredClone(withCodes2); oldCodes.decoys[0].code = T.OLD_PUBLIC_CODES[0];
  await writeFile(copyPath, JSON.stringify(oldCodes, null, 2) + '\n');
  r = runTool(['seal', '--in', copyPath, '--out', join(tmp, 'copy.sealed.js'), '--no-stamp'], P);
  expect(r.status === 1 && /decoy 1/.test(r.stderr) && /is public/.test(r.stderr), 'seal refuses a code from the old public hunt.js');
  r = runTool(['seal', '--in', copyPath, '--out', join(tmp, 'copy.sealed.js'), '--no-stamp', '--allow-weak'], { STAR_HUNT_PASSPHRASE: 'short pass' });
  expect(r.status === 1 && /is public/.test(r.stderr), '--allow-weak does not allow public codes');
  const noDecoys = structuredClone(withCodes2); delete noDecoys.decoys;
  expect(T.validateHunt(noDecoys).warnings.some(w => /no Herod cards/.test(w)), 'validation warns when the hunt has no decoys');

  // version.js: the stamp and the loader.
  section('command line: version.js');
  const vText = await readFile(vPath, 'utf8');
  const written = [];
  const ctx = { window: {}, document: { write: s => written.push(s) }, encodeURIComponent };
  vm.runInNewContext(vText, ctx);
  const stamp = ctx.window.STAR_HUNT_BUILD;
  expect(/^\d{8}T\d{6}Z$/.test(stamp), `version.js sets STAR_HUNT_BUILD (${stamp})`);
  expect(ctx.window.StarHuntAsset('art/a.jpg') === `art/a.jpg?v=${stamp}` && ctx.window.StarHuntAsset('x.js?a=1') === `x.js?a=1&v=${stamp}`, 'StarHuntAsset appends ?v=<build>');
  ctx.window.StarHuntLoad(['css/base.css', 'config.js']);
  expect(written[0] === `<link rel="stylesheet" href="css/base.css?v=${stamp}">` && written[1] === `<script src="config.js?v=${stamp}"></script>`, 'StarHuntLoad writes the link and script tags in order');
  r = runTool(['stamp', '--stamp', vPath]);
  expect(r.status === 0 && /window\.STAR_HUNT_BUILD = '\d{8}T\d{6}Z'/.test(await readFile(vPath, 'utf8')), 'the stamp command rewrites version.js');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

// 4. The site's sealed hunt.
section('star-hunt/hunt.sealed.js');
if (existsSync(SITE_SEALED)) {
  const v = await readFile(join(ROOT, 'star-hunt/version.js'), 'utf8').catch(() => '');
  expect(/window\.STAR_HUNT_BUILD = '\d{8}T\d{6}Z'/.test(v), 'star-hunt/version.js has a build stamp');
  const siteText = await readFile(SITE_SEALED, 'utf8');
  const site = T.parseSealedJs(siteText);
  const envPass = process.env.STAR_HUNT_PASSPHRASE;
  const privatePath = join(ROOT, 'hunt-private/hunt.json');
  const isSample = !!(await T.openMC(site, TEST_PASS));
  if (envPass) {
    const opened = await T.openMC(site, envPass);
    if (expect(opened, 'STAR_HUNT_PASSPHRASE opens star-hunt/hunt.sealed.js')) {
      const priv = existsSync(privatePath) ? await readJson(privatePath) : null;
      if (!priv) console.log('   note: hunt-private/hunt.json is not here, so the sealed hunt is checked on its own');
      await checkSealed('star-hunt/hunt.sealed.js', siteText, envPass, priv);
    }
  } else if (isSample) {
    console.log('   note: star-hunt/hunt.sealed.js is still the sample hunt (sealed with the test passphrase)');
    await checkSealed('star-hunt/hunt.sealed.js (sample)', siteText, TEST_PASS, fixture);
  } else {
    console.log('   skip: set STAR_HUNT_PASSPHRASE to check star-hunt/hunt.sealed.js');
  }
  if (releaseCheck) {
    section('release: star-hunt/hunt.sealed.js is the real hunt');
    expect(!isSample, 'star-hunt/hunt.sealed.js is not the sample hunt (it does not open with the test passphrase)');
    const pub = [...(await T.publicCodes())];
    const openers = [];
    for (const c of pub) if (await T.openCard(site, c)) openers.push(c);
    expect(!openers.length, `none of the ${pub.length} public card codes (sample, old hunt.js) opens a card${openers.length ? ': ' + openers.length + ' do' : ''}`);
    expect(!!envPass, 'STAR_HUNT_PASSPHRASE is set, so the real hunt was checked above');
  }
} else {
  console.log('skip: star-hunt/hunt.sealed.js does not exist yet');
  if (releaseCheck) expect(false, 'release: star-hunt/hunt.sealed.js exists');
}

// 5. The browser: star-hunt/seal.js in Chromium against the committed sample.
if (skipBrowser) { section(''); console.log('skip: browser interop (--skip-browser)'); }
else await browserInterop();

async function browserInterop() {
  section('browser interop: star-hunt/seal.js in Chromium');
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { expect(false, 'playwright is importable (symlink node_modules into the repo root, or pass --skip-browser)'); return; }
  let executablePath = process.env.CHROMIUM;
  if (!executablePath) {
    const base = '/opt/pw-browsers';
    for (const d of (existsSync(base) ? await readdir(base) : []).filter(d => d.startsWith('chromium-')).sort()) {
      for (const sub of ['chrome-linux', 'chrome-linux64']) if (!executablePath && existsSync(join(base, d, sub, 'chrome'))) executablePath = join(base, d, sub, 'chrome');
    }
  }
  const sealed = T.parseSealedJs(committedText);
  const mc = await T.openMC(sealed, TEST_PASS);
  const stamp = '20261222T180000Z';
  const files = {
    '/': `<!doctype html><meta charset="utf-8"><title>seal test</title>
<script>document.write('<script src="version.js?t=' + Date.now() + '"><\\/script>');</script>
<script>StarHuntLoad(['hunt.sealed.js', 'seal.js']);</script>`,
    '/version.js': T.versionJs(stamp),
    '/hunt.sealed.js': committedText,
    '/seal.js': await readFile(join(ROOT, 'star-hunt/seal.js'), 'utf8'),
  };
  const requested = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    const body = files[new URL(req.url, 'http://x').pathname];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'text/javascript' });
    res.end(body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.HuntSeal);
    expect(requested.some(u => u === `/hunt.sealed.js?v=${stamp}`) && requested.some(u => u === `/seal.js?v=${stamp}`) && requested.some(u => /^\/version\.js\?t=\d+$/.test(u)),
      'the page head loads version.js fresh and the other files with ?v=<build>');
    expect(await page.evaluate(() => window.isSecureContext && HuntSeal.supported), 'a page on 127.0.0.1 is a secure context and HuntSeal.supported is true');
    const pubFields = {
      title: sealed.title, subtitle: sealed.subtitle, intro: sealed.intro, verse: sealed.verse, phrases: sealed.verse.phrases,
      stationCount: sealed.stationCount, decoyMessage: sealed.decoyMessage, notYet: sealed.notYet, cover: sealed.cover,
    };
    expect(isDeepStrictEqual(await page.evaluate(() => JSON.parse(JSON.stringify(HuntSeal.hunt))), pubFields), 'HuntSeal.hunt has the public fields, and no finale before the last card is opened');

    const real = [...fixture.stations, ...fixture.decoys].map(s => s.code);
    const peekBefore = await page.evaluate(c => HuntSeal.peekCard(c), real[1]);
    expect(peekBefore === null, 'peekCard is null for a code this page has not opened');
    const tries = [...real, real[0].toLowerCase(), ` ${real[1].slice(0, 3)}-${real[1].slice(3)} `, 'ZZZZZZ', randomCode(new Set(real)), real[2].slice(0, 5) + (real[2][5] === 'A' ? 'B' : 'A'), ''];
    const browserResults = await page.evaluate(async list => {
      const out = [];
      for (const c of list) {
        const t0 = performance.now();
        const data = await HuntSeal.openCard(c);
        const ms = performance.now() - t0;
        out.push({ c, data, ms, id: HuntSeal.normCode(c) ? await HuntSeal.cardId(c) : null });
      }
      return out;
    }, tries);
    let same = 0, idsSame = 0;
    for (const b of browserResults) {
      const n = await T.openCard(sealed, b.c);
      const want = n ? { code: T.normCode(b.c), ...n } : null;
      if (isDeepStrictEqual(b.data, want)) same++; else console.log('  differs for', JSON.stringify(b.c), JSON.stringify(b.data), JSON.stringify(want));
      if (b.id === null || b.id === (await T.deriveCard(b.c, sealed.card.salt, sealed.card.iterations)).id) idsSame++;
    }
    expect(idsSame === tries.length, `Chromium derives the same entry ids as Node for ${tries.length} codes`);
    expect(same === tries.length, `Chromium opens exactly what Node opens for ${tries.length} codes (stations, decoys, typed variants, wrong codes)`);
    const ms = browserResults.filter(b => b.data && b.ms > 1).map(b => Math.round(b.ms));
    console.log(`  openCard in Chromium: ${ms.join(', ')} ms per new code`);
    const again = await page.evaluate(async c => { const t0 = performance.now(); await HuntSeal.openCard(c); return performance.now() - t0; }, real[0]);
    expect(again < 20, `opening the same code again is cached (${again.toFixed(1)} ms)`);
    const peek = await page.evaluate(([a, b]) => [HuntSeal.peekCard(a), HuntSeal.peekCard(b.toLowerCase()), HuntSeal.peekCard('ZZZZZZ')], [real[1], real[4]]);
    expect(isDeepStrictEqual(peek[0], { code: real[1], ...(await T.openCard(sealed, real[1])) }) && isDeepStrictEqual(peek[1], { code: real[4], kind: 'decoy' }) && peek[2] === null,
      'peekCard returns an opened entry at once (any case), null for a wrong code');
    const last = fixture.stations.length - 1;
    const fin = await page.evaluate(() => { const h = HuntSeal.hunt; return { now: h.finale, keys: Object.keys(h) }; });
    expect(isDeepStrictEqual(fin.now, fixture.finale) && fin.keys.includes('finale'), `after the last card (station ${last + 1}) is opened, HuntSeal.hunt.finale is the finale`);

    const startRes = await page.evaluate(async ([k, bad]) => [await HuntSeal.openStart(k), await HuntSeal.openStart(bad), await HuntSeal.openStart('!!'), await HuntSeal.openStart(null)], [mc.startKey, randomB64(32)]);
    expect(isDeepStrictEqual(startRes[0], { clue: fixture.stations[0].clue }), 'Chromium opens clue 1 with the start key');
    expect(startRes[1] === null && startRes[2] === null && startRes[3] === null, 'Chromium: a wrong, malformed or missing start key opens nothing');

    const mcRes = await page.evaluate(async () => {
      const t0 = performance.now();
      const good = await HuntSeal.openMC('test-passphrase');
      const ms = performance.now() - t0;
      return { good, ms, variant: !!(await HuntSeal.openMC('Test Passphrase')), wrong: await HuntSeal.openMC('test-passphrase-x'), empty: await HuntSeal.openMC('') };
    });
    const wantMC = { ...fixture, startKey: mc.startKey };
    expect(isDeepStrictEqual(mcRes.good, wantMC), `Chromium opens the MC copy with the passphrase: the whole hunt plus startKey (${Math.round(mcRes.ms)} ms)`);
    expect(mcRes.variant && mcRes.wrong === null && mcRes.empty === null, 'Chromium: "Test Passphrase" opens it too; a wrong or empty passphrase opens nothing');

    const remembered = await page.evaluate(async () => {
      HuntSeal.rememberPassphrase('wrong-one');
      const a = await HuntSeal.openMCRemembered();
      const afterWrong = HuntSeal.recallPassphrase();
      HuntSeal.rememberPassphrase('test-passphrase');
      const b = await HuntSeal.openMCRemembered();
      HuntSeal.forgetPassphrase();
      return { a, afterWrong, b: !!b, gone: HuntSeal.recallPassphrase() };
    });
    expect(remembered.a === null && remembered.afterWrong === '' && remembered.b && remembered.gone === '', 'remembered passphrase: a wrong one is forgotten, the right one opens, forget clears it');
    expect(!errors.length, `no page errors${errors.length ? ': ' + errors.join('; ') : ''}`);
  } finally {
    await browser.close();
    server.close();
  }
}

section('');
console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${passes} checks passed, ${failures} failed.`);
process.exitCode = failures ? 1 : 0;
