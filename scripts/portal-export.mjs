#!/usr/bin/env node
/* portal-export — one ready-to-paste text per listing for the Saudi property portals (Aqar first),
   each with a tracked link back to the site so a visit from the portal is attributed.

     node scripts/portal-export.mjs                 # every available listing → dist/portal/aqar/<id>.txt
     node scripts/portal-export.mjs --id BONA-W003  # one listing (repeatable / comma separated)
     node scripts/portal-export.mjs --list          # table: id, title, category, licence status — no files
     node scripts/portal-export.mjs --stdout        # print instead of writing
     node scripts/portal-export.mjs --out <dir>     # another output directory (default dist/portal)

   Reads src/data/listings.json and src/data/site.json directly (no site build, no dependencies).
   Every text has an Arabic block then an English block: title, category, price line, specs,
   district/city, the REGA licence line, the advertiser line, and the tracked URL:
     <site.url>/ar/properties/<slug>/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=<id>
   Prices are printed only as the site prints them — "السعر عند الطلب" / "Price on request" when
   there is none (TAQEEM); the export never estimates. A listing without an ad licence or a Wafi
   number is exported with "رخصة الإعلان: قيد الإصدار" and must not be posted until the number
   exists (docs/checklists/rega-ad-licences.md). Node 22+. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ text helpers */

const CATEGORY = {
  buy: { ar: 'للبيع', en: 'For sale' },
  rent: { ar: 'للإيجار', en: 'For rent' },
  'off-plan': { ar: 'على الخارطة', en: 'Off-plan' },
  international: { ar: 'للبيع — خارج المملكة', en: 'For sale — international' },
};

const TYPE = {
  villa: { ar: 'فيلا', en: 'Villa' },
  apartment: { ar: 'شقة', en: 'Apartment' },
  penthouse: { ar: 'بنتهاوس', en: 'Penthouse' },
  mansion: { ar: 'قصر', en: 'Mansion' },
  land: { ar: 'أرض', en: 'Land' },
  building: { ar: 'عمارة', en: 'Building' },
  duplex: { ar: 'دوبلكس', en: 'Duplex' },
  townhouse: { ar: 'تاون هاوس', en: 'Townhouse' },
};

const CURRENCY = {
  SAR: { ar: 'ر.س', en: 'SAR' },
  AED: { ar: 'د.إ', en: 'AED' },
  EUR: { ar: 'يورو', en: 'EUR' },
  USD: { ar: 'دولار', en: 'USD' },
  OMR: { ar: 'ر.ع', en: 'OMR' },
};

const PERIOD = {
  year: { ar: 'سنوياً', en: 'per year' },
  month: { ar: 'شهرياً', en: 'per month' },
};

/** Western digits with thousands separators — the site prints numbers this way in both locales. */
export const fmtNumber = (n) => Number(n).toLocaleString('en-US');

/** Price line exactly as the site would show it; never a computed or estimated number. */
export function priceLine(price, locale) {
  const p = price ?? {};
  const amount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0 ? p.amount : null;
  if (p.onRequest || amount == null) return locale === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  const cur = CURRENCY[p.currency] ?? { ar: p.currency ?? '', en: p.currency ?? '' };
  const num = fmtNumber(amount);
  const period = p.period && PERIOD[p.period] ? ` ${PERIOD[p.period][locale]}` : '';
  if (locale === 'ar') return `${p.from ? 'يبدأ من ' : ''}${num} ${cur.ar}${period}`.trim();
  return `${p.from ? 'From ' : ''}${cur.en} ${num}${period}`.trim();
}

export function specsLine(listing, locale) {
  const s = listing.specs ?? {};
  const parts = [];
  if (listing.kind === 'land') {
    if (s.plotSqm) parts.push(locale === 'ar' ? `${fmtNumber(s.plotSqm)} م² مساحة الأرض` : `${fmtNumber(s.plotSqm)} sqm plot`);
  } else {
    if (s.beds) parts.push(locale === 'ar' ? `${s.beds} غرف` : `${s.beds} bed`);
    if (s.baths) parts.push(locale === 'ar' ? `${s.baths} دورات مياه` : `${s.baths} bath`);
    if (s.areaSqm) parts.push(locale === 'ar' ? `${fmtNumber(s.areaSqm)} م²` : `${fmtNumber(s.areaSqm)} sqm`);
    if (s.plotSqm) parts.push(locale === 'ar' ? `أرض ${fmtNumber(s.plotSqm)} م²` : `plot ${fmtNumber(s.plotSqm)} sqm`);
  }
  return parts.join(locale === 'ar' ? ' · ' : ' · ');
}

/**
 * The REGA line. Ad licence (with expiry) wins; a Wafi project licence is the off-plan
 * equivalent; otherwise the listing is marked "licence pending" so nobody posts it by mistake.
 */
export function licenceLine(listing, locale) {
  const l = listing.licence ?? {};
  if (l.adNumber) {
    const until = l.adExpiry ? (locale === 'ar' ? ` — سارية حتى ${l.adExpiry}` : ` · valid until ${l.adExpiry}`) : '';
    return locale === 'ar' ? `رخصة الإعلان العقاري: ${l.adNumber}${until}` : `Advertising licence: ${l.adNumber}${until}`;
  }
  if (l.wafiNumber) {
    const escrow = l.escrowAccount ? (locale === 'ar' ? ` — حساب الضمان ${l.escrowAccount}` : ` · escrow account ${l.escrowAccount}`) : '';
    return locale === 'ar' ? `رخصة مشروع وافي: ${l.wafiNumber}${escrow}` : `Wafi project licence: ${l.wafiNumber}${escrow}`;
  }
  return locale === 'ar' ? 'رخصة الإعلان: قيد الإصدار' : 'Advertising licence: pending';
}

export function licenceStatus(listing) {
  const l = listing.licence ?? {};
  if (l.adNumber) return l.adExpiry && l.adExpiry < new Date().toISOString().slice(0, 10) ? 'expired' : 'ad-licence';
  if (l.wafiNumber) return 'wafi';
  return 'pending';
}

export function advertiserLine(site, locale) {
  const adv = site.advertiser ?? { name: { en: 'Abdulaziz Zidan', ar: 'عبدالعزيز زيدان' }, fal: site.licences?.fal ?? '1100313556' };
  const name = adv.name?.[locale] ?? adv.name?.en ?? '';
  return locale === 'ar' ? `المُعلن: ${name} — رخصة فال ${adv.fal}` : `Advertiser: ${name} — FAL licence ${adv.fal}`;
}

export function trackedUrl(listing, site, locale, source = 'aqar') {
  const base = String(site.url ?? '').replace(/\/+$/, '');
  const prefix = locale === 'ar' ? '/ar' : '';
  const q = new URLSearchParams({ utm_source: source, utm_medium: 'portal', utm_campaign: 'listing', utm_content: listing.id });
  return `${base}${prefix}/properties/${listing.slug}/?${q.toString()}`;
}

const t = (obj, locale) => (obj && typeof obj === 'object' ? obj[locale] ?? obj.en ?? '' : obj ?? '');

function block(listing, site, locale) {
  const cat = CATEGORY[listing.category] ?? CATEGORY.buy;
  const type = TYPE[listing.type] ?? { ar: listing.type ?? '', en: listing.type ?? '' };
  const district = t(listing.location?.district, locale);
  const city = t(listing.location?.city, locale);
  const where = [district, city].filter(Boolean).join(locale === 'ar' ? '، ' : ', ');
  const project = listing.project?.name ? t(listing.project.name, locale) : '';
  const lines = [
    t(listing.title, locale),
    `${type[locale]} ${cat[locale]}`.trim(),
    project ? (locale === 'ar' ? `المشروع: ${project}` : `Project: ${project}`) : null,
    (locale === 'ar' ? 'السعر: ' : 'Price: ') + priceLine(listing.price, locale),
    specsLine(listing, locale) || null,
    where ? (locale === 'ar' ? `الموقع: ${where}` : `Location: ${where}`) : null,
    listing.id,
    licenceLine(listing, locale),
    advertiserLine(site, locale),
    (locale === 'ar' ? 'التفاصيل والصور: ' : 'Details and photos: ') + trackedUrl(listing, site, locale),
    (locale === 'ar' ? 'واتساب: ' : 'WhatsApp: ') + (site.whatsapp?.display ?? ''),
  ];
  return lines.filter((l) => l != null && l !== '').join('\n');
}

/** Pure: the Aqar text for one listing — Arabic block, blank line, English block. */
export function renderAqar(listing, site) {
  return `${block(listing, site, 'ar')}\n\n${block(listing, site, 'en')}\n`;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const opts = { ids: [], list: false, stdout: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id') opts.ids.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--list') opts.list = true;
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2), { listingsFile, siteFile, log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\* ?/, '')); return { written: [] }; }
  const site = JSON.parse(fs.readFileSync(siteFile ?? path.join(root, 'src/data/site.json'), 'utf8'));
  const all = JSON.parse(fs.readFileSync(listingsFile ?? path.join(root, 'src/data/listings.json'), 'utf8'));
  let listings = all.filter((l) => l.status === 'available');
  if (opts.ids.length) {
    const want = new Set(opts.ids.map((s) => s.toUpperCase()));
    listings = all.filter((l) => want.has(String(l.id).toUpperCase()));
    const missing = [...want].filter((id) => !listings.some((l) => String(l.id).toUpperCase() === id));
    if (missing.length) throw new Error(`no listing with id ${missing.join(', ')}`);
  }

  if (opts.list) {
    log(`${'id'.padEnd(10)} ${'status'.padEnd(10)} ${'category'.padEnd(13)} ${'licence'.padEnd(11)} title`);
    for (const l of listings) log(`${l.id.padEnd(10)} ${String(l.status).padEnd(10)} ${String(l.category).padEnd(13)} ${licenceStatus(l).padEnd(11)} ${l.title?.en ?? ''}`);
    const pending = listings.filter((l) => licenceStatus(l) === 'pending').length;
    log(`\n${listings.length} listing(s); ${pending} without an ad licence or Wafi number (do not post those yet)`);
    return { written: [], listings };
  }

  const outDir = path.resolve(root, opts.out ?? 'dist/portal', 'aqar');
  const written = [];
  if (!opts.stdout) fs.mkdirSync(outDir, { recursive: true });
  for (const l of listings) {
    const text = renderAqar(l, site);
    if (opts.stdout) { log(`----- ${l.id} -----\n${text}`); continue; }
    const file = path.join(outDir, `${l.id}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    written.push(file);
  }
  if (!opts.stdout) {
    const pending = listings.filter((l) => licenceStatus(l) === 'pending').length;
    log(`portal-export: ${written.length} file(s) → ${path.relative(root, outDir)}/  (${pending} marked "licence pending" — not to be posted yet)`);
  }
  return { written, listings };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try { main(); } catch (err) { console.error(`portal-export: ${err?.message ?? err}`); process.exitCode = 1; }
}
