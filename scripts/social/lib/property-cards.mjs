// Land plot cards for the daily property register (owner, 2026-10-21): land listings have only two
// 1024x768 satellite stills, so a plot is shown as a branded card set instead of photographs:
// (a) the plot still, (b) the facts, (c) the area still with the district and city. Rendered at
// approval and hosted like the padded frames (lib/property-media.mjs writeMedia()).
//
// Every string on a card comes from the listing's public facts (publicListing(): title, location,
// price, specs, highlights), which the review's factsSha256 binds: a changed fact invalidates the
// review and its cards together. Nothing is computed that the listing does not state (no price per
// square metre unless a highlight states it, no landmark unless a highlight names it). Arabic goes
// through brand.mjs text() (Pango) only, never ffmpeg drawtext.
import './fonts.mjs';
import { C, centred, fitText, iso, rule, sharp, text, wordmark } from './brand.mjs';
import { MEDIA_SIZE, showsPrice } from './property-daily.mjs';
import { jpeg } from './property-media.mjs';

const { width: W, height: H } = MEDIA_SIZE;
const n = x => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ------------------------------------------------------------------------------------- land facts
const N = String.raw`\d[\d,]*(?:\.\d+)?`;
const num = s => Number(String(s).replace(/,/g, ''));
/** Every number in a string, Arabic-Indic and Eastern Arabic digits and the Arabic separators (٬ thousands, ٫ decimal) read as Latin. */
/** Arabic-Indic and Eastern Arabic digits to Latin, ٬ to ',' and ٫ to '.': done before any parsing or digit test. */
export const latinDigits = s => String(s ?? '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
  .replace(/٬/g, ',').replace(/٫/g, '.');
export function numbersIn(s) {
  return (latinDigits(s).match(new RegExp(N, 'g')) ?? []).map(num).sort((x, y) => x - y);
}
const sameNumbers = (a, b) => { const x = numbersIn(a), y = numbersIn(b); return x.length === y.length && x.every((v, i) => v === y[i]); };
/**
 * One English highlight read as facts: every number in it must belong to a form this card knows
 * (a price per square metre, a price per plot, a total price, an area, "A m by B m", a length in
 * metres); a number left over makes the highlight unparseable, and the set is refused rather than
 * printing a figure nobody checked.
 */
export function parseHighlight(en) {
  let rest = ` ${latinDigits(en)} `;
  const out = { perSqm: [], perPlot: [], total: [], area: [], dims: [], lengths: [] };
  const take = (re, f) => { rest = rest.replace(re, (...m) => { f(m); return ' '; }); };
  const SQM = String.raw`(?:sqm|m²|m2|sq\.?\s*m|square\s*met(?:re|er)s?)`;
  take(new RegExp(String.raw`(?:about\s+)?SAR\s*(${N})\s*(?:per\s*${SQM}|\/\s*${SQM})(?:\s*net)?`, 'gi'), m => out.perSqm.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*SAR\s*(?:per\s*${SQM}|\/\s*${SQM})`, 'gi'), m => out.perSqm.push(num(m[1])));
  take(new RegExp(String.raw`SAR\s*(${N})\s*per\s*plot`, 'gi'), m => out.perPlot.push(num(m[1])));
  take(new RegExp(String.raw`SAR\s*(${N})`, 'gi'), m => out.total.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*m\s*(?:by|x|×)\s*(${N})\s*m\b`, 'gi'), m => out.dims.push([num(m[1]), num(m[2])]));
  take(new RegExp(String.raw`(${N})\s*${SQM}`, 'gi'), m => out.area.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*-?\s*(?:m\b|metres?\b|meters?\b)`, 'gi'), m => out.lengths.push(num(m[1])));
  // A unit qualifier the card does not model (a linear or running metre) would otherwise be read as m².
  out.unparsed = /\d/.test(rest) || /\b(?:linear|running)\s*met(?:re|er)|\bper\s*lm\b/i.test(en);
  return out;
}
/**
 * The Arabic highlight read into the same typed facts as parseHighlight() (digits normalised
 * first, diacritics and tatweel ignored): «ريال للمتر» / «ريال/م²» a price per square metre,
 * «ريال للقطعة» per plot, «ريال» a total, «م²» / «متر مربع» an area, «A في B متراً» dimensions,
 * «متراً» / «م» a length. A number left over makes it unparseable.
 */
export function parseHighlightAr(ar) {
  let rest = ` ${latinDigits(ar).replace(/[\u064B-\u0652\u0670\u0640]/g, '')} `;
  const out = { perSqm: [], perPlot: [], total: [], area: [], dims: [], lengths: [] };
  const take = (re, f) => { rest = rest.replace(re, (...m) => { f(m); return ' '; }); };
  const RIYAL = String.raw`(?:ريالا?(?:\s*سعودي)?|ر\.س)`;
  const SQM = String.raw`(?:م²|م2|مترا?\s*مربعا?|م\s*مربع)`;
  const END = String.raw`(?![\u0600-\u06FF²2])`;
  take(new RegExp(String.raw`(?:نحو\s*)?(${N})\s*${RIYAL}\s*(?:\/\s*${SQM}|لل?متر(?:\s*المربع)?|للمتر\s*مربع)(?:\s*صافيا?)?`, 'g'), m => out.perSqm.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*${RIYAL}\s*لل?قطعة`, 'g'), m => out.perPlot.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*${RIYAL}`, 'g'), m => out.total.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*(?:في|×|x)\s*(${N})\s*(?:مترا?|م)${END}`, 'g'), m => out.dims.push([num(m[1]), num(m[2])]));
  take(new RegExp(String.raw`(${N})\s*${SQM}`, 'g'), m => out.area.push(num(m[1])));
  take(new RegExp(String.raw`(${N})\s*(?:مترا?|امتار|م)${END}`, 'g'), m => out.lengths.push(num(m[1])));
  // «للمتر الطولي» (per linear metre) must not pass as a price per square metre.
  out.unparsed = /\d/.test(rest) || /طولي|طولى/.test(ar);
  return out;
}
/** True when two parsed highlights state the same facts: same kinds, same numbers. */
export function sameFacts(a, b) {
  const key = h => JSON.stringify(['perSqm', 'perPlot', 'total', 'area', 'lengths'].map(k => [...h[k]].sort((x, y) => x - y)).concat([h.dims.map(d => d.join('x')).sort()]));
  return key(a) === key(b);
}
const PERIOD = Object.freeze({ year: { ar: 'سنوياً', en: 'year' }, month: { ar: 'شهرياً', en: 'month' } });
/**
 * Why this land listing's facts cannot carry a correct card set, as a list (empty when they can):
 * no plot area; highlights that do not pair up, or whose Arabic and English numbers differ (the
 * title, district and city too); a numeric highlight the card cannot read; a stated area, plot
 * dimensions, price per square metre, total price or price per plot that contradicts the listing;
 * a price the card cannot state exactly (a period other than a year or a month).
 */
export function landFactsProblems(p) {
  const out = [];
  if (p?.type !== 'land') out.push('not_land');
  const area = Number(p?.specs?.plotSqm);
  if (!(area > 0)) out.push('no_plot_area');
  const en = p?.highlights?.en ?? [], ar = p?.highlights?.ar ?? [];
  if (en.length !== ar.length || en.some(x => !String(x).trim()) || ar.some(x => !String(x).trim())) out.push('highlights_do_not_pair');
  if (!p?.location?.district?.ar || !p?.location?.district?.en || !p?.location?.city?.ar || !p?.location?.city?.en) out.push('no_district_or_city');
  const pairs = [[p?.title?.en, p?.title?.ar], [p?.location?.district?.en, p?.location?.district?.ar], [p?.location?.city?.en, p?.location?.city?.ar]];
  if (pairs.some(([e, a]) => !sameNumbers(e, a))) out.push('arabic_and_english_numbers_differ');
  // Highlights: the Arabic must state the same typed facts as the English (a rate is a rate, not a per-plot price).
  for (const [i, x] of en.entries()) {
    const he = parseHighlight(x), ha = parseHighlightAr(ar[i]);
    if (ha.unparsed) out.push('highlight_unparseable');
    if (!sameNumbers(x, ar[i])) out.push('arabic_and_english_numbers_differ');
    else if (!he.unparsed && !ha.unparsed && !sameFacts(he, ha)) out.push('arabic_and_english_facts_differ');
  }
  const shown = showsPrice(p), price = shown ? Number(p.price.amount) : null;
  const near = (x, y, tol) => Math.abs(x - y) / y <= tol;
  for (const h of en.map(parseHighlight)) {
    if (h.unparsed) out.push('highlight_unparseable');
    if (area > 0 && h.area.some(x => x !== area)) out.push('area_contradicts_highlights');
    if (area > 0 && h.dims.some(([x, y]) => !near(x * y, area, 0.02))) out.push('dimensions_contradict_area');
    if (shown && area > 0 && h.perSqm.some(x => !near(x * area, price, 0.01))) out.push('price_per_sqm_contradicts_price');
    if ([...h.total, ...h.perPlot].some(x => !shown || x !== price)) out.push('total_price_contradicts_price');
  }
  if (shown && p.price.period != null && !PERIOD[p.price.period]) out.push('unsupported_price_shape');
  return [...new Set(out)];
}
/**
 * What the facts card says, from the listing only: the plot area, the asking price (when the
 * caption shows one) exactly as qualified there (from-price, rental period, per plot when a
 * highlight says so), then the highlights in their two languages, leaving out the ones that only
 * repeat the area, the price or the district name (the location card carries that).
 */
export function landFacts(p) {
  const area = Number(p.specs.plotSqm);
  const parsed = (p.highlights?.en ?? []).map(parseHighlight);
  let price = null;
  if (showsPrice(p)) {
    const perPlot = parsed.some(h => h.perPlot.includes(Number(p.price.amount)));
    const period = p.price.period ? PERIOD[p.price.period] : null;
    if (p.price.period && !period) throw new Error(`${p.id}: price period "${p.price.period}" cannot be stated on a card`);
    const rent = p.category === 'rent';
    price = {
      label: { ar: rent ? 'الإيجار' : perPlot ? 'السعر للقطعة' : 'السعر', en: rent ? 'Rent' : perPlot ? 'Asking price per plot' : 'Asking price' },
      ar: `${p.price.from ? 'ابتداءً من ' : ''}${iso(n(p.price.amount))} ريال${period ? ` ${period.ar}` : ''}`,
      en: `${p.price.from ? 'From ' : ''}SAR ${n(p.price.amount)}${period ? ` / ${period.en}` : ''}`,
    };
  }
  const en = p.highlights?.en ?? [], ar = p.highlights?.ar ?? [];
  const district = String(p.location?.district?.en ?? '').trim().toLowerCase();
  const amount = showsPrice(p) ? Number(p.price.amount) : null;
  const rows = en.map((x, i) => ({ en: String(x).trim(), ar: String(ar[i]).trim(), h: parsed[i] })).filter(({ en: x, h }) =>
    !/^[\d,.]+\s*sqm$/i.test(x) && x.toLowerCase() !== district &&
    !(amount != null && /^(?:SAR\s*[\d,.]+(?:\s*per\s*plot)?)$/i.test(x) && [...h.total, ...h.perPlot].includes(amount))).map(({ h, ...r }) => r);
  return {
    area: { ar: `${iso(n(area))} م²`, en: `${n(area)} m²` },
    price, rows,
    deal: p.category === 'rent' ? { ar: 'أرض للإيجار', en: 'LAND FOR RENT' } : { ar: 'أرض للبيع', en: 'LAND FOR SALE' },
  };
}

// ------------------------------------------------------------------------------------------ cards
const frameLine = (color, opacity) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="1.5"/></svg>`), top: 0, left: 0 });
const BOX = W - 180;
/** Stack blocks centred from `top`; returns the layers and where the stack ended. */
function stack(blocks, top) {
  const layers = [];
  let y = top;
  for (const b of blocks) { y += b.gapBefore ?? 0; layers.push(centred(b, W, y)); y += b.height; }
  return { layers, bottom: y };
}
const ruleBlock = async (w, gapBefore) => ({ data: await rule(w, 2, C.champagne), width: w, height: 2, gapBefore });
async function footer(p, color) {
  return text({ text: `${p.id}  ·  bona-real-estate.com`, face: 'en-body', size: 22, color, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 2 });
}

/**
 * Card (a) or (c): a listing satellite still, fitted whole into a 960 px wide window (the
 * 1024x768 stills are scaled down, never up), labelled as an approximate satellite view with the
 * imagery source, then the title and place (a) or the district and city large (c).
 */
export async function satelliteCard(still, p, { variant = 'plot' } = {}) {
  const imgW = 960, imgH = 720;
  const photo = await sharp(still).rotate().resize({ width: imgW, height: imgH, fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const { width: pw, height: ph } = photo.info;
  const mark = await wordmark({ size: 34, color: C.ivory, arabic: false });
  const label = variant === 'plot'
    ? { ar: 'صورة جوية، الموقع تقريبي', en: 'Satellite view, approximate' }
    : { ar: 'صورة جوية للمنطقة، الموقع تقريبي', en: 'Satellite view of the area, approximate' };
  const la = await text({ text: label.ar, face: 'ar-body', size: 30, color: C.champagne2, align: 'centre', width: BOX });
  const le = await text({ text: label.en, face: 'en-body', size: 22, color: C.sand, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 1.5 });
  const src = await text({ text: 'Imagery: Esri World Imagery', face: 'en-body', size: 16, color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 1 });
  let heading;
  if (variant === 'plot') {
    heading = [
      { ...await fitText({ text: p.title.ar, face: 'ar-display', size: 56, color: C.ivory, width: BOX, align: 'centre', lineHeight: 1.25 }, { maxHeight: 150, minSize: 34 }), gapBefore: 34 },
      { ...await fitText({ text: p.title.en, face: 'en-display', size: 36, color: C.sand, width: BOX, align: 'centre', dir: 'ltr' }, { maxHeight: 100, minSize: 24 }), gapBefore: 8 },
    ];
  } else {
    const country = p.location?.country ?? {};
    heading = [
      { ...await fitText({ text: p.location.district.ar, face: 'ar-display', size: 76, color: C.ivory, width: BOX, align: 'centre' }, { maxHeight: 120, minSize: 40 }), gapBefore: 30 },
      { ...await fitText({ text: p.location.district.en, face: 'en-display', size: 44, color: C.sand, width: BOX, align: 'centre', dir: 'ltr', letterSpacing: 1 }, { maxHeight: 70, minSize: 26 }), gapBefore: 4 },
      { ...await text({ text: [p.location.city.ar, country.ar].filter(Boolean).join('، '), face: 'ar-body', size: 28, color: C.sand, align: 'centre', width: BOX }), gapBefore: 14 },
      { ...await text({ text: [p.location.city.en, country.en].filter(Boolean).join(', '), face: 'en-body', size: 20, color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 2 }), gapBefore: 4 },
    ];
  }
  if (variant === 'plot') {
    const place = { ar: [p.location.district.ar, p.location.city.ar].join('، '), en: [p.location.district.en, p.location.city.en].join(', ') };
    heading.push({ ...await text({ text: place.ar, face: 'ar-body', size: 28, color: C.sand, align: 'centre', width: BOX }), gapBefore: 14 });
    heading.push({ ...await text({ text: place.en, face: 'en-body', size: 20, color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 2 }), gapBefore: 4 });
  }
  const top = 150;
  const caption = stack([{ ...la, gapBefore: 0 }, { ...le, gapBefore: 6 }, { ...src, gapBefore: 8 }, ...heading], top + ph + 26);
  const foot = await footer(p, C.stone);
  if (caption.bottom > H - 110) throw new Error(`${p.id}: satellite card text does not fit`);
  const border = { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${pw + 4}" height="${ph + 4}"><rect x="1" y="1" width="${pw + 2}" height="${ph + 2}" fill="none" stroke="${C.champagne}" stroke-opacity="0.7" stroke-width="2"/></svg>`), top: top - 2, left: Math.round((W - pw) / 2) - 2 };
  return jpeg(sharp({ create: { width: W, height: H, channels: 3, background: C.ink } }).composite([
    frameLine(C.champagne, 0.38), centred(mark, W, 72),
    { input: photo.data, top, left: Math.round((W - pw) / 2) }, border,
    ...caption.layers, centred(foot, W, H - 92),
  ]));
}

/**
 * Card (c) without imagery (policy satellite: false): the district large, then city and country and
 * the title, on the ink, nothing that is not in the listing.
 */
export async function locationCard(p) {
  const mark = await wordmark({ size: 34, color: C.ivory, arabic: false });
  const country = p.location?.country ?? {};
  const blocks = [
    { ...await text({ text: 'الموقع', face: 'ar-body', size: 32, color: C.champagne2, align: 'centre', width: BOX }), gapBefore: 0 },
    { ...await text({ text: 'LOCATION', face: 'en-body', size: 20, color: C.sand, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 4 }), gapBefore: 6 },
    { ...await fitText({ text: p.location.district.ar, face: 'ar-display', size: 120, color: C.ivory, width: BOX, align: 'centre' }, { maxHeight: 200, minSize: 48 }), gapBefore: 40 },
    { ...await fitText({ text: p.location.district.en, face: 'en-display', size: 64, color: C.sand, width: BOX, align: 'centre', dir: 'ltr', letterSpacing: 1 }, { maxHeight: 110, minSize: 28 }), gapBefore: 6 },
    await ruleBlock(Math.round(BOX * 0.25), 40),
    { ...await text({ text: [p.location.city.ar, country.ar].filter(Boolean).join('، '), face: 'ar-body', size: 36, color: C.sand, align: 'centre', width: BOX }), gapBefore: 36 },
    { ...await text({ text: [p.location.city.en, country.en].filter(Boolean).join(', '), face: 'en-body', size: 24, color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 2 }), gapBefore: 6 },
    { ...await fitText({ text: p.title.ar, face: 'ar-display', size: 44, color: C.ivory, width: BOX, align: 'centre', lineHeight: 1.25 }, { maxHeight: 130, minSize: 28 }), gapBefore: 60 },
    { ...await fitText({ text: p.title.en, face: 'en-display', size: 30, color: C.sand, width: BOX, align: 'centre', dir: 'ltr' }, { maxHeight: 80, minSize: 20 }), gapBefore: 6 },
  ];
  const height = blocks.reduce((a, b) => a + (b.gapBefore ?? 0) + b.height, 0);
  if (height > H - 300) throw new Error(`${p.id}: location card text does not fit`);
  const { layers } = stack(blocks, Math.round((H - height) / 2));
  const foot = await footer(p, C.stone);
  return jpeg(sharp({ create: { width: W, height: H, channels: 3, background: C.ink } }).composite([
    frameLine(C.champagne, 0.38), centred(mark, W, 72), ...layers, centred(foot, W, H - 92),
  ]));
}

/** Card (b): the plot facts on ivory, every line from landFacts(). Shrinks the type until it fits; throws rather than cut a line off. */
export async function factsCard(p) {
  const problems = landFactsProblems(p);
  if (problems.length) throw new Error(`${p.id}: facts card refused (${problems.join(', ')})`);
  const f = landFacts(p);
  const mark = await wordmark({ size: 34, color: C.ink, arabic: false });
  const foot = await footer(p, C.stone);
  for (let scale = 1; scale >= 0.6; scale -= 0.05) {
    const s = x => Math.round(x * scale);
    const blocks = [
      { ...await text({ text: f.deal.ar, face: 'ar-body', size: s(30), color: C.champagne, align: 'centre', width: BOX }), gapBefore: 0 },
      { ...await text({ text: f.deal.en, face: 'en-body', size: s(18), color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 4 }), gapBefore: 4 },
      { ...await fitText({ text: p.title.ar, face: 'ar-display', size: s(54), color: C.ink, width: BOX, align: 'centre', lineHeight: 1.25 }, { maxHeight: s(140), minSize: 30 }), gapBefore: s(22) },
      { ...await fitText({ text: p.title.en, face: 'en-display', size: s(34), color: C.stone2, width: BOX, align: 'centre', dir: 'ltr' }, { maxHeight: s(90), minSize: 22 }), gapBefore: 6 },
      await ruleBlock(Math.round(BOX * 0.25), s(28)),
      { ...await text({ text: `المساحة  ${f.area.ar}`, face: 'ar-display', size: s(58), color: C.ink, align: 'centre', width: BOX }), gapBefore: s(26) },
      { ...await text({ text: `Plot area  ${f.area.en}`, face: 'en-display', size: s(30), color: C.stone2, align: 'centre', width: BOX, dir: 'ltr' }), gapBefore: 2 },
    ];
    if (f.price) {
      blocks.push({ ...await fitText({ text: `${f.price.label.ar}  ${f.price.ar}`, face: 'ar-display', size: s(58), color: C.ink, align: 'centre', width: BOX }, { maxHeight: s(80), minSize: 30 }), gapBefore: s(20) });
      blocks.push({ ...await fitText({ text: `${f.price.label.en}  ${f.price.en}`, face: 'en-display', size: s(30), color: C.stone2, align: 'centre', width: BOX, dir: 'ltr' }, { maxHeight: s(50), minSize: 20 }), gapBefore: 2 });
    }
    if (f.rows.length) blocks.push(await ruleBlock(Math.round(BOX * 0.25), s(28)));
    for (const [i, r] of f.rows.entries()) {
      blocks.push({ ...await text({ text: r.ar, face: 'ar-body', size: s(34), color: C.ink, align: 'centre', width: BOX }), gapBefore: i ? s(18) : s(24) });
      blocks.push({ ...await text({ text: r.en, face: 'en-body', size: s(22), color: C.stone, align: 'centre', width: BOX, dir: 'ltr', letterSpacing: 0.5 }), gapBefore: 2 });
    }
    const height = blocks.reduce((a, b) => a + (b.gapBefore ?? 0) + b.height, 0);
    const room = { top: 150, bottom: H - 120 };
    if (height > room.bottom - room.top || blocks.some(b => b.width > BOX + 2)) continue;
    const { layers } = stack(blocks, room.top + Math.round((room.bottom - room.top - height) / 2));
    return jpeg(sharp({ create: { width: W, height: H, channels: 3, background: C.ivory } }).composite([
      frameLine(C.champagne, 0.5), centred(mark, W, 72), ...layers, centred(foot, W, H - 92),
    ]));
  }
  throw new Error(`${p.id}: facts card text does not fit`);
}


// ------------------------------------------------------------------------------------- the set
/** Every string the cards burn into pixels for this listing (the approve script runs the caption refusal over them). */
export function cardStrings(p) {
  const f = landFacts(p);
  return [p.title.ar, p.title.en, p.location?.district?.ar, p.location?.district?.en, p.location?.city?.ar, p.location?.city?.en,
    p.location?.country?.ar, p.location?.country?.en, f.area.ar, f.area.en, f.price?.ar, f.price?.en, f.price?.label.ar, f.price?.label.en, f.deal.ar, f.deal.en,
    ...f.rows.flatMap(r => [r.ar, r.en]), p.id].filter(x => x != null).map(String);
}
/**
 * The plot card set, in carousel order: (a) the plot still, (b) the facts, (c) the area still;
 * with `satellite: false`, only (b) and a text-only (c).
 * `plot` and `area` are the listing stills' bytes ({bytes, url, sha256, width, height}); each card
 * names the still it was made from. Throws when the facts cannot carry a correct set.
 */
export async function cardSet(p, { plot, area, satellite = true } = {}) {
  const problems = landFactsProblems(p);
  if (problems.length) throw new Error(`${p.id}: no card set (${problems.join(', ')})`);
  const t0 = p.title;
  // Policy satellite: false: no satellite imagery at all, so the set is the facts card and a text-only location card.
  if (!satellite) return [
    { card: 'facts', bytes: await factsCard(p), source: null, alt: { ar: `تفاصيل الأرض — ${t0.ar}`, en: `Plot facts — ${t0.en}` } },
    { card: 'location', bytes: await locationCard(p), source: null, alt: { ar: `الموقع — ${t0.ar}`, en: `Location — ${t0.en}` } },
  ];
  if (!plot?.bytes || !area?.bytes) throw new Error(`${p.id}: a card set needs the plot still and the area still`);
  const src = s => ({ url: s.url, sha256: s.sha256, width: s.width, height: s.height });
  const t = p.title;
  return [
    { card: 'satellite', bytes: await satelliteCard(plot.bytes, p, { variant: 'plot' }), source: src(plot),
      alt: { ar: `صورة جوية، الموقع تقريبي — ${t.ar}`, en: `Satellite view, approximate — ${t.en}` } },
    { card: 'facts', bytes: await factsCard(p), source: null,
      alt: { ar: `تفاصيل الأرض — ${t.ar}`, en: `Plot facts — ${t.en}` } },
    { card: 'location', bytes: await satelliteCard(area.bytes, p, { variant: 'area' }), source: src(area),
      alt: { ar: `صورة جوية للمنطقة، الموقع تقريبي — ${t.ar}`, en: `Satellite view of the area, approximate — ${t.en}` } },
  ];
}
