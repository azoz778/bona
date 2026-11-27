/**
 * PR-BR (PLAN T25; brain/DESIGN-brain.md §6.3-6.4, DESIGN §4.1): the assistant has no name.
 * Clients see "Bona's AI assistant" / «مساعدة بونا الذكية»; the first-message disclosure says
 * «مساعدة بونا بالذكاء الاصطناعي» ("says AI explicitly, not just 'smart'"). "Keep Dana" is one
 * constant, which gives back today's dana-wa.mjs lines.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_NAME, LABEL, SHORT_LABEL, disclosure, DISCLOSURE, disclosureVariants, disclosureFor, HANDOVER, HANDOVER_VARIANTS, handoverFor,
  OUT_OF_HOURS, OUTAGE_OUT_OF_HOURS, inOfficeHours, handoverLine, outageLine, variantIndex, identity, EMAIL_FIRST_LINE, emailFirstLine,
  GREETING, greeting, CALENDAR_LINE, calendarLine,
} from '../lib/persona.mjs';
import { DISCLOSURE as TODAY_DISCLOSURE, HANDOVER as TODAY_HANDOVER } from '../lib/dana-wa.mjs';

const DANA = Object.freeze({ en: 'Dana', ar: 'دانة' });
const NAME_RE = /(?<![\p{L}])(?:dana|دانة)(?![\p{L}])/iu;
const at = (iso) => Date.parse(iso);

test('nameless by default: no name, the disclosure is the label, and the Arabic line says AI explicitly', () => {
  assert.equal(ASSISTANT_NAME, null);
  assert.deepEqual(LABEL, { en: "Bona's AI assistant", ar: 'مساعدة بونا بالذكاء الاصطناعي' });
  assert.deepEqual(SHORT_LABEL, { en: "Bona's AI assistant", ar: 'مساعدة بونا الذكية' });
  assert.equal(disclosure('en'), "Bona's AI assistant");
  assert.equal(disclosure('ar'), 'مساعدة بونا بالذكاء الاصطناعي');
  assert.deepEqual(DISCLOSURE, { en: "Bona's AI assistant", ar: 'مساعدة بونا بالذكاء الاصطناعي' });
  assert.ok(DISCLOSURE.ar.includes('بالذكاء الاصطناعي'), 'says AI explicitly, not just "smart"');
  assert.equal(disclosure('fr'), disclosure('ar'), 'an unknown language reads as Arabic, like dana-wa');
});

test('"keep Dana" is one constant: the named form gives back today\'s dana-wa.mjs disclosure, both languages', () => {
  assert.equal(disclosure('en', { name: DANA }), TODAY_DISCLOSURE.en);
  assert.equal(disclosure('ar', { name: DANA }), TODAY_DISCLOSURE.ar);
  assert.equal(disclosure('en', { name: DANA }), "Dana — Bona's AI assistant");
  assert.equal(disclosure('ar', { name: DANA }), 'دانة — مساعدة بونا بالذكاء الاصطناعي');
});

test('four nameless variants of the disclosure and of the hand-over line, picked by a hash of the lead id; variant 0 is the base', () => {
  for (const lang of ['en', 'ar']) {
    const d = disclosureVariants(lang);
    assert.equal(d.length, 4);
    assert.equal(d[0], DISCLOSURE[lang]);
    assert.equal(new Set(d).size, 4);
    assert.equal(HANDOVER_VARIANTS[lang].length, 4);
    assert.equal(HANDOVER_VARIANTS[lang][0], TODAY_HANDOVER[lang], 'HANDOVER variant 0 is today\'s constant');
    assert.equal(new Set(HANDOVER_VARIANTS[lang]).size, 4);
    for (const s of [...d, ...HANDOVER_VARIANTS[lang]]) assert.doesNotMatch(s, NAME_RE, s);
    if (lang === 'ar') for (const s of d) assert.ok(s.includes('بالذكاء الاصطناعي'), s);
    for (const s of disclosureVariants(lang, { name: DANA })) assert.ok(s.includes(DANA[lang]), s);
  }
  assert.deepEqual(HANDOVER, TODAY_HANDOVER);
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const id = `LEAD-20261127-${String(i).padStart(8, '0')}`;
    const k = variantIndex(id);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 4);
    assert.equal(variantIndex(id), k, 'stable per lead');
    assert.equal(disclosureFor(id, 'en'), disclosureVariants('en')[k]);
    assert.equal(handoverFor(id, 'ar'), HANDOVER_VARIANTS.ar[k]);
    seen.add(k);
  }
  assert.equal(seen.size, 4, 'every variant is used');
});

test('office hours are Sunday to Thursday, 10:00-19:00 Riyadh time', () => {
  assert.equal(inOfficeHours(at('2026-11-26T12:00:00+03:00')), true, 'Thursday noon');
  assert.equal(inOfficeHours(at('2026-11-29T10:00:00+03:00')), true, 'Sunday 10:00');
  assert.equal(inOfficeHours(at('2026-11-26T18:59:59+03:00')), true);
  assert.equal(inOfficeHours(at('2026-11-26T19:00:00+03:00')), false, '19:00 is closed');
  assert.equal(inOfficeHours(at('2026-11-29T09:59:59+03:00')), false);
  assert.equal(inOfficeHours(at('2026-11-27T12:00:00+03:00')), false, 'Friday');
  assert.equal(inOfficeHours(at('2026-11-28T12:00:00+03:00')), false, 'Saturday');
  assert.equal(inOfficeHours(at('2026-11-26T08:00:00Z')), true, '11:00 in Riyadh');
});

test('the hand-over line is time-aware; the outage line drops "I can help now" out of hours', () => {
  const open = at('2026-11-26T12:00:00+03:00');
  const closed = at('2026-11-27T22:00:00+03:00');
  assert.deepEqual(OUT_OF_HOURS, {
    en: 'Your message is with the Bona team; they reply Sunday to Thursday, 10:00–19:00. If you have a question about our homes, I can help now.',
    ar: 'وصلت رسالتك لفريق بونا، ويردّون من الأحد إلى الخميس 10:00–19:00. وإذا عندك سؤال عن عقاراتنا، أقدر أساعدك الحين.',
  });
  assert.deepEqual(OUTAGE_OUT_OF_HOURS, {
    en: 'Your message is with the Bona team; they reply Sunday to Thursday, 10:00–19:00.',
    ar: 'وصلت رسالتك لفريق بونا، ويردّون من الأحد إلى الخميس 10:00–19:00.',
  });
  const lead = 'LEAD-20261127-0000aaaa';
  assert.equal(handoverLine({ leadId: lead, language: 'en', at: open }), handoverFor(lead, 'en'));
  assert.equal(handoverLine({ leadId: lead, language: 'ar', at: closed }), OUT_OF_HOURS.ar);
  assert.equal(outageLine({ language: 'en', at: open }), TODAY_HANDOVER.en, 'inside hours: HANDOVER variant 0');
  assert.equal(outageLine({ language: 'ar', at: open }), TODAY_HANDOVER.ar);
  assert.equal(outageLine({ language: 'en', at: closed }), OUTAGE_OUT_OF_HOURS.en);
  assert.equal(outageLine({ language: 'ar', at: closed }), OUTAGE_OUT_OF_HOURS.ar);
  for (const lang of ['en', 'ar']) {
    assert.doesNotMatch(outageLine({ language: lang, at: closed }), /I can help now|أقدر أساعدك/);
  }
});

test('the identity, the email first line, the website greeting and the calendar line are nameless; the named forms carry the name', () => {
  const id = identity();
  assert.match(id, /^You are Bona's AI assistant \(in Arabic: مساعدة بونا الذكية\)/);
  assert.ok(id.includes('on {{channel}}'), 'the channel is filled by the prompt builder');
  assert.ok(id.includes('You have no personal name; never give yourself one, never call yourself Dana or دانة.'));
  assert.ok(id.includes('If asked whether you are a person: you are an AI assistant, and the Bona team can read this chat and step in.'));
  const named = identity({ name: DANA });
  assert.match(named, /^You are Dana \(دانة\), Bona's AI assistant/);
  assert.doesNotMatch(named, /no personal name/);
  assert.deepEqual(EMAIL_FIRST_LINE, { en: "This reply is from Bona's AI assistant.", ar: 'هذا الرد من مساعدة بونا بالذكاء الاصطناعي.' });
  assert.deepEqual(GREETING, { en: "Hello, I'm Bona's AI assistant.", ar: 'أهلاً، أنا مساعدة بونا الذكية.' });
  assert.equal(CALENDAR_LINE, "Booked by Bona's AI assistant on WhatsApp");
  assert.equal(emailFirstLine('en', { name: DANA }), "This reply is from Dana, Bona's AI assistant.");
  assert.equal(greeting('ar', { name: DANA }), 'أهلاً، أنا دانة، مساعدة بونا الذكية.');
  assert.equal(calendarLine({ name: DANA }), "Booked by Dana, Bona's AI assistant, on WhatsApp");
  for (const s of [id, ...Object.values(EMAIL_FIRST_LINE), ...Object.values(GREETING), CALENDAR_LINE]) {
    assert.doesNotMatch(s.replace('never call yourself Dana or دانة', ''), NAME_RE, s);
  }
});
