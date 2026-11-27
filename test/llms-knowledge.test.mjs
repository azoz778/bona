/**
 * The knowledge file answer engines read (and, until D3, the website concierge's knowledge base), checked over
 * the BUILT site: dist/llms-full.txt and dist/llms.txt, which scripts/og/gen-llms.mjs writes into public/ before
 * the build. A listing's coordinates say whether they are its own pin or a district centre, the privacy summary
 * agrees with the policy (src/data/privacy.json), the enquiry and contact lines say who answers on WhatsApp and
 * when, as the FAQ does, and neither file gives the assistant a personal name or names an AI vendor that gets no
 * Bona chat (the privacy page's own rules, scripts/test/privacy-policy.test.mjs).
 *
 *   node scripts/og/gen-llms.mjs && npm run build && node --test test/llms-knowledge.test.mjs   (or: npm run test:dist)
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const file = path.join(dist, 'llms-full.txt');
assert.ok(existsSync(file), `dist/llms-full.txt is missing — run gen-llms and \`npm run build\` first (looked in ${dist})`);
const full = readFileSync(file, 'utf8');
const shortFile = path.join(dist, 'llms.txt');
assert.ok(existsSync(shortFile), `dist/llms.txt is missing — run gen-llms and \`npm run build\` first (looked in ${dist})`);
const short = readFileSync(shortFile, 'utf8');
const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
const listings = read('src/data/listings.json');
const site = read('src/data/site.json');
const faq = read('src/data/faq.json');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A listing's block, from its ID line to the next heading; null when the file leaves the listing out. */
function blockOf(l) {
  const m = new RegExp(`\\n- ID: ${escape(l.id)}(?: \\(|\\n)`).exec(full);
  if (!m) return null;
  const end = full.indexOf('\n### ', m.index + 1);
  return full.slice(m.index, end < 0 ? undefined : end);
}
/** One `## ` section of the file, heading included. */
function sectionOf(heading) {
  const at = full.indexOf(`\n## ${heading}`);
  assert.ok(at >= 0, `llms-full.txt has no “## ${heading}” section`);
  const end = full.indexOf('\n## ', at + 1);
  return full.slice(at + 1, end < 0 ? undefined : end);
}

test('a listing’s coordinates say whether they are its own pin or a district centre (mapPrecision)', () => {
  // mapPrecision 'exact' is the developer's or the register's own pin; anything else is a district centroid
  // the build filled in, and a knowledge file must not hand that out as the home's location.
  for (const l of listings) {
    const block = blockOf(l);
    if (!block) { assert.equal(l.status, 'sold', `${l.id} is missing from llms-full.txt`); continue; }
    const lines = block.split('\n').filter((x) => x.startsWith('- Coordinates'));
    if (!(l.map && typeof l.map.lat === 'number' && typeof l.map.lng === 'number')) {
      assert.deepEqual(lines, [], `${l.id}: no map, so no coordinates`);
      continue;
    }
    const kind = l.mapPrecision === 'exact' ? 'exact pin' : 'approximate, district centre';
    assert.deepEqual(lines, [`- Coordinates (${kind}): ${l.map.lat}, ${l.map.lng}`], `${l.id} (mapPrecision ${l.mapPrecision ?? 'unset'})`);
  }
  assert.doesNotMatch(full, /^- Coordinates: /m, 'every coordinates line says which kind it is');
});

test('the privacy summary agrees with the policy: first-party records of visits and enquiries, and the optional tags and cookie only with consent', () => {
  const summary = sectionOf('Privacy (summary)');
  // What the summary said before D1, and the policy does not (privacy.json what-this-site-collects).
  for (const gone of [/sets no cookies/, /nothing is stored by the site/, /currently disabled/]) assert.doesNotMatch(summary, gone);
  assert.match(summary, /Bona keeps first-party records of visits and enquiries made on the site/);
  assert.match(summary, /load only with consent, and so does a first-party bona_id cookie/);
  // The tags it names are the ones the site is configured with (site.json analytics), no more and no fewer.
  const TAGS = { ga4: 'Google Analytics 4', metaPixel: 'Meta Pixel', tiktokPixel: 'TikTok Pixel', snapPixel: 'Snap Pixel' };
  for (const [key, name] of Object.entries(TAGS)) {
    assert.equal(summary.includes(name), Boolean(site.analytics?.[key]), `${name}: site.json analytics.${key} is ${site.analytics?.[key] ? 'set' : 'not set'}`);
  }
  assert.ok(summary.includes(`via WhatsApp ${site.whatsapp.display}`), 'the rights are used on WhatsApp');
});

test('the enquiry line says who answers on WhatsApp and when, as the FAQ does (D1)', () => {
  const how = sectionOf('How to enquire');
  assert.doesNotMatch(how, /during office hours/, 'the AI assistant answers at any hour');
  assert.ok(how.includes(`Bona’s AI assistant answers on WhatsApp at any hour, in Arabic or English, and says that it is an AI; our team replies ${site.hours.en} (Saudi time).`), how);
  const contact = faq.items.find((x) => x.id === 'contact');
  assert.match(contact.a.en[0], /Bona’s AI assistant answers there at any hour, in Arabic or English, and says that it is an AI/, 'the FAQ says the same');
});

test('the Contact entry of both files says the AI assistant answers WhatsApp at any hour, not that WhatsApp keeps office hours (D1)', () => {
  for (const [name, text] of [['llms.txt', short], ['llms-full.txt', full]]) {
    const lines = text.split('\n').filter((x) => x.includes(`](${site.url.replace(/\/$/, '')}/contact/)`));
    assert.equal(lines.length, 1, `${name}: one Contact entry`);
    const [line] = lines;
    assert.doesNotMatch(line, /Reach Bona on WhatsApp or by phone, Sunday to Thursday/, `${name}: WhatsApp is answered at any hour now`);
    assert.ok(line.includes(`Bona’s AI assistant answers WhatsApp at any hour; our team replies ${site.hours.en}`), `${name}: ${line}`);
  }
});

// The privacy page's rules for the name and the vendors (privacy-policy.test.mjs NAME, EXCLUDED_VENDORS),
// applied to the two generated files: whole words only ("Sadana" is a listing), with the Arabic prefixes.
const NAME = {
  en: /\bDana\b/i,
  ar: /(?<![\p{L}\p{M}])(?:[وفبلك]?(?:ال)?)دان[ةا](?![\p{L}\p{M}])/u,
};
const EXCLUDED_VENDORS = [/deepseek/i, /\bxAI\b/i, /\bgrok\b/i, /\banthropic\b/i];

test('neither file gives the assistant a personal name or names an AI vendor that gets no Bona chat (D1)', () => {
  for (const [name, text] of [['llms.txt', short], ['llms-full.txt', full]]) {
    for (const [locale, re] of Object.entries(NAME)) {
      const hits = text.split('\n').filter((x) => re.test(x));
      assert.deepEqual(hits, [], `${name} names the assistant (${locale})`);
    }
    for (const re of EXCLUDED_VENDORS) assert.doesNotMatch(text, re, `${name} names an AI vendor that gets no Bona chat`);
  }
});
