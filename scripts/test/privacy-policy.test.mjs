// src/data/privacy.json — the policy the site renders at /privacy/ and /ar/privacy/.
// PrivacyPage.astro quietly drops a section with no id or heading and falls back to English
// for a missing Arabic body, so a broken entry would ship as a hole nobody sees in review.
// The WhatsApp conversations section is what Phase 2 of the team inbox (2026-09-27 design
// §4.6) has to say before a single transcript is stored: what is kept, who reads it, for
// how long, where other copies stay, and how to have it deleted. Dana is left out of it on
// purpose until she answers on WhatsApp (Phase 4) — a policy that promises what the service
// does not do is as wrong as one that hides what it does. A dated line in *Changes* flags a
// material change for the 30 days the page promises and is then removed: a test that asks
// for one asks only until its 30 days are up, and the pointer test checks the page without
// them too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const policy = read('../../src/data/privacy.json');
const site = read('../../src/data/site.json');
const section = (id) => policy.sections.find((s) => s.id === id);
const body = (s, locale) => s.body[locale].join(' ');

test('every section has an id, both headings and the same number of EN and AR paragraphs', () => {
  assert.match(policy.updated, /^\d{4}-\d{2}-\d{2}$/);
  const ids = policy.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'section ids are the page anchors, so they must be unique');
  for (const s of policy.sections) {
    assert.match(s.id, /^[a-z0-9-]+$/, `${s.id}: the page rewrites anything else in an id`);
    for (const locale of ['en', 'ar']) {
      assert.equal(typeof s.heading?.[locale], 'string', `${s.id} heading.${locale}`);
      assert.ok(s.heading[locale].trim(), `${s.id} heading.${locale} is empty`);
      assert.ok(Array.isArray(s.body?.[locale]) && s.body[locale].length > 0, `${s.id} body.${locale}`);
      for (const p of s.body[locale]) assert.ok(typeof p === 'string' && p.trim(), `${s.id} body.${locale} has an empty paragraph`);
    }
    assert.equal(s.body.en.length, s.body.ar.length, `${s.id}: the Arabic text is the authoritative one, so it says everything the English does`);
  }
});

test('the WhatsApp conversations section says what is stored, who reads it, for how long and how to have it deleted', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'Phase 2 stores WhatsApp transcripts; the policy has to say so before it does');
  const ids = policy.sections.map((x) => x.id);
  assert.equal(ids.indexOf('whatsapp-conversations'), ids.indexOf('whatsapp-enquiries') + 1, 'it follows the WhatsApp enquiries section it extends');
  assert.ok(policy.updated >= '2026-09-28', 'the date at the top is the version date and must move with a material change');

  const en = body(s, 'en');
  assert.match(en, /stores that conversation/);
  assert.match(en, /up to 30 days before it became an enquiry/, 'a join also stores the chat before it (24 h, or 30 days when the owner adds it)');
  assert.match(en, /authorised members of the Bona team/);
  assert.match(en, /private dashboard/);
  assert.match(en, /five years after its last message/);
  assert.match(en, /deleted automatically/);
  // The copies bona.db retention does not govern are named, not hidden, and the one Bona
  // runs itself (Evolution, on its own server) is not passed off as WhatsApp's.
  assert.match(en, /does not reach two other copies/);
  assert.match(en, /the WhatsApp gateway server that Bona runs for this number keeps its own copy/);
  assert.doesNotMatch(en, /WhatsApp service our number runs on/);
  assert.match(en, /on our phones, in WhatsApp, under WhatsApp’s own terms/);
  assert.match(en, /from the dashboard, from our gateway server or from our phones/);
  // Not a client purges the transcript, not the lead's first-message snippet (leads.mjs).
  assert.match(en, /any short excerpt of its first message kept with the enquiry record stays there/);

  const ar = body(s, 'ar');
  assert.match(ar, /تحتفظ بونا بتلك المحادثة/);
  assert.match(ar, /ثلاثون يوماً قبل أن تصبح استفساراً/);
  assert.match(ar, /فريق بونا/);
  assert.match(ar, /لوحة خاصة/);
  assert.match(ar, /خمس سنوات/);
  assert.match(ar, /تلقائي/);
  assert.match(ar, /ولا يشمل هذا الحذف التلقائي نسختين أخريين/);
  assert.match(ar, /فخادم بوابة واتساب الذي تشغّله بونا لهذا الرقم يحتفظ بنسخته الخاصة/);
  assert.doesNotMatch(ar, /خدمة واتساب التي يعمل عليها رقمنا/);
  assert.match(ar, /على هواتفنا داخل واتساب، وفق شروط واتساب/);
  assert.match(ar, /من اللوحة أو من خادم البوابة أو من هواتفنا/);
  assert.match(ar, /مقتطف قصير من رسالتها الأولى/);

  // The deletion route is the one the page's contact block and buttons offer (site.json).
  for (const text of [en, ar, policy.contact.en, policy.contact.ar]) {
    assert.ok(text.includes(site.whatsapp.display), 'WhatsApp number');
  }
  assert.ok(en.includes(site.phone.display) && ar.includes(site.phone.display), 'phone number');
});

// “…” below / «…» أدناه is how the WhatsApp conversations section sends the reader on; a
// dated Changes line names the section it added. Renaming a heading must not leave a
// pointer to nothing behind.
const POINTERS = {
  'whatsapp-conversations': { en: /“([^”]+)”\)?\s+below/g, ar: /«([^»]+)»\)?\s+أدناه/g },
  changes: { en: /“([^”]+)”/g, ar: /«([^»]+)»/g },
};
/** A dated Changes line: “28 September 2026: …” / “28 سبتمبر 2026: …”. */
const DATED_LINE = /^\d{1,2} \S+ \d{4}:/u;

function checkPointers(p) {
  const idOf = (locale) => new Map(p.sections.map((x) => [x.heading[locale], x.id]));
  for (const [id, re] of Object.entries(POINTERS)) {
    const s = p.sections.find((x) => x.id === id);
    assert.ok(s, `${id} is missing`);
    const targets = {};
    for (const locale of ['en', 'ar']) {
      const headings = idOf(locale);
      const quoted = [...body(s, locale).matchAll(re[locale])].map((m) => m[1]);
      // The conversations section always sends the reader on. Changes may point nowhere:
      // its dated lines come out once their 30 days are up.
      if (id === 'whatsapp-conversations') assert.ok(quoted.length > 0, `${id}.${locale}: expected at least one pointer to a section`);
      for (const q of quoted) assert.ok(headings.has(q), `${id}.${locale} points to “${q}”, which is no ${locale} heading`);
      targets[locale] = [...new Set(quoted.map((q) => headings.get(q)))].sort();
    }
    assert.deepEqual(targets.ar, targets.en, `${id}: the Arabic text points to the same sections as the English`);
  }
}

test('what the WhatsApp conversations section and a dated change line point to is a real heading, the same in both languages', () => {
  checkPointers(policy);
  // The page flags a material change for 30 days, so the dated Changes line comes out
  // again (these on or after 2026-10-30). Doing that must not turn this test red.
  const later = structuredClone(policy);
  const changes = later.sections.find((x) => x.id === 'changes');
  for (const locale of ['en', 'ar']) changes.body[locale] = changes.body[locale].filter((para) => !DATED_LINE.test(para));
  assert.ok(changes.body.en.length > 0 && changes.body.en.length === changes.body.ar.length, 'Changes keeps its standing paragraph in both languages');
  checkPointers(later);
});

test('Dana is named in that section now that she answers on WhatsApp (Phase 4, switched on 2026-10-01)', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'the section is missing');
  const en = body(s, 'en');
  const ar = body(s, 'ar');
  // What the system does (lib/dana-wa.mjs): she answers new messages when no human wrote in
  // the chat for 24 h, discloses she is an AI, sends the chat and the enquiry facts (never the
  // number) to Retell and its providers, quotes only published prices, hands over on request.
  assert.match(en, /in the last 24 hours, Dana, our AI assistant, may answer your new messages from our number/);
  assert.match(en, /Her first message identifies her as an AI assistant/);
  assert.match(en, /our earlier replies in it and what we hold about your enquiry \(such as your name, interest, budget and district\) are sent to Retell and the AI providers it uses/);
  assert.match(en, /only prices published on this site/);
  assert.match(en, /hands the conversation to a team member when you ask to speak to a person, ask to view a home or make an offer/);
  assert.match(en, /deleted from our records/);
  assert.match(ar, /خلال الساعات الأربع والعشرين الماضية، فقد تردّ دانة، مساعدتنا التي تعمل بالذكاء الاصطناعي، على رسائلك الجديدة من رقمنا/);
  assert.match(ar, /في أول رسالة منها أنها مساعدة تعمل بالذكاء الاصطناعي/);
  assert.match(ar, /وردودنا السابقة فيها وما لدينا عن استفسارك/);
  assert.match(ar, /إلى Retell ومزوّدي الذكاء الاصطناعي الذين تستعين بهم/);
  assert.match(ar, /الأسعار المنشورة في هذا الموقع/);
  assert.match(ar, /تُحيل المحادثة إلى أحد أعضاء الفريق إذا طلبت التحدث إلى شخص، أو طلبت معاينة، أو قدّمت عرضاً/);
  assert.match(ar, /لحذف تلك الرسائل من سجلاتنا/);
  assert.doesNotMatch(body(s, 'ar') + body(section('ai-concierge'), 'ar'), /دانا/, 'one spelling of her name, the one clients see');
  const sharing = section('sharing');
  assert.match(body(sharing, 'en'), /Retell and its AI service providers for the concierge and for Dana’s WhatsApp replies/);
  assert.match(body(sharing, 'ar'), /للمساعد وللردود عبر واتساب/);
  assert.ok(policy.updated >= '2026-10-01', 'the page date moved on when she went live');
});

// The page flags a material change for 30 days (like the 30 September lines): the two dated
// lines and this test's asserts come out on or after 2026-10-31.
test('the Changes section flags the day Dana went live, in both languages (30 days)', () => {
  if (new Date().toISOString().slice(0, 10) >= '2026-10-31') return;
  const changes = section('changes');
  const line = (locale, start) => changes.body[locale].find((p) => p.startsWith(start)) ?? '';
  assert.match(line('en', '1 October 2026:'), /Dana, our AI assistant/);
  assert.match(line('en', '1 October 2026:'), /“WhatsApp conversations with our team”/);
  assert.match(line('en', '1 October 2026:'), /sent to Retell/);
  assert.match(line('ar', '1 أكتوبر 2026:'), /دانة، مساعدتنا التي تعمل بالذكاء الاصطناعي/);
  assert.match(line('ar', '1 أكتوبر 2026:'), /«محادثات واتساب مع فريق بونا»/);
  assert.match(line('ar', '1 أكتوبر 2026:'), /إلى Retell/);
});

test('the chats kept only to be checked are named: what is kept, for how long, and that the conversation is not (D17)', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'the section is missing');
  const en = body(s, 'en');
  // What keeps a chat, exactly as the code decides it (lib/inbox/eligibility.mjs
  // PROPERTY_WORDS, lib/wa-poller.mjs candidateWordsOf): one of the listed property words,
  // in a message sent or received; a property document named in a message or a file name
  // (a brochure, or another kind next to a property word: eligibility.mjs
  // mentionsPropertyDocument); a document the owner sends that calls itself one of the kinds,
  // or names TK. Not "looks like a property enquiry": that promised a judgement the code does
  // not make, nor "such as a brochure, a floor plan or a price list": a floor plan or a price
  // list alone keeps nothing (final review, 2026-09-29).
  assert.doesNotMatch(en, /looks like a property enquiry/);
  assert.match(en, /When a message sent or received on our number uses one of these property words — villa, apartment, rent \(rental, for rent\), for sale, real estate, property, duplex, penthouse, townhouse, or in Arabic فيلا, شقة, إيجار \(للإيجار\), للبيع, عقار, دوبلكس, بنتهاوس, تاون هاوس —/);
  assert.doesNotMatch(en, /such as a brochure, a floor plan or a price list/);
  assert.match(en, /or mentions a property document, meaning a brochure, or a floor plan, plan, price list, payment plan, master plan, fact sheet or booklet mentioned together with a property such as a unit, a project or a tower/);
  assert.match(en, /or when the owner of Bona sends a document whose name or caption calls it a brochure, floor plan, plan, price list, payment plan, master plan, fact sheet or booklet, or names TK Estate & Design, his other company/);
  assert.match(en, /A plan, a price list or a booklet mentioned on its own does not count/);
  assert.match(en, /and the chat is not already a Bona enquiry/);
  assert.match(en, /until 30 days after the last such message/);
  assert.doesNotMatch(en, /for up to 30 days/, 'a chat that keeps writing is kept as long as it does');
  assert.match(en, /The conversation itself is not stored unless/);
  assert.match(en, /for up to a year/);
  // "Only" lists every field the row keeps (lib/inbox/store.mjs `inbox_candidates`): the
  // ids, the name, the words, the times, the count and who wrote last.
  assert.match(en, /we keep only the number \(and the ids WhatsApp gives the chat\), the name WhatsApp shows for it, those words \(or that it was a property or TK document\)/);
  assert.match(en, /when such messages were sent, how many there were and who sent the last one/);
  assert.doesNotMatch(en, /we keep only the number, the name WhatsApp shows for it and the property words/);
  // A later sure sign joins the chat on its own, and the join copies its earlier messages.
  assert.match(en, /unless he adds it to the Bona inbox or it later becomes a Bona enquiry/);
  assert.match(en, /only the number and the ids WhatsApp gives the chat are kept, for up to a year/);
  // The first paragraph's "not stored" no longer stands alone: it points to the exception.
  assert.match(en, /are not stored; the next paragraph describes the one narrow exception/);
  assert.ok(policy.updated >= '2026-09-29', 'the version date moves with this change');
  const ar = body(s, 'ar');
  assert.doesNotMatch(ar, /استفساراً عقارياً/);
  assert.match(ar, /إذا استُخدمت في رسالة مُرسلة أو واردة على رقمنا إحدى هذه الكلمات العقارية — فيلا، شقة، إيجار \(للإيجار\)، للبيع، عقار، دوبلكس، بنتهاوس، تاون هاوس، أو بالإنجليزية villa وapartment وrent \(rental وfor rent\) وfor sale وreal estate وproperty وduplex وpenthouse وtownhouse —/);
  assert.doesNotMatch(ar, /مستند عقاري مثل بروشور أو مخطط أو قائمة أسعار/);
  assert.match(ar, /أو ذُكر فيها مستند عقاري، أي بروشور، أو مخطط أو قائمة أسعار أو خطة دفع أو نشرة معلومات أو كتيب مذكوراً مع عقار مثل وحدة أو مشروع أو برج/);
  assert.match(ar, /أو أرسل مالك بونا مستنداً يصفه اسمه أو النص المرفق به بأنه بروشور أو مخطط أو قائمة أسعار أو خطة دفع أو نشرة معلومات أو كتيب، أو يذكر شركته الأخرى TK Estate & Design/);
  assert.match(ar, /ولا يكفي ذكر مخطط أو قائمة أسعار أو كتيب وحده/);
  assert.match(ar, /ولم تكن المحادثة استفساراً لدى بونا أصلاً/);
  assert.match(ar, /حتى ثلاثين يوماً من آخر رسالة من هذا النوع/);
  assert.match(ar, /ولا تُحفظ المحادثة نفسها/);
  assert.match(ar, /مدةً أقصاها سنة/);
  assert.match(ar, /باستثناء محدود نبيّنه في الفقرة التالية/);
  assert.match(ar, /إلا بالرقم \(ومعرّفات واتساب للمحادثة\)، والاسم الذي يُظهره واتساب له، وهذه الكلمات \(أو أنها كانت مستنداً عقارياً أو مستنداً لـ TK\)/);
  assert.match(ar, /ووقت هذه الرسائل وعددها ومَن أرسل آخرها/);
  assert.match(ar, /ما لم يُضفها إلى صندوق محادثات بونا أو تصبح لاحقاً استفساراً لدى بونا/);
  assert.match(ar, /لا نحتفظ إلا بالرقم ومعرّفات واتساب للمحادثة، مدةً أقصاها سنة/);
});

test('the Changes section flags the chats kept only to be checked, in both languages, for its 30 days (D17)', () => {
  const changes = section('changes');
  assert.ok(changes, 'the Changes section is missing');
  // The page promises to flag a material change here for 30 days; this line comes out on
  // or after 2026-10-30, and from then on nothing asks for it.
  if (new Date().toISOString().slice(0, 10) >= '2026-10-30') return;
  const en = changes.body.en.filter((p) => p.startsWith('30 September 2026:')).find((p) => p.includes('exception'));
  assert.ok(en, 'the version date moved to 30 September for this change (the day it went public), so Changes says what changed');
  assert.match(en, /“WhatsApp conversations with our team”/);
  assert.match(en, /When a message sent or received on our number uses one of the property words that section lists, or mentions a property document as that section defines it, or the owner of Bona sends one of the kinds of document it lists or a document of TK Estate & Design, and the chat is not already a Bona enquiry/);
  assert.doesNotMatch(en, /looks like a property enquiry/);
  assert.match(en, /the number, the name WhatsApp shows and those words, not the conversation/);
  assert.match(en, /until 30 days after the last such message/);
  assert.match(en, /for up to a year/);
  const ar = changes.body.ar.filter((p) => p.startsWith('30 سبتمبر 2026:')).find((p) => p.includes('استثناء'));
  assert.ok(ar, 'the Arabic text says everything the English does');
  assert.match(ar, /«محادثات واتساب مع فريق بونا»/);
  assert.match(ar, /فإذا استُخدمت في رسالة مُرسلة أو واردة على رقمنا إحدى الكلمات العقارية التي يذكرها القسم، أو ذُكر فيها مستند عقاري بالمعنى الذي يحدده القسم، أو أرسل مالك بونا أحد أنواع المستندات التي يذكرها أو مستنداً لـ TK Estate & Design، ولم تكن المحادثة استفساراً لدى بونا أصلاً/);
  assert.doesNotMatch(ar, /استفساراً عقارياً دون أن يتضح/);
  assert.match(ar, /الرقم، والاسم الذي يُظهره واتساب، وهذه الكلمات، دون المحادثة نفسها/);
  assert.match(ar, /حتى ثلاثين يوماً من آخر رسالة من هذا النوع/);
  assert.match(ar, /مدةً أقصاها سنة/);
  assert.ok(policy.updated >= '2026-09-29', 'the version date is the newest change');
});
