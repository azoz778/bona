// Every hand copy of Bona's contact numbers agrees with src/data/site.json (2026-11-19 WhatsApp move).
// site.whatsapp moved to Bona's own number, and on 2026-11-26 the owner moved site.phone there too
// (calls reach the AI phone line). A wa.me link is always the WhatsApp number, any Saudi mobile
// number written out is one of the two, and the owner's personal number is gone from every hand copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const site = JSON.parse(read('src/data/site.json'));
const digits = (s) => String(s).replace(/\D/g, '');
const WA = site.whatsapp.wa;
const PHONE = digits(site.phone.e164);
// The repo's example numbers (+966 50 000 00xx), as in the comment at services/api/lib/tools.mjs:62.
const EXAMPLE = /^9665000000\d\d$/;

const FILES = [
  'src/data/faq.json', 'src/data/privacy.json', 'src/data/content-calendar.json', 'src/data/integrations.json',
  'marketing/page-meta.json', 'marketing/growth-targets.json', 'public/site.webmanifest', 'services/api/retell/prompt.md',
  'services/api/lib/tools.mjs', 'services/api/index.mjs',
];
// The owner's personal number, which both lines used before the move. Only the dated lines of the
// privacy notice's "Changes" section may still name it (they say what it was replaced by).
const OLD = '966593296933';
// A hand copy's text, with the privacy notice's "Changes" section left out (its dated lines name the old number).
const textOf = (f) => {
  if (f !== 'src/data/privacy.json') return read(f);
  const policy = JSON.parse(read(f));
  policy.sections = policy.sections.filter((x) => x.id !== 'changes');
  return JSON.stringify(policy);
};
// Hand copies that name only the WhatsApp number (no phone line of their own).
const WHATSAPP_ONLY = [
  'src/data/content-calendar.json', 'marketing/page-meta.json', 'marketing/growth-targets.json', 'public/site.webmanifest', 'src/data/integrations.json',
];

test('site.json: the three WhatsApp fields name one number', () => {
  assert.equal(digits(site.whatsapp.e164), WA);
  assert.equal(digits(site.whatsapp.display), WA);
  assert.match(WA, /^9665\d{8}$/);
});

test('every wa.me link in the hand copies is site.whatsapp, every Saudi mobile written out is site.whatsapp or site.phone', () => {
  for (const f of FILES) {
    const text = textOf(f);
    for (const m of text.matchAll(/wa\.me\/(\d+)/g)) assert.equal(m[1], WA, `${f}: wa.me/${m[1]}`);
    for (const m of text.matchAll(/(?:\+|00)?966[\s -]?5\d(?:[\s -]?\d){7}/g)) {
      const n = digits(m[0]);
      assert.ok([WA, PHONE].includes(n) || EXAMPLE.test(n), `${f}: ${m[0]} is neither site.whatsapp nor site.phone`);
    }
  }
});

test('the WhatsApp-only hand copies name the WhatsApp number', () => {
  for (const f of WHATSAPP_ONLY) {
    const text = read(f);
    assert.ok(text.includes(site.whatsapp.display) || text.includes(site.whatsapp.e164) || text.includes(WA), `${f} does not name the WhatsApp number`);
  }
});

test("site.phone is Bona's own number too, and no hand copy names the owner's personal number (owner 2026-11-26)", () => {
  assert.equal(PHONE, WA, 'calls and WhatsApp share Bona\'s own number');
  assert.equal(site.phone.display, site.whatsapp.display);
  for (const f of FILES) {
    const text = textOf(f);
    const found = [...text.matchAll(/(?:\+|00)?966[\s -]?5\d(?:[\s -]?\d){7}|\b05\d(?:[\s -]?\d){7}\b/g)].map((m) => digits(m[0]).replace(/^0/, '966'));
    assert.ok(!found.includes(OLD), `${f} still names +966 59 329 6933`);
  }
});

test('the FAQ "How do I reach Bona?" answer gives the WhatsApp number and says calls to it reach an AI assistant', () => {
  const faq = JSON.parse(read('src/data/faq.json'));
  const entry = faq.items.find((x) => x.id === 'contact');
  assert.ok(entry, 'the contact entry is there');
  const en = entry.a.en.join(' ');
  const ar = entry.a.ar.join(' ');
  assert.equal(entry.a.en.length, entry.a.ar.length);
  for (const text of [en, ar]) assert.ok(text.includes(site.whatsapp.display), 'the WhatsApp number');
  assert.match(en, /virtual assistant\. It is an AI, says so when it answers and records the call/);
  assert.match(ar, /بالذكاء الاصطناعي/);
  assert.match(ar, /وتسجّل المكالمة/);
  // The AI line answers SIM calls only (~/bona-line line_state.py reads the cellular ring state); a
  // WhatsApp call from the site's chat button rings WhatsApp Business on the Fold, unattended.
  assert.match(en, /Phone calls to that number \(not WhatsApp calls\) are answered at any hour/);
  assert.match(en, /WhatsApp calls do not reach the assistant, so please write to us there instead\./);
  assert.match(ar, /المكالمات الهاتفية إلى هذا الرقم \(لا مكالمات واتساب\)/);
  assert.match(ar, /ولا تصل مكالمات واتساب إلى المساعدة، فراسلنا كتابةً عبر واتساب بدلاً من ذلك\./);
  assert.doesNotMatch(en, /handled by the principal rather than passed down a call centre/, 'design §12: replaced now that calls reach the AI line');
  assert.doesNotMatch(ar, /لا عبر مركز اتصال/);
  assert.ok(ar.includes(`‎${site.whatsapp.display}`), 'the Arabic number keeps its left-to-right mark');
});

test("a number Dana or a tool note offers as WhatsApp is site.whatsapp (prompt.md, tools.mjs, index.mjs)", () => {
  for (const f of ['services/api/retell/prompt.md', 'services/api/lib/tools.mjs', 'services/api/index.mjs']) {
    const offers = [...read(f).matchAll(/WhatsApp(?: and phone)?:?\s+\**(\+966 \d{2} \d{3} \d{4})/g)].map((m) => m[1]);
    assert.ok(offers.length > 0, `${f} offers a WhatsApp number`);
    for (const n of offers) assert.equal(n, site.whatsapp.display, `${f}: WhatsApp ${n}`);
  }
});
