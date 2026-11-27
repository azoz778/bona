/**
 * Who the assistant is to a client (brain/DESIGN-brain.md §6.3-6.4, DESIGN §4.1): no name.
 * Clients see "Bona's AI assistant" / «مساعدة بونا الذكية»; the first message in each chat says
 * «مساعدة بونا بالذكاء الاصطناعي», because "الذكية" alone only means "smart" and the disclosure
 * must say AI explicitly. Every client string that names the assistant is derived here, so
 * "keep Dana" is one line: set ASSISTANT_NAME to { en: 'Dana', ar: 'دانة' } (plus the v1 privacy
 * wording and site.json concierge.name), which gives back today's "Dana — Bona's AI assistant".
 *
 * Internal "dana" names (settings, columns, `sender_kind 'dana'`, `#dana` commands, journal
 * events) are not client text and stay. Nothing here reads a setting, a file or the network.
 */
import { createHash } from 'node:crypto';

/** `null` = nameless. Keep Dana → `{ en: 'Dana', ar: 'دانة' }`. */
export const ASSISTANT_NAME = null;

/** The disclosure label: says AI explicitly in both languages. */
export const LABEL = Object.freeze({ en: "Bona's AI assistant", ar: 'مساعدة بونا بالذكاء الاصطناعي' });
/** The everyday label (prompt, site copy, greeting): «مساعدة بونا الذكية». */
export const SHORT_LABEL = Object.freeze({ en: "Bona's AI assistant", ar: 'مساعدة بونا الذكية' });

const lang = (l) => (l === 'en' ? 'en' : 'ar');
const nameOf = (o) => (o && Object.hasOwn(o, 'name') ? o.name : ASSISTANT_NAME);

/** The first-message disclosure, variant 0: the label, or "<name> — <label>" with a name. */
export function disclosure(language, opts) {
  const l = lang(language);
  const name = nameOf(opts);
  return name ? `${name[l]} — ${LABEL[l]}` : LABEL[l];
}
export const DISCLOSURE = Object.freeze({ en: disclosure('en'), ar: disclosure('ar') });

/** Four forms of the disclosure line (variant 0 first); each Arabic one says «بالذكاء الاصطناعي». */
export function disclosureVariants(language, opts) {
  const l = lang(language);
  const base = disclosure(l, opts);
  return l === 'en'
    ? [base, `This is ${base}`, `Hello, this is ${base}`, `Hi, ${base} here`]
    : [base, `معك ${base}`, `مرحباً، معك ${base}`, `أهلاً، معك ${base}`];
}

/** The hand-over line inside office hours; variant 0 is today's dana-wa.mjs constant. */
export const HANDOVER = Object.freeze({
  en: 'Thank you — a member of the Bona team will reply to you shortly.',
  ar: 'شكراً لك، أحد أعضاء فريق بونا بيرد عليك قريباً.',
});
export const HANDOVER_VARIANTS = Object.freeze({
  en: Object.freeze([
    HANDOVER.en,
    'Thanks — your message is with the Bona team, and they will reply shortly.',
    'Thank you — someone from the Bona team will get back to you shortly.',
    'Got it — a member of the Bona team will be in touch with you shortly.',
  ]),
  ar: Object.freeze([
    HANDOVER.ar,
    'شكراً لك، وصلت رسالتك لفريق بونا وبيردون عليك قريباً.',
    'تمام، أحد من فريق بونا بيتواصل معك قريباً.',
    'حاضر، أحد أعضاء فريق بونا بيرد عليك بأقرب وقت.',
  ]),
});

/** Outside office hours (DESIGN §4.1), word for word. */
export const OUT_OF_HOURS = Object.freeze({
  en: 'Your message is with the Bona team; they reply Sunday to Thursday, 10:00–19:00. If you have a question about our homes, I can help now.',
  ar: 'وصلت رسالتك لفريق بونا، ويردّون من الأحد إلى الخميس 10:00–19:00. وإذا عندك سؤال عن عقاراتنا، أقدر أساعدك الحين.',
});
/** The brain-outage line outside office hours: the same without its last sentence (the AI cannot help while it is down). */
export const OUTAGE_OUT_OF_HOURS = Object.freeze({
  en: 'Your message is with the Bona team; they reply Sunday to Thursday, 10:00–19:00.',
  ar: 'وصلت رسالتك لفريق بونا، ويردّون من الأحد إلى الخميس 10:00–19:00.',
});

/** 0-3 from a hash of the lead id: the same lead always gets the same variant. */
export function variantIndex(leadId) {
  return createHash('sha256').update(String(leadId ?? '')).digest()[0] % 4;
}
export const disclosureFor = (leadId, language, opts) => disclosureVariants(language, opts)[variantIndex(leadId)];
export const handoverFor = (leadId, language) => HANDOVER_VARIANTS[lang(language)][variantIndex(leadId)];

const RIYADH_MS = 3 * 3_600_000; // UTC+3, no daylight saving
/** Sunday to Thursday, 10:00-19:00 in Riyadh. */
export function inOfficeHours(at) {
  const d = new Date(Number(at) + RIYADH_MS);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 0 && day <= 4 && minutes >= 600 && minutes < 1140;
}

/** The hand-over line: a variant inside office hours, the out-of-hours text outside them. */
export function handoverLine({ leadId, language, at }) {
  return inOfficeHours(at) ? handoverFor(leadId, language) : OUT_OF_HOURS[lang(language)];
}
/** The brain-outage line (DESIGN-brain §4.2): HANDOVER variant 0 inside office hours, else the shortened out-of-hours text. */
export function outageLine({ language, at }) {
  return inOfficeHours(at) ? HANDOVER[lang(language)] : OUTAGE_OUT_OF_HOURS[lang(language)];
}

/** `{{identity}}` of prompts/assistant.md (DESIGN-brain §6.2); `{{channel}}` is filled by the prompt builder. */
export function identity(opts) {
  const name = nameOf(opts);
  const who = name
    ? `You are ${name.en} (${name.ar}), Bona's AI assistant (in Arabic: ${SHORT_LABEL.ar})`
    : `You are Bona's AI assistant (in Arabic: ${SHORT_LABEL.ar})`;
  const naming = name
    ? `Your name is ${name.en} (${name.ar}); never give yourself another one.`
    : 'You have no personal name; never give yourself one, never call yourself Dana or دانة.';
  return `${who}, answering clients of Bona Real Estate (بونا), a private real-estate boutique in Jeddah, on {{channel}}. ${naming} `
    + 'If asked whether you are a person: you are an AI assistant, and the Bona team can read this chat and step in.';
}

/** The code-built first line of every email reply (DESIGN-brain §6.3; T22). */
export function emailFirstLine(language, opts) {
  const l = lang(language);
  const name = nameOf(opts);
  if (l === 'en') return name ? `This reply is from ${name.en}, Bona's AI assistant.` : "This reply is from Bona's AI assistant.";
  return name ? `هذا الرد من ${name.ar}، ${LABEL.ar}.` : `هذا الرد من ${LABEL.ar}.`;
}
export const EMAIL_FIRST_LINE = Object.freeze({ en: emailFirstLine('en'), ar: emailFirstLine('ar') });

/** The website chat's greeting (index.mjs GREETING; T14). */
export function greeting(language, opts) {
  const l = lang(language);
  const name = nameOf(opts);
  if (l === 'en') return name ? `Hello, I'm ${name.en}, Bona's AI assistant.` : "Hello, I'm Bona's AI assistant.";
  return name ? `أهلاً، أنا ${name.ar}، ${SHORT_LABEL.ar}.` : `أهلاً، أنا ${SHORT_LABEL.ar}.`;
}
export const GREETING = Object.freeze({ en: greeting('en'), ar: greeting('ar') });

/** The calendar event's description line (T10). */
export function calendarLine(opts) {
  const name = nameOf(opts);
  return name ? `Booked by ${name.en}, Bona's AI assistant, on WhatsApp` : "Booked by Bona's AI assistant on WhatsApp";
}
export const CALENDAR_LINE = calendarLine();
