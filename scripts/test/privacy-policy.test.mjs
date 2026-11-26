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
  assert.match(en, /When nobody on our team has written in your WhatsApp chat with us in the last 24 hours, Dana, our AI assistant, may answer your new messages from our number/);
  assert.match(en, /Her first message identifies her as an AI assistant/);
  assert.match(en, /our earlier replies in it and what we hold about your enquiry \(such as your name, interest, budget and district\) are sent to Retell and the AI providers it uses/);
  assert.match(en, /only prices published on this site/);
  assert.match(en, /hands the conversation to a team member when you ask to speak to a person, ask to view a home or make an offer/);
  assert.match(en, /deleted from our records/);
  assert.match(ar, /إذا لم يكتب أحد من فريقنا في محادثتك معنا عبر واتساب خلال الساعات الأربع والعشرين الماضية، فقد تردّ دانة، مساعدتنا التي تعمل بالذكاء الاصطناعي، على رسائلك الجديدة من رقمنا/);
  assert.match(ar, /في أول رسالة منها أنها مساعدة تعمل بالذكاء الاصطناعي/);
  assert.match(ar, /وردودنا السابقة فيها وما لدينا عن استفسارك \(كاسمك واهتمامك وميزانيتك والحي\)/);
  assert.match(ar, /إلى Retell ومزوّدي الذكاء الاصطناعي الذين تستعين بهم/);
  assert.match(ar, /الأسعار المنشورة في هذا الموقع/);
  assert.match(ar, /تُحيل المحادثة إلى أحد أعضاء الفريق إذا طلبت التحدث إلى شخص، أو طلبت معاينة، أو قدّمت عرضاً/);
  assert.match(ar, /لحذف تلك الرسائل من سجلاتنا/);
  assert.doesNotMatch(body(s, 'ar') + body(section('ai-concierge'), 'ar'), /دانا/, 'one spelling of her name, the one clients see');
  const sharing = section('sharing');
  assert.match(body(sharing, 'en'), /Retell and its AI service providers for the concierge and for Dana’s WhatsApp replies/);
  assert.match(body(sharing, 'ar'), /للمساعد ولردود دانة عبر واتساب/);
  // The concierge section no longer sells WhatsApp as the AI-free route: Dana may answer there too.
  const concierge = section('ai-concierge');
  assert.match(body(concierge, 'en'), /on WhatsApp, Dana may also answer when nobody on our team has written in the chat in the last 24 hours/);
  assert.match(body(concierge, 'ar'), /وعلى واتساب قد تردّ دانة أيضاً إذا لم يكتب أحد من فريقنا/);
  assert.doesNotMatch(body(concierge, 'en'), /Use WhatsApp instead if you do not want to use the AI concierge\./);
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

// ---- Bona's own WhatsApp number and the AI phone line (2026-11-19, design 2026-11-16 §8/§11) ----
// CANDIDATE text: the owner OKs the EN and AR wording before the branch is merged.

test('the AI phone assistant section: who answers, the recording, where the voice goes, how long audio is kept, how to have it deleted', () => {
  const s = section('ai-phone-line');
  assert.ok(s, 'the WhatsApp number is public and callable, and calls to it reach the AI line (design §8)');
  const ids = policy.sections.map((x) => x.id);
  assert.equal(ids.indexOf('ai-phone-line'), ids.indexOf('ai-concierge') + 1);
  const en = body(s, 'en');
  const ar = body(s, 'ar');
  for (const text of [en, ar]) assert.ok(text.includes(site.whatsapp.display), 'the number it answers');
  assert.match(en, /an AI system, not a person/);
  assert.match(en, /the call is recorded/);
  assert.match(en, /sent to OpenAI/);
  assert.match(en, /outside Saudi Arabia/);
  assert.match(en, /up to 90 days/);
  assert.match(en, /no audio recording is kept/);
  assert.match(en, /never asks for ID numbers, bank or payment details/);
  // Phone calls only: a WhatsApp call to the same number never reaches the AI line.
  assert.ok(en.includes(`Phone calls to Bona’s number, ${site.whatsapp.display} (not WhatsApp calls), are answered at any hour`), en);
  assert.match(en, /WhatsApp calls to that number do not reach the assistant; please write to us on WhatsApp instead\./);
  assert.ok(ar.includes(`المكالمات الهاتفية الواردة إلى رقم بونا ${site.whatsapp.display} (لا مكالمات واتساب)`), ar);
  assert.match(ar, /ولا تصل مكالمات واتساب إلى هذا الرقم إلى المساعدة، فراسلنا كتابةً عبر واتساب بدلاً من ذلك\./);
  assert.match(ar, /الذكاء الاصطناعي/);
  assert.match(ar, /مسجّلة/);
  assert.match(ar, /OpenAI/);
  assert.match(ar, /خارج المملكة/);
  assert.match(ar, /تسعون يوماً/);
  // Phase 1 makes no enquiry from a call (~/bona-line catalogue.py refuses create_lead; POST /v1/calls
  // does not exist yet): the transcript and details stay with the local call record, and the text
  // says where they are rather than pointing at the enquiry store.
  assert.ok(en.includes('The transcript and your details are kept with the call record on Bona’s own systems until you ask us to delete them.'), en);
  assert.ok(ar.includes('أما النص المكتوب وبياناتك فتُحفظ مع سجل المكالمة على أنظمة بونا الخاصة إلى أن تطلب منا حذفها.'), ar);
  // The call alert (~/bona-line call_alert.py, 2026-11-26): every call's number and details also go to the
  // owner's WhatsApp from the Bona number, and a deletion request for a call covers that note too.
  assert.ok(en.includes('until you ask us to delete them. After each call, Bona’s WhatsApp number also sends the owner of Bona a short WhatsApp note about it, with the number you called from and the details you gave'), en);
  assert.match(en, /so that a principal can get back to you; a request to delete a call also deletes that note\./);
  assert.ok(ar.includes('إلى أن تطلب منا حذفها. وبعد كل مكالمة، يُرسل رقم واتساب بونا إلى مالك بونا ملاحظة قصيرة عنها عبر واتساب، فيها الرقم الذي اتصلت منه والبيانات التي ذكرتها'), ar);
  assert.match(ar, /ليتواصل معك أحد شركاء الدار؛ وطلب حذف مكالمة يشمل حذف هذه الملاحظة أيضاً\./);
  for (const gone of ['kept as an enquiry, like any other', 'the enquiry it produced']) assert.ok(!en.includes(gone), `en still says: ${gone}`);
  for (const gone of ['بوصفها استفساراً كأي استفسار آخر', 'الاستفسار الناتج عنها']) assert.ok(!ar.includes(gone), `ar still says: ${gone}`);
  assert.match(en, /To have a call recording, its transcript or your details deleted, message us on WhatsApp/);
  assert.match(ar, /ولطلب حذف تسجيل مكالمة أو نصها أو بياناتك، راسلنا على واتساب/);
  assert.match(ar, /فلا يُحتفظ بأي تسجيل صوتي/);
  // Declining keeps no audio, but the transcript and the details stay (~/bona-line call_record.py
  // finish_audio deletes only the raw tracks and the WAV): the same paragraph says so.
  const declineEn = s.body.en.find((p) => p.includes('do not want to be recorded'));
  const declineAr = s.body.ar.find((p) => p.includes('لا ترغب في تسجيل المكالمة'));
  assert.ok(declineEn && declineAr, 'the decline sentence in both languages');
  assert.match(declineEn, /no audio recording is kept; it notes your details for a callback and ends the call\. The written transcript of that call and the details you give are still kept, as described below\./);
  assert.match(declineAr, /فلا يُحتفظ بأي تسجيل صوتي لها، وتدوّن المساعدة بياناتك ليُعاوَد الاتصال بك ثم تُنهي المكالمة\. لكن النص المكتوب لتلك المكالمة والبيانات التي تذكرها يظلّان محفوظَين كما هو موضّح أدناه\./);
  assert.match(body(section('sharing'), 'en'), /OpenAI for the AI phone assistant/);
  assert.match(body(section('sharing'), 'ar'), /OpenAI للمساعدة الهاتفية/);
  // Its pointers lead to real headings, the same ones in both languages.
  const heads = (locale) => new Map(policy.sections.map((x) => [x.heading[locale], x.id]));
  const to = (text, re, locale) => [...text.matchAll(re)].map((m) => heads(locale).get(m[1]));
  const enTo = to(en, /“([^”]+)”\)?\s+below/g, 'en');
  const arTo = to(ar, /«([^»]+)»\)?\s+أدناه/g, 'ar');
  assert.ok(enTo.length > 0 && enTo.every(Boolean), `en pointers: ${enTo}`);
  assert.deepEqual([...new Set(arTo)].sort(), [...new Set(enTo)].sort());
});

test('the business-partner sentence (owner OK 2026-11-26) sits with the WhatsApp conversations and the call records', () => {
  const en = 'A business partner of the owner of Bona who also uses his AI tools can access them as well.';
  const ar = 'ويمكن كذلك لشريك أعمال لمالك بونا يستخدم أدوات الذكاء الاصطناعي نفسها الوصول';
  for (const id of ['whatsapp-conversations', 'ai-phone-line']) assert.ok(body(section(id), 'en').includes(en), `${id} en`);
  // Arabic: "them" is the conversations (plural, إليها) in one section, the recording and the transcript (dual, إليهما) in the other.
  assert.ok(body(section('whatsapp-conversations'), 'ar').includes(`تسجيل الدخول. ${ar} إليها.`));
  assert.ok(body(section('ai-phone-line'), 'ar').includes(`وقراءة النص. ${ar} إليهما.`));
  // The dated change line says so too, until its 30 days are up (on or after 2026-12-26).
  if (new Date().toISOString().slice(0, 10) >= '2026-12-26') return;
  const changes = section('changes');
  assert.ok(changes.body.en.some((p) => /^26 November 2026:.*business partner of the owner of Bona/.test(p)));
  assert.ok(changes.body.ar.some((p) => /^26 نوفمبر 2026:.*شريك أعمال لمالك بونا/.test(p)));
});

test('the 26 Nov change line mentions the call alert note (until its 30 days are up, 2026-12-26)', () => {
  if (new Date().toISOString().slice(0, 10) >= '2026-12-26') return;
  const changes = section('changes');
  assert.ok(changes.body.en.some((p) => /^26 November 2026:.*after each call, the owner of Bona gets a short WhatsApp note about it\./.test(p)));
  assert.ok(changes.body.ar.some((p) => /^26 نوفمبر 2026:.*وتصل مالكَ بونا بعد كل مكالمة ملاحظةٌ قصيرة عنها عبر واتساب\./.test(p)));
});

test('a deletion or data request is sent on WhatsApp, never by phone (a call reaches the AI line, 2026-11-26)', () => {
  const en = policy.sections.flatMap((x) => x.body.en).join(' ') + ' ' + policy.contact.en;
  const ar = policy.sections.flatMap((x) => x.body.ar).join(' ') + ' ' + policy.contact.ar;
  assert.doesNotMatch(en, /call us/i);
  assert.doesNotMatch(ar, /اتصل بنا/);
  assert.ok(body(section('whatsapp-conversations'), 'en').includes(`from our phones, message us on WhatsApp at ${site.whatsapp.display}`));
  assert.ok(body(section('whatsapp-conversations'), 'ar').includes(`من هواتفنا، راسلنا على واتساب على الرقم ${site.whatsapp.display}`));
  const page = fs.readFileSync(new URL('../../src/components/pages/PrivacyPage.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /tel:/, 'the privacy page offers WhatsApp for questions about your data, not a call');
});

test("dashboard replies are said to come from the site's WhatsApp number", () => {
  const s = section('whatsapp-conversations');
  assert.ok(body(s, 'en').includes(`come from Bona’s WhatsApp number, ${site.whatsapp.display}`));
  assert.ok(body(s, 'ar').includes(`من رقم واتساب بونا ${site.whatsapp.display}`));
});

test('every number the policy writes out is site.whatsapp or site.phone, and the version date moved with the new number', () => {
  // The dated "Changes" lines may name the number that was replaced; nothing else may.
  const all = JSON.stringify({ ...policy, sections: policy.sections.filter((x) => x.id !== 'changes') });
  const digits = (x) => String(x).replace(/\D/g, '');
  for (const m of all.matchAll(/\+966 5\d \d{3} \d{4}/g)) assert.ok([site.whatsapp.display, site.phone.display].includes(m[0]), m[0]);
  for (const m of JSON.stringify(section('changes')).matchAll(/\+966 5\d \d{3} \d{4}/g)) assert.ok([site.whatsapp.display, '+966 59 329 6933'].includes(m[0]), m[0]);
  assert.ok(policy.updated >= '2026-11-26', 'the version date moves with the new number');
  assert.equal(digits(site.whatsapp.e164), digits(site.phone.e164), 'calls moved to Bona\'s own number too (owner 2026-11-26)');
});

// The dated line comes out once its 30 days are up (on or after 2026-12-26), and this test with it.
test('the Changes section flags the new WhatsApp number and the AI phone assistant, in both languages (30 days)', () => {
  if (new Date().toISOString().slice(0, 10) >= '2026-12-26') return;
  const changes = section('changes');
  const en = changes.body.en.find((p) => /^26 November 2026:/.test(p));
  const ar = changes.body.ar.find((p) => /^26 نوفمبر 2026:/.test(p));
  assert.ok(en && ar, 'a dated line in each language');
  for (const text of [en, ar]) {
    assert.ok(text.includes(site.whatsapp.display), 'the new number');
    assert.ok(text.includes('+966 59 329 6933'), 'the number it replaces');
  }
  assert.match(en, /“The AI phone assistant”/);
  assert.match(ar, /«المساعدة الهاتفية بالذكاء الاصطناعي»/);
  assert.ok(en.includes(`phone calls to ${site.whatsapp.display} (not WhatsApp calls) are answered by an AI assistant`), en);
  assert.ok(ar.includes(`المكالمات الهاتفية إلى الرقم ${site.whatsapp.display} (لا مكالمات واتساب)`), ar);
});

test('no English line says "calls to" the WhatsApp number without saying phone calls or WhatsApp calls', () => {
  const faq = read('../../src/data/faq.json');
  const texts = [...policy.sections.flatMap((x) => x.body.en), ...faq.items.flatMap((x) => x.a.en)];
  const target = `(?:that number|this number|Bona’s number|${site.whatsapp.display.replace(/[+]/g, '\\+')})`;
  for (const text of texts) {
    // Every "calls to" says which kind: phone calls reach the AI line, WhatsApp calls do not. A
    // sentence that opens with "Calls to …" has no word before it: that fails too.
    for (const m of text.matchAll(new RegExp(`(?:(\\S+)\\s+)?calls to ${target}`, 'gi'))) {
      assert.match(m[1] ?? '', /^(phone|WhatsApp)$/i, `"${m[0]}" must say phone calls or WhatsApp calls: ${text}`);
    }
  }
});
