// src/data/privacy.json — the policy the site renders at /privacy/ and /ar/privacy/.
// PrivacyPage.astro quietly drops a section with no id or heading and falls back to English
// for a missing Arabic body, so a broken entry would ship as a hole nobody sees in review.
// The WhatsApp conversations section is what Phase 2 of the team inbox (2026-09-27 design
// §4.6) has to say before a single transcript is stored: what is kept, who reads it, for
// how long, where other copies stay, and how to have it deleted. Since D1 (the go-live of
// Bona's AI assistant on Bona's own number, design 2026-11-26 §10) it also says what that
// assistant does, with no personal name, and which AI provider produces its replies — a
// policy that promises what the service does not do is as wrong as one that hides what it
// does. A dated line in *Changes* flags a material change for the 30 days the page promises
// and is then removed: a test that asks for one asks only until its 30 days are up, and the
// pointer test checks the page without them too.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const policy = read('../../src/data/privacy.json');
const site = read('../../src/data/site.json');
const faq = read('../../src/data/faq.json');
// The text a rollback to the shared number (the owner's personal number) puts back in the WhatsApp
// conversations section: the old first two paragraphs, word for word (DESIGN §13.2, PR-D1r).
const rollback = read('../../services/deploy/vps/rollback/privacy-shared-number.json');
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// The day D1 merged, written once. Its Changes line (EN and AR) carries this date, the version dates at
// the top of privacy.json and faq.json are on or after it, and the line stays for 30 days from it. The
// branch carries a placeholder: at the go-live rebase this constant, both `updated` fields and both
// Changes lines move to the merge day in one commit (PLAN §3 step 9b).
const D1_RELEASED = '2026-11-27';
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

// ---- D1: Bona's AI assistant on Bona's own number (design 2026-11-26 §10; brain/DESIGN-brain §6.3, §11.3) ----
// What the code does (lib/dana-wa.mjs, lib/brain.mjs): it answers every enquiry chat on Bona's own
// number, with no personal name; its first message says it is an AI; the chat and the enquiry facts
// (never the number) go to OpenAI; it hands over on request, on an offer or on what it cannot do,
// and keeps answering about published homes until a person writes; a team member writing quiets it
// for 24 hours; a stop, data or deletion request stops it in that chat and a person takes over.

// Whole words only ("Sadana" is a listing). Arabic writes و ف ب ل ك and ال onto the word itself.
const NAME = {
  en: /\bDana\b/i,
  ar: /(?<![\p{L}\p{M}])(?:[وفبلك]?(?:ال)?)دان[ةا](?![\p{L}\p{M}])/u,
};
const named = (text) => NAME.en.test(text) || NAME.ar.test(text);
/** The paragraph of the WhatsApp conversations section that says what the AI assistant does. */
const aiParagraph = (locale) => section('whatsapp-conversations').body[locale].find((p) => p.includes(
  locale === 'en' ? 'answers messages to our WhatsApp number at any hour' : 'على الرسائل الواردة إلى رقم واتساب بونا في أي وقت'));
/** The sharing paragraph that lists the service providers. */
const providersParagraph = (locale) => section('sharing').body[locale].find((p) => p.startsWith(
  locale === 'en' ? 'Service providers include' : 'تشمل الجهات المقدّمة للخدمة'));

test('the AI assistant paragraph (D1): no name, OpenAI, the hand-over, the 24 hours and the stop rules', () => {
  const s = section('whatsapp-conversations');
  assert.ok(s, 'the section is missing');
  const en = body(s, 'en');
  const ar = body(s, 'ar');
  assert.ok(aiParagraph('en') && aiParagraph('ar'), 'the AI assistant paragraph in both languages');
  assert.equal(s.body.en.indexOf(aiParagraph('en')), s.body.en.length - 1, 'it closes the section');
  assert.match(en, /answers messages to our WhatsApp number at any hour/);
  assert.match(en, /It is an AI system, not a person\. Its first message identifies it as an AI assistant/);
  assert.match(en, /our earlier replies in it and what we hold about your enquiry \(such as your name, interest, budget and district\) are sent to OpenAI, the AI provider that produces the assistant’s replies, which processes them outside Saudi Arabia/);
  assert.match(en, /only prices published on this site/);
  assert.match(en, /when you ask to speak to a person, make an offer or ask for something it cannot do; until a team member writes, it can still answer questions about our published homes/);
  assert.match(en, /It does not answer in a chat for 24 hours after a member of our team last wrote in it/);
  assert.match(en, /If you ask it to stop, or ask about your data or for it to be deleted, a person takes over and it stops answering in your chat/);
  assert.match(en, /deleted from our records/);
  assert.doesNotMatch(en, /ask to view a home/, 'a viewing is booked now, not handed over');
  assert.match(ar, /على الرسائل الواردة إلى رقم واتساب بونا في أي وقت/);
  assert.match(ar, /في أول رسالة منها أنها مساعدة تعمل بالذكاء الاصطناعي/);
  assert.match(ar, /وردودنا السابقة فيها وما لدينا عن استفسارك \(كاسمك واهتمامك وميزانيتك والحي\) إلى OpenAI، مزوّد الذكاء الاصطناعي الذي يُعدّ ردود المساعدة، ويعالجها خارج المملكة/);
  assert.match(ar, /الأسعار المنشورة في هذا الموقع/);
  assert.match(ar, /أو طلبت ما لا يمكنها القيام به؛ وإلى أن يكتب أحد أعضاء الفريق، يمكنها أن تواصل الإجابة عن أسئلتك حول منازلنا المنشورة/);
  assert.match(ar, /ولا تردّ في محادثةٍ خلال الساعات الأربع والعشرين التي تلي آخر رسالة كتبها فيها أحد أعضاء فريقنا/);
  assert.match(ar, /تولّى أمرك أحد أعضاء فريقنا وتوقفت المساعدة الذكية عن الرد في محادثتك/);
  assert.match(ar, /لحذف تلك الرسائل من سجلاتنا/);
  assert.doesNotMatch(ar, /أو طلبت معاينة/);
  assert.doesNotMatch(en + ar, /Retell/, 'the WhatsApp replies are produced with OpenAI (D1)');
  assert.doesNotMatch(body(s, 'ar') + body(section('ai-concierge'), 'ar'), /دانا/, 'no other spelling of the old name either');
  const sharing = section('sharing');
  assert.match(body(sharing, 'en'), /Google for analytics and for Bona’s viewing calendar; Retell and its AI service providers for the website concierge; and OpenAI for the AI phone assistant and for our AI assistant’s WhatsApp replies\./);
  assert.match(body(sharing, 'en'), /OpenAI for the AI phone assistant/);
  assert.match(body(sharing, 'ar'), /وGoogle للتحليلات ولتقويم معاينات بونا/);
  assert.match(body(sharing, 'ar'), /وRetell ومزوّدي خدمات الذكاء الاصطناعي لديها لمساعدة الموقع الذكية/);
  assert.match(body(sharing, 'ar'), /OpenAI للمساعدة الهاتفية بالذكاء الاصطناعي ولردود مساعدتنا الذكية عبر واتساب/);
  // The website concierge stays on Retell until D3 (PLAN T28), with no name; WhatsApp is no AI-free route.
  const concierge = section('ai-concierge');
  assert.match(body(concierge, 'en'), /Our website’s AI concierge sends your messages or voice, page context and language through Bona’s service to Retell/);
  assert.match(body(concierge, 'en'), /our AI assistant answers there too, at any hour/);
  assert.match(body(concierge, 'ar'), /وهناك تردّ مساعدة بونا الذكية أيضاً في أي وقت/);
  assert.match(body(concierge, 'en'), /The website concierge is not a person/);
  assert.match(body(concierge, 'ar'), /ومساعدة الموقع الذكية ليست شخصاً/);
  assert.doesNotMatch(body(concierge, 'en'), /Use WhatsApp instead if you do not want to use the AI concierge\./);
  assert.ok(policy.updated >= D1_RELEASED, 'the page date moves with D1');
});

test('Bona’s own number (D1): every one-to-one chat is an enquiry except the team’s and not-a-client chats; a chat with a hidden number is not stored', () => {
  const s = section('whatsapp-conversations');
  assert.equal(s.body.en.length, 4, 'own-number paragraph, the dashboard, how long, the AI assistant');
  const [en, ar] = [s.body.en[0], s.body.ar[0]];
  assert.ok(en.startsWith(`Bona’s WhatsApp number, ${site.whatsapp.display}, is Bona’s own and is used only for Bona.`), en);
  assert.ok(ar.startsWith(`رقم واتساب بونا ${site.whatsapp.display} رقمٌ خاص ببونا ولا يُستخدم إلا لأعمالها.`), ar);
  assert.match(en, /Every one-to-one chat with it is treated as an enquiry, except our team’s own chats and chats the owner of Bona has marked as not a Bona client, and Bona stores that conversation/);
  assert.match(ar, /وتُعامَل كل محادثة فردية معه بوصفها استفساراً، عدا محادثات أعضاء فريقنا والمحادثات التي حدّد مالك بونا أنها لا تخص عميلاً لبونا/);
  assert.match(en, /Group chats, broadcast lists, channels and status updates are not stored\./);
  assert.match(ar, /ولا نحتفظ بمحادثات المجموعات ولا بقوائم البث ولا بالقنوات ولا بالحالات\./);
  assert.match(en, /If WhatsApp does not show us the phone number a chat comes from, that conversation is not stored and our AI assistant does not answer it/);
  assert.match(en, /until 30 days after the last one, so that the owner of Bona can answer it himself; if he marks it as not a Bona client, only those ids are kept, for up to a year/);
  assert.match(ar, /وإذا لم يُظهر لنا واتساب رقم الهاتف الذي تصدر منه محادثةٌ ما، فلا نحتفظ بتلك المحادثة ولا تردّ عليها مساعدة بونا الذكية/);
  assert.match(ar, /حتى ثلاثين يوماً من آخر رسالة فيها، ليردّ عليها مالك بونا بنفسه؛ وإذا حدّد أنها لا تخص عميلاً لبونا، لا نحتفظ إلا بتلك المعرّفات، مدةً أقصاها سنة/);
  // The property-word exception belongs to the shared rule: it left the page and waits in the rollback text.
  // Decision (review of PR #87, round 1): Bona's own number keeps no property-word record at all, not even
  // while `#dana live off` (own_inbox '0') brings the shared rule's joins back. While the instance is
  // verified as Bona's own number (ownNumberOk), the poller stores no inbox_candidates row for a chat with a
  // phone and deletes the ones already there (PLAN T06, T07; DESIGN §3.1). Such rows exist only on the
  // personal number, whose page is the rollback text (PR-D1r), so this paragraph needs no copy here.
  assert.ok(!s.body.en.some((p) => p.startsWith('There is one narrow exception')), 'en: the exception is gone');
  assert.ok(!s.body.ar.some((p) => p.startsWith('وهناك استثناء محدود')), 'ar: the exception is gone');
  assert.doesNotMatch(body(s, 'en'), /the next paragraph describes the one narrow exception/);
  assert.doesNotMatch(body(s, 'ar'), /باستثناء محدود نبيّنه في الفقرة التالية/);
});

test('viewing-bookings comes right after the AI phone assistant: what is booked, from which calendar, and no reminders (D1)', () => {
  const ids = policy.sections.map((x) => x.id);
  assert.equal(ids.indexOf('viewing-bookings'), ids.indexOf('ai-phone-line') + 1);
  const s = section('viewing-bookings');
  assert.equal(s.heading.en, 'Viewings booked by our AI assistant');
  assert.equal(s.heading.ar, 'المعاينات التي تحجزها مساعدتنا الذكية');
  const en = body(s, 'en');
  const ar = body(s, 'ar');
  assert.match(en, /our AI assistant can book a viewing of one of our homes in Jeddah for you/);
  assert.match(en, /Sunday to Thursday between 10:00 and 19:00 Saudi time, from the next day onwards, books a one-hour viewing/);
  assert.match(en, /or a member of our team sends you the meeting point before the viewing/);
  assert.match(en, /It does not send reminders\./);
  assert.doesNotMatch(en, /date, time and place/, 'most homes have no exact meeting point on file');
  assert.match(ar, /موعد معاينة لأحد منازلنا في جدة/);
  assert.match(ar, /أو يرسل إليك أحد أعضاء فريقنا نقطة اللقاء قبل الموعد/);
  assert.match(ar, /ولا ترسل تذكيرات\./);
  // The calendar sentence: whose calendar, who provides it, what an entry holds, no invitation, deletion.
  assert.match(en, /Bona’s viewing calendar is a Google Calendar of the owner of Bona, provided by Google, which may process it outside Saudi Arabia under its own terms\. A booking puts in it the time of the viewing, the home, your name and phone number, and a link to your enquiry in our private dashboard; it sends no invitation to you or to anyone else\./);
  assert.match(en, /A request to delete your enquiry covers its calendar entries too\./);
  assert.match(ar, /وتقويم معاينات بونا تقويمٌ في Google لمالك بونا، تقدّمه Google وقد تعالجه خارج المملكة وفق شروطها\./);
  // The Arabic is the authoritative text, so it lists the same entry contents as the English, word for word.
  assert.match(ar, /ويُدرج الحجز فيه وقت المعاينة والعقار واسمك ورقم هاتفك ورابطاً لاستفسارك في لوحتنا الخاصة، ولا يُرسل أي دعوة إليك أو إلى غيرك\./);
  assert.match(ar, /ويشمل طلب حذف استفسارك حذف مواعيده من التقويم أيضاً\./);
});

test('the owner notes (D1): what a note carries, the quote only with a hand-over, and where the notes stay', () => {
  const s = section('data-we-hold');
  assert.equal(s.body.en.length, 4);
  const [en, ar] = [s.body.en[3], s.body.ar[3]];
  assert.match(en, /a short WhatsApp note with the client’s name and phone number, what they are looking for, their first message and a link to the enquiry in our private dashboard/);
  assert.match(en, /whenever our AI assistant passes a conversation to the team \(with a short quote of your latest message\), books a viewing or stops answering in a chat, and one summary a day of new enquiries, viewings and conversations waiting for a reply/);
  assert.equal(en.match(/quote/g)?.length, 1, 'only the hand-over note quotes the client (DESIGN §7.2)');
  assert.match(en, /These notes stay in WhatsApp on his phone and on the WhatsApp gateway server Bona runs; a request to delete your enquiry covers them too\./);
  assert.match(ar, /كلما أحالت مساعدتنا الذكية محادثةً إلى الفريق \(وفيها مقتطف قصير من آخر رسالة منك\)، أو حجزت موعد معاينة، أو توقفت عن الرد في محادثة/);
  assert.equal(ar.match(/مقتطف/g)?.length, 1);
  assert.match(ar, /ويشمل طلب حذف استفسارك حذفها أيضاً\./);
});

test('the rest of D1: who we are, legal basis, retention, transfers, your rights and the contact block', () => {
  assert.ok(section('who-we-are').body.en[1].includes(`Reach us on WhatsApp at ${site.whatsapp.display}, where Bona’s AI assistant answers at any hour and our team replies Sunday to Thursday, 10:00 to 19:00.`));
  assert.ok(section('who-we-are').body.ar[1].includes(`على الرقم ${site.whatsapp.display}، حيث تردّ مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، في أي وقت`));
  const legal = section('legal-basis');
  assert.match(legal.body.en[2], /they make no decision about you with legal or similarly significant effects: a member of our team decides anything that matters, and you can ask for a person at any time\./);
  assert.match(legal.body.ar[2], /لكنها لا تتخذ بشأنك أي قرار تترتب عليه آثار نظامية أو آثار مماثلة في أهميتها/);
  const retention = section('retention');
  assert.match(retention.body.en[2], /A viewing booked by our AI assistant stays in Bona’s viewing calendar as the record of that viewing, and is deleted with your enquiry if you ask us to delete it\./);
  assert.match(retention.body.ar[2], /يبقى موعد المعاينة الذي تحجزه مساعدتنا الذكية في تقويم معاينات بونا بوصفه سجلاً لتلك المعاينة/);
  assert.match(body(section('international-transfers'), 'en'), /Bona’s hosting, messaging, calendar, analytics, advertising-measurement, tour and AI providers may process data outside Saudi Arabia\./);
  assert.match(body(section('international-transfers'), 'ar'), /قد يعالج مزوّدو الاستضافة والمراسلة والتقويم والتحليلات/);
  const rights = section('your-rights');
  assert.equal(rights.body.en.length, 4);
  assert.match(rights.body.en[1], /A request about your data is always handled by a person, not by our AI assistant\./);
  assert.match(rights.body.ar[1], /ويتولى أي طلب يتعلق ببياناتك شخصٌ من فريقنا دائماً، لا المساعدة الذكية\./);
  assert.match(rights.body.en[2], /If you would rather receive no automatic replies, say so in the chat and we will switch the automatic replies off for your chat\./);
  assert.match(rights.body.ar[2], /وإن كنت تفضّل ألّا تصلك ردود آلية، فأخبرنا بذلك في المحادثة وسنوقف الردود الآلية في محادثتك\./);
  assert.match(rights.body.en[3], /Saudi Data & AI Authority \(SDAIA\)/);
  assert.match(rights.body.ar[3], /\(سدايا\)/);
  assert.ok(policy.contact.en.includes(`WhatsApp ${site.whatsapp.display} — Bona’s AI assistant answers at any hour, and our team replies Sunday to Thursday, 10:00–19:00; a request about your data is always handled by a person.`), policy.contact.en);
  assert.ok(policy.contact.ar.includes(`واتساب ${site.whatsapp.display} — تردّ مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، في أي وقت`), policy.contact.ar);
  assert.match(policy.contact.ar, /ويتولى أي طلب يتعلق ببياناتك شخصٌ من فريقنا دائماً/);
});

// The 26 November line stays word for word until its 30 days are up (2026-12-26); it is pinned by its
// SHA-256, because it names the number it replaced and no new copy of that number is written here.
// The D1 line is dated D1_RELEASED, the day D1 merges, so its 30 days run from that date.
const NOV26_SHA256 = {
  en: '6c826d4ba29bc06bb8f2bacf18fe31b4182cf6e1f321bb545ad4a9108b9f67c0',
  ar: '3f82c03dc52eebb3405005a319892310da090f1e77a6f451a0456b38ee726faa',
};
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const isNov26 = (locale, text) => sha256(text) === NOV26_SHA256[locale];
const D1_LINE = {
  en: /^(\d{1,2}) (\S+) (\d{4}): Bona’s AI assistant now answers every enquiry chat on Bona’s WhatsApp number at any hour;/,
  ar: /^(\d{1,2}) (\S+) (\d{4}): أصبحت مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، تردّ على كل محادثة استفسار على رقم واتساب بونا في أي وقت،/,
};
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
};
const isoOf = (m, locale) => {
  const month = MONTHS[locale].indexOf(m[2]) + 1;
  assert.ok(month > 0, `${locale}: ${m[2]} is no month name`);
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
/** “4 December 2026” / “4 ديسمبر 2026” for 2026-12-04: how a Changes line writes its date. */
const writtenDate = (iso, locale) => `${Number(iso.slice(8, 10))} ${MONTHS[locale][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * The D1 Changes line of policy `p`, checked as of the day `on`. Its 30 days run from D1_RELEASED, not
 * from whatever the text says: until they are up the line must be there in both languages, dated
 * D1_RELEASED, and a rewrite its pattern no longer finds counts as a missing line. Once they are up it
 * may come out (`undefined`).
 */
function checkD1Line(p, on) {
  const changes = p.sections.find((x) => x.id === 'changes');
  const en = changes.body.en.find((x) => D1_LINE.en.test(x));
  const ar = changes.body.ar.find((x) => D1_LINE.ar.test(x));
  const until = plusDays(D1_RELEASED, 30);
  if (on >= until && !en && !ar) return undefined;
  assert.ok(en && ar, `the D1 line in each language (due until ${until})`);
  assert.equal(isoOf(en.match(D1_LINE.en), 'en'), D1_RELEASED, 'en: the D1 line carries the D1 date (D1_RELEASED)');
  assert.equal(isoOf(ar.match(D1_LINE.ar), 'ar'), D1_RELEASED, 'ar: the D1 line carries the D1 date (D1_RELEASED)');
  assert.ok(p.updated >= D1_RELEASED, 'the version date at the top moved with it');
  return { en, ar };
}

test('the D1 Changes line stays its 30 days from D1_RELEASED, whatever day D1 merges (the check itself)', () => {
  const edit = (fn) => {
    const p = structuredClone(policy);
    const changes = p.sections.find((x) => x.id === 'changes');
    for (const locale of ['en', 'ar']) changes.body[locale] = fn(changes.body[locale], locale);
    return p;
  };
  const lastDay = plusDays(D1_RELEASED, 29);
  assert.equal(plusDays('2026-12-04', 30), '2027-01-03');
  assert.equal(writtenDate('2026-12-04', 'en'), '4 December 2026');
  assert.equal(writtenDate('2026-12-04', 'ar'), '4 ديسمبر 2026');
  assert.ok(checkD1Line(policy, lastDay), 'the page as it is passes on its last day');
  // Both lines removed a day early: red, even past the old fixed cutoff of 27 December.
  const removed = edit((paras, locale) => paras.filter((x) => !D1_LINE[locale].test(x)));
  assert.throws(() => checkD1Line(removed, lastDay), /the D1 line in each language/);
  assert.equal(checkD1Line(removed, plusDays(D1_RELEASED, 30)), undefined, 'gone once its 30 days are up');
  // A rewrite of both opening sentences is a missing line, not a pass.
  const rewritten = edit((paras, locale) => paras.map((x) => (D1_LINE[locale].test(x)
    ? x.replace(locale === 'en' ? 'now answers every enquiry chat' : 'تردّ على كل محادثة استفسار', locale === 'en' ? 'answers' : 'تردّ')
    : x)));
  assert.throws(() => checkD1Line(rewritten, lastDay), /the D1 line in each language/);
  // A line dated another day than D1_RELEASED (the date moved without the constant, or the reverse).
  const later = plusDays(D1_RELEASED, 7);
  const moved = edit((paras, locale) => paras.map((x) => (D1_LINE[locale].test(x)
    ? x.replace(writtenDate(D1_RELEASED, locale), writtenDate(later, locale))
    : x)));
  assert.throws(() => checkD1Line(moved, lastDay), /carries the D1 date/);
});

test('Changes (D1): the September and October lines are gone, the 26 November line stays word for word, and the D1 line says what changed, in both languages (30 days)', () => {
  const changes = section('changes');
  for (const start of ['30 September 2026:', '1 October 2026:']) assert.ok(!changes.body.en.some((p) => p.startsWith(start)), `en still has a ${start} line`);
  for (const start of ['30 سبتمبر 2026:', '1 أكتوبر 2026:']) assert.ok(!changes.body.ar.some((p) => p.startsWith(start)), `ar still has a ${start} line`);
  const nov26 = today() < '2026-12-26';
  if (nov26) for (const locale of ['en', 'ar']) assert.equal(changes.body[locale].filter((p) => isNov26(locale, p)).length, 1, `${locale}: the 26 November line, word for word`);
  const d1 = checkD1Line(policy, today());
  if (!d1) return;
  const { en, ar } = d1;
  if (nov26) for (const [locale, line] of [['en', en], ['ar', ar]]) {
    assert.equal(changes.body[locale].indexOf(line), changes.body[locale].findIndex((p) => isNov26(locale, p)) + 1, `${locale}: right after the 26 November line`);
  }
  assert.match(en, /its replies are now produced with OpenAI instead of Retell, and it no longer uses a personal name\./);
  assert.match(en, /We rewrote “WhatsApp conversations with our team” for Bona’s own number, added “Viewings booked by our AI assistant” \(it can book a viewing into Bona’s viewing calendar, a Google Calendar\), and added to “The data we hold, and why” the WhatsApp notes the owner of Bona receives about new enquiries, hand-overs and bookings\./);
  assert.match(ar, /وصارت ردودها تُعدّ باستخدام OpenAI بدلاً من Retell، ولم تعد تحمل اسماً شخصياً\./);
  assert.match(ar, /وأعدنا كتابة قسم «محادثات واتساب مع فريق بونا» ليناسب رقم بونا الخاص، وأضفنا قسم «المعاينات التي تحجزها مساعدتنا الذكية»/);
  assert.match(ar, /ملاحظات واتساب التي تصل مالكَ بونا عن الاستفسارات الجديدة والإحالات والحجوزات\./);
});

// The AI providers the brain may call (services/api/lib/brain/providers.mjs, PR-BR) are pinned, and
// each one is named on the page before the code may call it: adding a provider is a privacy release
// first (brain/DESIGN-brain §2.1, §11.3). Until PR-BR creates lib/brain/, the list is the pinned one of
// the design. Once that directory exists, providers.mjs must be in it and export PROVIDERS as the
// design pins it, an array of provider ids such as ['openai']: a moved or renamed module, or another
// shape, fails here rather than letting the check fall back to the pinned list for good.
const PROVIDER_NAMES = Object.freeze({ openai: 'OpenAI' });
const BRAIN_DIR = new URL('../../services/api/lib/brain/', import.meta.url);
/** PROVIDERS as DESIGN-brain §2.1 pins it: a non-empty array of lower-case provider ids. */
function providerIds(list) {
  assert.ok(Array.isArray(list) && list.length > 0, `PROVIDERS is a non-empty array of provider ids, not ${JSON.stringify(list)}`);
  for (const id of list) assert.ok(typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id), `PROVIDERS entry ${JSON.stringify(id)} is no provider id`);
  return [...list];
}
async function brainProviders(dir = BRAIN_DIR) {
  if (!fs.existsSync(dir)) return ['openai'];
  const file = new URL('providers.mjs', dir);
  assert.ok(fs.existsSync(file), `providers.mjs not found in ${fileURLToPath(dir)}: the provider cross-check reads PROVIDERS from it`);
  const { PROVIDERS } = await import(file.href);
  return providerIds(PROVIDERS);
}

test('the provider cross-check reads PROVIDERS as the design pins it, and fails closed once lib/brain/ exists (the check itself)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-providers-'));
  try {
    let n = 0;
    /** A lib/brain/ of its own for each case: an imported module is cached by its URL. */
    const brainWith = (source) => {
      const dir = path.join(tmp, `brain-${n += 1}`);
      fs.mkdirSync(dir);
      if (source !== null) fs.writeFileSync(path.join(dir, 'providers.mjs'), source);
      return pathToFileURL(`${dir}/`);
    };
    assert.deepEqual(await brainProviders(pathToFileURL(`${tmp}/absent/`)), ['openai'], 'no lib/brain/ yet: the pinned list');
    await assert.rejects(brainProviders(brainWith(null)), /providers\.mjs not found/, 'lib/brain/ without providers.mjs');
    assert.deepEqual(await brainProviders(brainWith("export const PROVIDERS = Object.freeze(['openai']);\n")), ['openai']);
    for (const bad of ["{ openai: 'anthropic' }", "[{ id: 'openai' }]", "['OpenAI']", '[]', "'openai'"]) {
      await assert.rejects(brainProviders(brainWith(`export const PROVIDERS = ${bad};\n`)), /PROVIDERS/, bad);
    }
    await assert.rejects(brainProviders(brainWith('export const OTHER = 1;\n')), /PROVIDERS is a non-empty array/, 'no PROVIDERS export');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every AI provider the assistant may call is named where the page says who gets the chat; no other AI vendor is named; Retell only where it still runs (D1)', async () => {
  const providers = await brainProviders();
  assert.ok(providers.length > 0, 'the brain names at least one provider');
  for (const id of providers) {
    const name = Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id] : undefined;
    assert.ok(name, `${id}: name this provider on the privacy page (WhatsApp paragraph and sharing, EN and AR) before the code may call it`);
    for (const locale of ['en', 'ar']) {
      assert.ok(aiParagraph(locale)?.includes(name), `${locale}: the WhatsApp paragraph names ${name}`);
      assert.ok(providersParagraph(locale)?.includes(name), `${locale}: sharing names ${name}`);
    }
  }
  const all = JSON.stringify(policy) + JSON.stringify(faq);
  for (const re of [/deepseek/i, /\bxAI\b/i, /\bgrok\b/i, /\banthropic\b/i]) assert.doesNotMatch(all, re);
  // Retell: the website concierge (until D3, PLAN T28), its sharing clause, and the history in Changes.
  for (const s of policy.sections) {
    if (!['ai-concierge', 'sharing', 'changes'].includes(s.id)) assert.doesNotMatch(JSON.stringify(s), /Retell/, `${s.id} names Retell`);
  }
  for (const locale of ['en', 'ar']) {
    const sharing = section('sharing').body[locale].filter((p) => p.includes('Retell'));
    assert.deepEqual(sharing, [providersParagraph(locale)], `${locale}: sharing names Retell in the providers paragraph only`);
    // Once, and in its concierge clause: a second Retell claim added to the same paragraph fails too.
    assert.equal(body(section('sharing'), locale).match(/Retell/g)?.length, 1, `${locale}: sharing names Retell once`);
    assert.ok(providersParagraph(locale).includes(locale === 'en'
      ? 'Retell and its AI service providers for the website concierge;'
      : 'وRetell ومزوّدي خدمات الذكاء الاصطناعي لديها لمساعدة الموقع الذكية،'), `${locale}: Retell, for the website concierge`);
  }
  assert.doesNotMatch(policy.contact.en + policy.contact.ar + JSON.stringify(faq), /Retell/);
});

test('no personal name (D1): Bona’s AI assistant is nameless on the privacy page, in the FAQ, in the concierge strings and in site.json', async () => {
  /** Every string in a JSON value, with where it sits: [['sections[3].body.en[0]', '…'], …]. */
  const stringsOf = (x, where = '') => typeof x === 'string' ? [[where, x]]
    : Array.isArray(x) ? x.flatMap((v, i) => stringsOf(v, `${where}[${i}]`))
    : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => stringsOf(v, where ? `${where}.${k}` : k))
    : [];
  // The one exception is history: the 26 November Changes line, verbatim until 2026-12-26.
  for (const [where, text] of stringsOf(policy).filter(([, x]) => named(x))) {
    assert.ok(isNov26('en', text) || isNov26('ar', text), `privacy.json ${where} names the assistant: ${text.slice(0, 120)}`);
  }
  for (const [file, data] of [['faq.json', faq], ['site.json', site]]) {
    assert.deepEqual(stringsOf(data).filter(([, x]) => named(x)).map(([where]) => where), [], `${file} names the assistant`);
  }
  assert.deepEqual(site.concierge.name, { en: 'Bona’s AI assistant', ar: 'مساعدة بونا الذكية' }, 'the panel label (Concierge.astro falls back to the old name without it)');
  const { ui } = await import('../../src/lib/i18n.ts');
  const concierge = Object.entries(ui).filter(([k]) => k.startsWith('concierge'));
  assert.ok(concierge.length >= 40, 'the concierge strings');
  for (const [k, v] of concierge) assert.ok(!named(v.en) && !named(v.ar), `ui.${k} names the assistant: ${v.en} / ${v.ar}`);
  // The matcher itself: whole words, with the Arabic prefixes, and not a listing that contains the letters.
  for (const yes of ['Dana', 'dana.', 'دانة', 'ودانة', 'مع دانة', 'دانا']) assert.ok(named(yes), yes);
  for (const no of ['Sadana Townhouse', 'سدانة', 'ميدانا']) assert.ok(!named(no), no);
});

test('the personal-number rollback page (PR-D1r) needs no D1 revert: the old shared-rule paragraphs plus D1’s others name OpenAI, and neither Retell nor a name', async () => {
  assert.equal(rollback.section, 'whatsapp-conversations');
  const page = structuredClone(policy);
  const s = page.sections.find((x) => x.id === rollback.section);
  for (const locale of ['en', 'ar']) {
    assert.equal(rollback.body[locale].length, 2, `${locale}: the old first paragraph and the property-word exception`);
    s.body[locale] = [...rollback.body[locale], ...s.body[locale].slice(1)];
  }
  const providers = await brainProviders();
  for (const locale of ['en', 'ar']) {
    const text = body(s, locale);
    for (const id of providers) assert.ok(text.includes(PROVIDER_NAMES[id]), `${locale}: the rollback page names ${PROVIDER_NAMES[id]}`);
    assert.doesNotMatch(text, /Retell/, `${locale}: the rollback page names Retell`);
    assert.ok(!named(text), `${locale}: the rollback page names the assistant`);
  }
  // Its pointers still lead to real headings, the same ones in both languages.
  checkPointers(page);
});

test('the FAQ (D1): 14 questions or more; a viewing is booked on WhatsApp for homes in Jeddah; who answers there; how to reach a person', () => {
  assert.ok(faq.items.length >= 14, `${faq.items.length} questions`);
  assert.ok(faq.updated >= D1_RELEASED, 'the FAQ date moves with D1');
  const item = (id) => faq.items.find((x) => x.id === id);
  for (const id of ['contact', 'viewing', 'whatsapp-assistant', 'speak-to-a-person']) {
    assert.ok(item(id), id);
    assert.equal(item(id).a.en.length, item(id).a.ar.length, `${id}: the Arabic says what the English does`);
  }
  const contact = item('contact');
  assert.match(contact.a.en[0], /Bona’s AI assistant answers there at any hour, in Arabic or English, and says that it is an AI; our team replies Sunday to Thursday, 10:00 to 19:00 Saudi time/);
  assert.match(contact.a.ar[0], /تردّ عليك هناك مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، في أي وقت/);
  assert.equal(contact.a.en[2], 'Send the listing reference with your message and you will get a straight answer about that home.');
  assert.equal(contact.a.ar[2], 'أرسل رقم العقار مع رسالتك لتحصل على إجابة مباشرة عن ذلك المنزل.');
  const viewing = item('viewing');
  assert.deepEqual(viewing.q, { en: 'How do I book a viewing with Bona?', ar: 'كيف أحجز معاينة مع بونا؟' });
  assert.match(viewing.a.en[0], /For our homes in Jeddah, our AI assistant offers you the free times — Sunday to Thursday, 10:00 to 19:00, from the next day onwards — books the one you choose as a one-hour viewing and confirms it in the chat; for our homes elsewhere, a member of our team arranges it with you\./);
  assert.match(viewing.a.ar[0], /ولمنازلنا في جدة تعرض عليك مساعدتنا الذكية/);
  assert.match(viewing.a.en[1], /If the home’s owner needs another time, or the home is no longer available, we tell you in the same chat/);
  const assistant = item('whatsapp-assistant');
  assert.deepEqual(assistant.q, { en: 'Who answers when I write to Bona on WhatsApp?', ar: 'من يردّ عليّ عندما أراسل بونا عبر واتساب؟' });
  assert.match(assistant.a.en[0], /Usually Bona’s AI assistant, at any hour\. It is not a person, and its first message says so\./);
  assert.match(assistant.a.en[1], /when one of us writes in it, the assistant steps back for 24 hours/);
  assert.match(assistant.a.ar[1], /توقفت المساعدة الذكية عن الرد مدة أربع وعشرين ساعة/);
  const person = item('speak-to-a-person');
  assert.deepEqual(person.q, { en: 'Can I speak to a person instead of the AI assistant?', ar: 'هل يمكنني التحدث إلى شخص بدلاً من المساعدة الذكية؟' });
  assert.match(person.a.en[0], /the assistant passes the conversation to our team, who reply Sunday to Thursday, 10:00 to 19:00; until then it can still answer questions about our published homes/);
  assert.match(person.a.en[0], /If you would rather receive no automatic replies at all, say so and we will switch them off for your chat\./);
  assert.match(person.a.ar[0], /وإن كنت تفضّل ألّا تصلك ردود آلية أصلاً، فأخبرنا بذلك وسنوقفها لمحادثتك\./);
  // The Arabic FAQ keeps the left-to-right mark in front of every +966 number.
  for (const it of faq.items) for (const p of it.a.ar) for (const m of p.matchAll(/(.)\+966/gu)) assert.equal(m[1], '‎', `${it.id}: +966 without U+200E`);
});

test('the site copy around the assistant (D1): nameless, it answers at any hour, the cookie link lands on a real section', async () => {
  const { ui } = await import('../../src/lib/i18n.ts');
  const EXPECT = {
    contactBandText: ['WhatsApp is the fastest way to reach us. Bona’s AI assistant answers at any hour, and a principal follows up personally.', 'واتساب أسرع طريقة للوصول إلينا. تردّ مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، في أي وقت، ويتابع معك أحد شركاء الدار بنفسه.'],
    enquiryPanelText: ['One message: Bona’s AI assistant answers straight away, and a principal follows up personally.', 'رسالة واحدة: تردّ مساعدة بونا الذكية، التي تعمل بالذكاء الاصطناعي، فوراً، ويتابع معك أحد شركاء الدار بنفسه.'],
    privacyMetaDesc: ['How Bona handles the personal information you share with us, on this site, on WhatsApp and by phone.', 'كيف تتعامل بونا مع المعلومات الشخصية التي تشاركها معنا، على هذا الموقع وعبر واتساب والهاتف.'],
    conciergeOfflineText: ['The concierge is not reachable at the moment. Write to us on WhatsApp; ask for a person there and one of us will reply.', 'الكونسيرج غير متاح في هذه اللحظة. راسلنا عبر واتساب، واطلب التحدث إلى شخص ليردّ عليك أحدنا.'],
    conciergeConversation: ['Conversation with Bona’s AI assistant', 'المحادثة مع مساعدة بونا الذكية'],
    conciergeTyping: ['Bona’s assistant is typing', 'مساعدة بونا تكتب'],
    conciergeInputLabel: ['Write to Bona’s assistant', 'اكتب إلى مساعدة بونا'],
    conciergeOfflineTitle: ['Bona’s assistant is resting', 'مساعدة بونا في استراحة'],
    conciergeAskDana: ['Ask the AI assistant', 'اسأل المساعدة الذكية'],
    conciergeAskAboutHome: ['Ask the AI assistant about this home', 'اسأل المساعدة الذكية عن هذا المنزل'],
    conciergeCallLive: ['Bona’s assistant is listening', 'مساعدة بونا تستمع إليك'],
    conciergeCallSpeaking: ['Bona’s assistant is speaking', 'مساعدة بونا تتحدّث'],
    conciergeAiNote: ['This is Bona’s AI assistant, an AI concierge. Conversations may be recorded and transcribed for quality.', 'مساعدة بونا الذكية تعمل بالذكاء الاصطناعي. قد تُسجَّل المحادثات وتُفرَّغ نصياً لأغراض الجودة.'],
  };
  for (const [k, [en, ar]] of Object.entries(EXPECT)) assert.deepEqual(ui[k], { en, ar }, `ui.${k}`);
  // The consent banner's privacy link opens the section that describes the site's own records.
  const consent = fs.readFileSync(new URL('../../src/components/Consent.astro', import.meta.url), 'utf8');
  const anchor = consent.match(/localePath\(locale, '\/privacy\/'\)\}#([\w-]+)`/)?.[1];
  assert.equal(anchor, 'what-this-site-collects');
  assert.ok(section(anchor), `#${anchor} is a section of the policy`);
  const meta = read('../../marketing/page-meta.json')['/privacy/'].description;
  assert.equal(meta.en, 'How Bona handles your personal data under the Saudi PDPL: what this site collects, WhatsApp enquiries and AI replies, viewing bookings, retention, sharing and your rights.');
  assert.equal(meta.ar, 'كيف تتعامل بونا مع بياناتك الشخصية وفق نظام حماية البيانات الشخصية السعودي: ما يجمعه الموقع، واستفسارات واتساب والردود الآلية، وحجز المعاينات، والاحتفاظ، والمشاركة، وحقوقك.');
});

// The shared rule (the owner's personal number) keeps a short record of chats that use a property
// word. Bona's own number does not (D1; and, by the round-1 decision above, not while own_inbox is off
// either), so that text left the page; it waits, word for word, in the rollback json (DESIGN §13.2,
// PR-D1r), and these asserts pin it there.
// The rollback paragraphs are the section's first two as published before D1 (13e4954), byte for byte:
// any edit, such as another lookback than 30 days, is a new privacy text and fails here first. Pinned by
// SHA-256 like the 26 November line, so this file holds no second copy of them.
const SHARED_NUMBER_SHA256 = {
  en: ['0b2f4130a36840b08af4c3c01b09a39ca308f37812aad7dd54bbdee1cbfe97f5', 'ed761efe51b8c1f0a28c72a8b008348f17b42251e984ac5634563dfbf4a21d15'],
  ar: ['1ccfe08448445ba4e01c945217e4ae9eeeaa52adc1379c816c3677d382cb49a1', '29d857e9a58e5ef02b5f4fcca7b0a4de6d513fc120746d0d4803c94b3b657411'],
};
test('the shared-number text (rollback) is the text published before D1, word for word, in both languages', () => {
  for (const locale of ['en', 'ar']) {
    assert.deepEqual(rollback.body[locale].map(sha256), SHARED_NUMBER_SHA256[locale], `${locale}: whatsapp-conversations [0] and [1] as of 13e4954`);
  }
  assert.match(rollback.body.en[0], /up to 30 days before it became an enquiry/);
  assert.match(rollback.body.ar[0], /خلال مدة أقصاها ثلاثون يوماً قبل أن تصبح استفساراً/);
});

test('the shared-number text (rollback) names the chats kept only to be checked: what is kept, for how long, and that the conversation is not (D17)', () => {
  const s = rollback;
  assert.ok(s?.body, 'the rollback text is missing');
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
  assert.match(en, /so that a principal can get back to you; a request to delete a call covers that note too\./);
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
