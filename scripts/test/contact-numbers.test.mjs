// Every hand copy of Bona's contact numbers agrees with src/data/site.json (2026-11-19 WhatsApp move).
// site.whatsapp moved to Bona's own number; site.phone stays until Phase 3. A wa.me link is always
// the WhatsApp number, and any Saudi mobile number written out is one of the two.
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
  'services/api/lib/tools.mjs', 'services/api/index.mjs', 'services/intake/rebrand_pdf.py',
];
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
    const text = read(f);
    for (const m of text.matchAll(/wa\.me\/(\d+)/g)) assert.equal(m[1], WA, `${f}: wa.me/${m[1]}`);
    for (const m of text.matchAll(/(?:\+|00)?966[\s -]?5\d(?:[\s -]?\d){7}/g)) {
      const n = digits(m[0]);
      assert.ok([WA, PHONE].includes(n) || EXAMPLE.test(n), `${f}: ${m[0]} is neither site.whatsapp nor site.phone`);
    }
  }
});

test('the WhatsApp-only hand copies no longer name the phone number', () => {
  assert.notEqual(WA, PHONE, 'this branch moves WhatsApp only');
  for (const f of WHATSAPP_ONLY) {
    const text = read(f);
    assert.ok(text.includes(site.whatsapp.display) || text.includes(site.whatsapp.e164) || text.includes(WA), `${f} does not name the WhatsApp number`);
    assert.ok(!text.includes(PHONE) && !text.includes(site.phone.display), `${f} still names the phone number as WhatsApp`);
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
