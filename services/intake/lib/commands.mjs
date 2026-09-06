// Caption hints (sent with the PDF) and text commands (sent afterwards).
// Everything here is pure — the unit tests own this file.

export const CURRENCIES = ['SAR', 'AED', 'EUR', 'USD', 'OMR'];

// JavaScript's \b is ASCII-only, so Arabic alternatives must live in their own patterns
// without word boundaries — "للإيجار" would never match inside a \b(...)\b group.
const CATEGORY_HINTS = [
  [/#?\b(for[- ]?rent|rent|rental)\b/i, 'rent'],
  [/(إيجار|للإيجار|للايجار|ايجار)/, 'rent'],
  [/#?\b(off[- ]?plan|under[- ]?construction)\b/i, 'off-plan'],
  [/(على ?الخارطة|تحت الإنشاء|على الخريطة)/, 'off-plan'],
  [/#?\b(international|overseas)\b/i, 'international'],
  [/(خارج المملكة|عقار دولي)/, 'international'],
  [/#?\b(for[- ]?sale|sale|buy)\b/i, 'buy'],
  [/(للبيع)/, 'buy'],
];

const PERIOD_HINTS = [
  [/\b(per|\/)\s*(year|yr|annum)\b/i, 'year'],
  [/(سنوي|سنويا|سنوياً|\/ ?سنة|في السنة)/, 'year'],
  [/\b(per|\/)\s*(month|mo)\b/i, 'month'],
  [/(شهري|شهريا|شهرياً|\/ ?شهر|في الشهر)/, 'month'],
];

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
const westernise = (s) => String(s).replace(/[٠-٩]/g, (d) => ARABIC_DIGITS[d]);

/**
 * A price the OWNER typed in the caption. Never an estimate — this only reads an
 * explicit figure. Returns null when the caption carries no number.
 */
export function parsePriceHint(caption) {
  const s = westernise(caption || '');
  // "SAR 4,500,000" | "4.5m sar" | "٤٥٠٠٠٠٠ ريال" | "price 750000"
  const re = /(?:^|[\s(])(?:(SAR|AED|EUR|USD|OMR|ر\.س|ريال)\s*)?([0-9][0-9,،.\s]*)\s*(m|mn|million|k|مليون|ألف|الف)?\s*(SAR|AED|EUR|USD|OMR|ر\.س|ريال)?/gi;
  let best = null;
  for (const m of s.matchAll(re)) {
    const rawNum = m[2].replace(/[,،\s]/g, '');
    if (!rawNum || !/^\d+(\.\d+)?$/.test(rawNum)) continue;
    let amount = Number(rawNum);
    if (!Number.isFinite(amount)) continue;
    const mult = (m[3] || '').toLowerCase();
    if (/^(m|mn|million|مليون)$/.test(mult)) amount *= 1e6;
    else if (/^(k|ألف|الف)$/.test(mult)) amount *= 1e3;
    const cur = (m[1] || m[4] || '').toUpperCase();
    const currency = cur === 'ر.س' || cur === 'ريال' ? 'SAR' : CURRENCIES.includes(cur) ? cur : null;
    // A bare number only counts as a price when it is plausibly one (>= 10,000) —
    // otherwise "3 bedrooms" would become a price.
    if (!currency && amount < 10000) continue;
    if (amount < 1000) continue;
    if (!best || amount > best.amount) best = { amount, currency: currency || 'SAR', explicitCurrency: Boolean(currency) };
  }
  return best;
}

/**
 * Parse the caption sent with the PDF.
 * @returns {{dryRun:boolean, publishBrochure:boolean, hidden:boolean, category:string|null,
 *            price:{amount:number,currency:string}|null, period:'year'|'month'|null,
 *            tags:string[], text:string}}
 *
 * `publishBrochure` (`#brochure` / `#pdf`) is a NO-OP ALIAS: every accepted brochure is
 * re-published under Bona's branding by default, so the tag only says out loud what already
 * happens. `#nobrochure` (`#nopdf`) is the flag that changes anything — it is how to publish
 * a listing with no downloadable document at all. Both together: `#nobrochure` wins.
 */
export function parseCaption(caption) {
  const text = String(caption || '').trim();
  const tags = [...text.matchAll(/#([A-Za-z0-9_-]{1,32})/g)].map((m) => m[1].toLowerCase());
  const has = (t) => tags.includes(t);
  let category = null;
  for (const [re, value] of CATEGORY_HINTS) {
    if (re.test(text)) { category = value; break; }
  }
  let period = null;
  for (const [re, value] of PERIOD_HINTS) {
    if (re.test(text)) { period = value; break; }
  }
  if (category === 'rent' && !period) period = 'year';
  if (category !== 'rent') period = null;
  const price = parsePriceHint(text);
  return {
    text,
    tags,
    dryRun: has('test') || has('dry') || has('draft'),
    // Kept for the reply/summary wording and for old captions; the pipeline does not branch
    // on it any more (see the doc comment).
    publishBrochure: has('brochure') || has('pdf'),
    noBrochure: has('nobrochure') || has('nopdf') || has('no-brochure') || has('no-pdf'),
    hidden: has('hidden') || has('private'),
    category,
    price: price ? { amount: price.amount, currency: price.currency } : null,
    period,
  };
}

// Same shape the site validator accepts (scripts/curate/rules.mjs::INTAKE_ID_RE), so a
// listing the intake can publish is always a listing the owner can then command.
export const LISTING_ID_RE = /^BONA-W\d{3,5}$/i;

/**
 * Parse a text message as a command. Returns { cmd: null } for ordinary chatter so the
 * daemon stays silent instead of replying to everything.
 * Supported: remove <id> | hero <id> <n> | price <id> <amount> [currency] | price <id> onrequest
 *            sold <id> | available <id> | hide <id> | show <id> | brochure <id>
 *            retry | help | status
 */
export function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return { cmd: null };
  const parts = raw.split(/\s+/);
  const verb = parts[0].toLowerCase().replace(/^[/!]/, '');
  const arg = (i) => parts[i] ?? '';
  const idAt = (i) => (LISTING_ID_RE.test(arg(i)) ? arg(i).toUpperCase() : null);

  switch (verb) {
    case 'help':
    case 'commands':
      return { cmd: 'help' };
    case 'status':
      return { cmd: 'status' };
    case 'retry':
      return { cmd: 'retry' };
    case 'remove':
    case 'delete':
    case 'unpublish': {
      const id = idAt(1);
      return id ? { cmd: 'remove', id } : { cmd: 'error', message: 'usage: remove BONA-W001' };
    }
    case 'hero': {
      const id = idAt(1);
      const n = Number(arg(2));
      if (!id || !Number.isInteger(n) || n < 1) return { cmd: 'error', message: 'usage: hero BONA-W001 4  (4 = the photo number to promote)' };
      return { cmd: 'hero', id, index: n };
    }
    case 'price': {
      const id = idAt(1);
      if (!id) return { cmd: 'error', message: 'usage: price BONA-W001 4500000  |  price BONA-W001 onrequest' };
      const rest = parts.slice(2).join(' ');
      if (/^\s*(on ?request|onrequest|عند الطلب)\s*$/i.test(rest)) return { cmd: 'price', id, onRequest: true };
      const p = parsePriceHint(rest);
      if (!p) return { cmd: 'error', message: 'usage: price BONA-W001 4500000  |  price BONA-W001 onrequest' };
      return { cmd: 'price', id, amount: p.amount, currency: p.currency, onRequest: false };
    }
    case 'brochure':
    case 'pdf': {
      const id = idAt(1);
      return id ? { cmd: 'brochure', id } : { cmd: 'error', message: 'usage: brochure BONA-W001' };
    }
    case 'sold':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'sold' } : { cmd: 'error', message: 'usage: sold BONA-W001' };
    case 'reserved':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'reserved' } : { cmd: 'error', message: 'usage: reserved BONA-W001' };
    case 'available':
      return idAt(1) ? { cmd: 'status-set', id: idAt(1), status: 'available' } : { cmd: 'error', message: 'usage: available BONA-W001' };
    case 'hide':
      return idAt(1) ? { cmd: 'hidden-set', id: idAt(1), hidden: true } : { cmd: 'error', message: 'usage: hide BONA-W001' };
    case 'show':
    case 'publish':
      return idAt(1) ? { cmd: 'hidden-set', id: idAt(1), hidden: false } : { cmd: 'error', message: 'usage: show BONA-W001' };
    default:
      return { cmd: null };
  }
}

export const HELP_TEXT = [
  'Bona intake — commands',
  '',
  'Send a property brochure PDF here to publish it — the brochure is re-published under',
  'Bona branding and appears on the page as "Download brochure".',
  'Caption hints: rent · off-plan · SAR 4,500,000 · #test (dry run) · #nobrochure (no PDF on the page) · #hidden',
  '',
  'remove BONA-W001        take the listing off the site',
  'hero BONA-W001 4        make photo 4 the cover',
  'price BONA-W001 4500000 set the asking price (or: price BONA-W001 onrequest)',
  'brochure BONA-W001      rebuild the Bona-branded PDF from the original',
  'sold BONA-W001          mark it sold   (also: reserved / available)',
  'hide BONA-W001          keep it off the site  (show BONA-W001 puts it back)',
  'status                  what the intake is doing',
].join('\n');
