// Opens the sealed hunt (hunt.sealed.js, window.HUNT_SEALED) in the browser.
//
// This is the browser twin of tools/seal-hunt.mjs and must stay byte-compatible with it:
//   card code C (upper case, letters and digits only) -> PBKDF2-HMAC-SHA256(C, card.salt, card.iterations)
//   -> 64 bytes: bytes 0-31 as hex = entry id, bytes 32-63 = AES-256-GCM key for that entry.
//   start key (base64, 32 bytes, published at meta/startKey when the MC starts) -> AES-256-GCM key for clue 1.
//   MC passphrase (lower case, words joined by "-") -> PBKDF2-HMAC-SHA256(.., mc.salt, mc.iterations) -> AES key.
// iv, ct and salts are base64; ct carries the 16-byte GCM tag at its end; plaintexts are UTF-8 JSON.
//
// Everything here uses crypto.subtle, which browsers only provide on https:// pages and on localhost.
//
//   HuntSeal.hunt                  public fields (title, subtitle, intro, verse, stationCount, ...)
//   HuntSeal.openCard(code)        -> Promise<{ code, kind: 'station', n, title, ... } | { code, kind: 'decoy' } | null>
//   HuntSeal.openStart(startKey)   -> Promise<{ clue } | null>
//   HuntSeal.openMC(passphrase)    -> Promise<hunt (the whole private JSON, plus .startKey) | null>
(function () {
  'use strict';
  var enc = new TextEncoder(), dec = new TextDecoder();
  var PASS_KEY = 'star-hunt:mc-passphrase';

  function sealed() {
    var h = window.HUNT_SEALED;
    if (!h || h.format !== 1) throw fail('no-hunt', 'The hunt file (hunt.sealed.js) did not load.');
    return h;
  }
  function subtle() {
    var s = window.crypto && window.crypto.subtle;
    if (!s) throw fail('insecure-context', 'This page needs https:// (or localhost) to open the hunt.');
    return s;
  }
  function fail(code, message) { var e = new Error(message); e.code = code; e.huntSeal = true; return e; }
  function ours(e) { return !!(e && e.huntSeal); }

  // ---------- encodings (must match tools/seal-hunt.mjs) ----------
  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  // Card codes: case, spaces and dashes don't matter.
  function normCode(raw) {
    return String(raw == null ? '' : raw).normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  // Passphrases: case, surrounding space and the separators between words don't matter.
  function normPassphrase(raw) {
    return String(raw == null ? '' : raw).normalize('NFKC').trim().toLowerCase()
      .replace(/[\s_.\-‐-―]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // ---------- crypto ----------
  function pbkdf2(password, saltB64, iterations, bits) {
    var s = subtle();
    return s.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (base) {
        return s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: iterations }, base, bits);
      })
      .then(function (buf) { return new Uint8Array(buf); });
  }
  function aesKey(raw) { return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']); }
  // Resolves to the parsed plaintext, or null if the key is wrong or the data was changed.
  function unseal(key, box) {
    return subtle().decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct))
      .then(function (pt) { return JSON.parse(dec.decode(pt)); }, function () { return null; });
  }
  function deriveCard(code) {
    var h = sealed();
    return pbkdf2(code, h.card.salt, h.card.iterations, 512).then(function (bits) {
      return aesKey(bits.slice(32)).then(function (key) { return { id: hex(bits.subarray(0, 32)), key: key }; });
    });
  }

  // ---------- cards ----------
  // One PBKDF2 run per code (about 100-300 ms on a phone), so results are kept for the life of the page.
  var cards = {};
  function openCard(raw) {
    var code = normCode(raw);
    if (!code) return Promise.resolve(null);
    if (!cards[code]) {
      cards[code] = Promise.resolve().then(function () {
        var h = sealed();
        return deriveCard(code).then(function (d) {
          var entry = null;
          for (var i = 0; i < h.entries.length; i++) if (h.entries[i].id === d.id) { entry = h.entries[i]; break; }
          if (!entry) return null;
          return unseal(d.key, entry).then(function (data) {
            if (!data) return null;
            var out = { code: code };
            for (var k in data) out[k] = data[k];
            return out;
          });
        });
      });
      cards[code].catch(function () { delete cards[code]; }); // let a failed attempt (no crypto, no file) be retried
    }
    return cards[code];
  }
  // Several codes at once, in the same order (null for any that don't open).
  function openCards(codes) { return Promise.all((codes || []).map(openCard)); }
  // The entry id for a code (lower-case hex). For tests and debugging.
  function cardId(raw) { return deriveCard(normCode(raw)).then(function (d) { return d.id; }); }

  // ---------- clue 1 ----------
  function openStart(startKeyB64) {
    if (!startKeyB64) return Promise.resolve(null);
    return Promise.resolve().then(function () {
      var h = sealed(), raw = unb64(startKeyB64);
      if (raw.length !== 32) return null;
      return aesKey(raw).then(function (key) { return unseal(key, h.start); });
    }).catch(function (e) { if (ours(e)) throw e; return null; }); // a malformed key opens nothing
  }

  // ---------- MC ----------
  var mcCache = {};
  function openMC(passphrase) {
    var p = normPassphrase(passphrase);
    if (!p) return Promise.resolve(null);
    if (!mcCache[p]) {
      mcCache[p] = Promise.resolve().then(function () {
        var h = sealed();
        return pbkdf2(p, h.mc.salt, h.mc.iterations, 256)
          .then(aesKey)
          .then(function (key) { return unseal(key, h.mc); })
          .then(function (data) {
            if (!data || !data.hunt) return null;
            data.hunt.startKey = data.startKey;
            return data.hunt;
          });
      });
      mcCache[p].then(function (r) { if (!r) delete mcCache[p]; }, function () { delete mcCache[p]; });
    }
    return mcCache[p];
  }
  // The MC passphrase is remembered for this tab only (sessionStorage), never in localStorage.
  function rememberPassphrase(p) { try { sessionStorage.setItem(PASS_KEY, p); } catch (e) {} }
  function recallPassphrase() { try { return sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; } }
  function forgetPassphrase() { try { sessionStorage.removeItem(PASS_KEY); } catch (e) {} }
  // Opens the MC copy with the remembered passphrase, if there is one that still works.
  function openMCRemembered() {
    var p = recallPassphrase();
    if (!p) return Promise.resolve(null);
    return openMC(p).then(function (hunt) { if (!hunt) forgetPassphrase(); return hunt; });
  }

  // ---------- public fields ----------
  function publicHunt() {
    var h = window.HUNT_SEALED;
    if (!h) return null;
    return {
      title: h.title, subtitle: h.subtitle, intro: h.intro,
      verse: h.verse, phrases: (h.verse && h.verse.phrases) || [], stationCount: h.stationCount,
      decoyMessage: h.decoyMessage, notYet: h.notYet || [], finale: h.finale, cover: h.cover,
    };
  }

  window.HuntSeal = {
    get hunt() { return publicHunt(); },
    get supported() { return !!(window.crypto && window.crypto.subtle && window.HUNT_SEALED); },
    normCode: normCode,
    normPassphrase: normPassphrase,
    openCard: openCard,
    openCards: openCards,
    cardId: cardId,
    openStart: openStart,
    openMC: openMC,
    openMCRemembered: openMCRemembered,
    rememberPassphrase: rememberPassphrase,
    recallPassphrase: recallPassphrase,
    forgetPassphrase: forgetPassphrase,
  };
})();
