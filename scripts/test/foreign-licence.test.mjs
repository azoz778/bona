// Advertising basis per listing: a Saudi property needs a REGA per-ad licence number (placeholder +
// blocked until the owner records one); a property outside the Kingdom is marketed under the
// developer's authorisation (owner decision 2026-09-09) and must never carry the REGA placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AD_LICENCE_TOKEN, adLicence, adLicenceLine, adLicenceRequired, captionFor, isForeign,
} from '../social/lib/listing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const listings = JSON.parse(fs.readFileSync(path.join(root, 'src/data/listings.json'), 'utf8'));
const byId = (id) => listings.find((l) => l.id === id);
const clone = (l) => JSON.parse(JSON.stringify(l));

const oman = byId('BONA-045');                       // Muscat — a real foreign listing
const saudi = listings.find((l) => !isForeign(l));  // any Jeddah listing
assert.ok(oman && saudi, 'fixtures exist in listings.json');

test('isForeign: only a non-Saudi country counts; missing data is Saudi by default', () => {
  const at = (en, ar = '') => ({ location: { country: { en, ar } } });
  assert.equal(isForeign(at('Oman', 'سلطنة عُمان')), true);
  assert.equal(isForeign(at('Spain')), true);
  assert.equal(isForeign(at('United Arab Emirates')), true);
  assert.equal(isForeign(at('Saudi Arabia', 'المملكة العربية السعودية')), false);
  assert.equal(isForeign(at('Saudi Arabia', 'السعودية')), false);
  assert.equal(isForeign({ location: {} }), false);
  assert.equal(isForeign({}), false);
  assert.equal(isForeign(null), false);
});

test('adLicence: foreign → developer authorisation, never blocked', () => {
  const a = adLicence(oman);
  assert.equal(a.basis, 'developer-authorisation');
  assert.equal(a.blocked, false);
  assert.equal(a.number, null);
});

test('adLicence: Saudi without a recorded number → REGA pending, blocked', () => {
  const l = clone(saudi); l.licence = null;
  assert.deepEqual(adLicence(l), { basis: 'rega-pending', number: null, blocked: true });
});

test('adLicence: Saudi with a recorded, unexpired number → REGA licence, publishable', () => {
  const l = clone(saudi); l.licence = { adNumber: '7200012345', adExpiry: '2099-01-01' };
  assert.deepEqual(adLicence(l), { basis: 'rega-ad-licence', number: '7200012345', blocked: false });
});

test('adLicence: an expired REGA number is treated as missing', () => {
  const l = clone(saudi); l.licence = { adNumber: '7200012345', adExpiry: '2020-01-01' };
  assert.equal(adLicence(l).basis, 'rega-pending');
  assert.equal(adLicence(l).blocked, true);
});

test('adLicenceLine: foreign carries the developer line, no placeholder, in both languages', () => {
  for (const lang of ['ar', 'en']) {
    const line = adLicenceLine(lang, oman);
    assert.ok(!line.includes(AD_LICENCE_TOKEN), `${lang}: no placeholder`);
    assert.ok(/المطوّر|developer authorisation/.test(line), `${lang}: names the developer authorisation`);
  }
});

test('adLicenceLine: Saudi pending keeps the placeholder; a recorded number replaces it', () => {
  const pending = clone(saudi); pending.licence = null;
  assert.ok(adLicenceLine('ar', pending).includes(AD_LICENCE_TOKEN));
  assert.ok(adLicenceLine('en', pending).includes(AD_LICENCE_TOKEN));
  assert.ok(adLicenceLine('en').includes(AD_LICENCE_TOKEN), 'no listing given → placeholder (old call sites)');
  const licensed = clone(saudi); licensed.licence = { adNumber: '7200012345', adExpiry: '2099-01-01' };
  assert.ok(adLicenceLine('ar', licensed).includes('7200012345'));
  assert.ok(!adLicenceLine('en', licensed).includes(AD_LICENCE_TOKEN));
});

test('captionFor: a foreign listing caption never carries the REGA placeholder', () => {
  for (const lang of ['ar', 'en']) {
    const c = captionFor(oman, lang);
    assert.ok(!c.includes(AD_LICENCE_TOKEN), `${lang}`);
    assert.ok(/المطوّر|developer authorisation/.test(c), `${lang}: developer line present`);
  }
  assert.ok(captionFor(saudi, 'en').includes(AD_LICENCE_TOKEN), 'Saudi pending still carries it');
});

test('adLicenceRequired: only Saudi property posts need a REGA per-ad licence', () => {
  assert.equal(adLicenceRequired({ pillar: 'listings', listing: saudi }), true);
  assert.equal(adLicenceRequired({ pillar: 'listings', listing: oman }), false);
  assert.equal(adLicenceRequired({ pillar: 'education', listing: null }), false);
});

test('queue.json: every entry states its licence basis and is blocked only when REGA is pending', () => {
  const q = JSON.parse(fs.readFileSync(path.join(root, 'marketing/queue/queue.json'), 'utf8'));
  assert.ok(q.entries.length > 100, 'queue is populated');
  let foreign = 0;
  for (const e of q.entries) {
    const both = `${e.caption.ar}\n${e.caption.en}`;
    if (!e.listingRef) {
      assert.equal(e.blocked, false, `${e.id}: editorial entry is never blocked`);
      assert.equal(e.licenceBasis, null, `${e.id}: editorial has no licence basis`);
      continue;
    }
    const l = byId(e.listingRef);
    assert.ok(l, `${e.id}: ${e.listingRef} exists`);
    const a = adLicence(l);
    assert.equal(e.licenceBasis, a.basis, `${e.id}: basis recorded`);
    assert.equal(e.blocked, a.blocked, `${e.id}: blocked follows the basis`);
    assert.equal(e.adLicenceRequired, a.basis !== 'developer-authorisation', `${e.id}: adLicenceRequired`);
    if (a.basis === 'developer-authorisation') {
      foreign += 1;
      assert.ok(!both.includes(AD_LICENCE_TOKEN), `${e.id}: foreign caption has no placeholder`);
      assert.equal(e.blockedReason, null, `${e.id}: no blocked reason`);
    } else if (a.basis === 'rega-pending') {
      assert.ok(e.caption.ar.includes(AD_LICENCE_TOKEN) && e.caption.en.includes(AD_LICENCE_TOKEN), `${e.id}: placeholder in both captions`);
    } else {
      assert.ok(both.includes(a.number), `${e.id}: real licence number in caption`);
    }
  }
  assert.ok(foreign >= 11, `foreign entries are in the queue and unblocked (${foreign})`);
});

// ---- fail-closed cases raised in the Codex review (2026-09-09) ----
test('isForeign fails closed: Saudi aliases and garbage country strings are never foreign', () => {
  const at = (en) => ({ location: { country: { en } } });
  for (const v of ['KSA', 'ksa', 'SA', 'Kingdom of Saudi Arabia', 'السعودية', 'المملكة العربية السعودية', '  saudi arabia  ']) {
    assert.equal(isForeign(at(v)), false, v);
    assert.equal(adLicence(at(v)).basis, 'rega-pending', v);
  }
  for (const v of ['Jeddah', 'Atlantis', 'Oman?', '123']) {
    assert.equal(isForeign(at(v)), false, v);
    const a = adLicence(at(v));
    assert.equal(a.basis, 'unknown-country', v);
    assert.equal(a.blocked, true, v);
    assert.ok(adLicenceLine('en', at(v)).includes(AD_LICENCE_TOKEN), `${v}: placeholder line`);
  }
  assert.equal(isForeign(at('OMAN')), true, 'case-insensitive');
});

test('adLicence fails closed on junk numbers and malformed or impossible expiry dates', () => {
  const withLic = (adNumber, adExpiry) => { const l = clone(saudi); l.licence = { adNumber, adExpiry }; return adLicence(l); };
  for (const bad of ['TBD', 'pending', 'none', 'N/A', 'xxx', '000', AD_LICENCE_TOKEN, '', '   ', 'a b c']) {
    assert.equal(withLic(bad, '2099-01-01').basis, 'rega-pending', `number ${JSON.stringify(bad)}`);
  }
  for (const bad of ['2026/01/01', '01-01-2099', '2099-02-30', '2099-13-01', 'tomorrow', '2099-1-1']) {
    assert.equal(withLic('7200012345', bad).basis, 'rega-pending', `expiry ${bad}`);
  }
  assert.equal(withLic('7200012345', '').basis, 'rega-ad-licence', 'missing expiry does not invalidate a recorded number');
  assert.equal(withLic('7200012345', null).basis, 'rega-ad-licence');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
  assert.equal(withLic('7200012345', today).basis, 'rega-ad-licence', 'valid through the expiry day itself');
  assert.equal(withLic('REGA/2026-000123', '2099-01-01').basis, 'rega-ad-licence', 'the intake\'s number shape (letters, / and -) is accepted');
});
