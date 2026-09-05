#!/usr/bin/env node
/* Generates public/llms.txt and public/llms-full.txt (llmstxt.org / Open-Knowledge style)
   from src/data/site.json + src/data/listings.json + src/data/about.json + src/data/privacy.json
   (+ marketing/page-meta.json if present).
   Run BEFORE `astro build` so the files ship in the output:
     node scripts/og/gen-llms.mjs
   Idempotent, no network, no dependencies.
   Round 2: lists the Houses / Apartments / Land / Tours / Privacy pages, groups listings by `kind`
   (derived from `type` when the field is missing), and surfaces Matterport tours, projects and units. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; } };
const site = read('src/data/site.json');
const listings = read('src/data/listings.json');
const about = read('src/data/about.json', { story: { en: [], ar: [] }, values: [], team: [], stats: [] });
const privacy = read('src/data/privacy.json', null);
const pageMeta = read('marketing/page-meta.json', {});

const base = site.url.replace(/\/$/, '');
const abs = (p) => `${base}${p.startsWith('/') ? p : '/' + p}`;
const wa = `https://wa.me/${site.whatsapp.wa}`;
const today = new Date().toISOString().slice(0, 10);

const typeLabel = { villa: 'Villa', apartment: 'Apartment', penthouse: 'Penthouse', mansion: 'Mansion', duplex: 'Duplex', townhouse: 'Townhouse', chalet: 'Chalet', building: 'Building', land: 'Land' };
const catLabel = { buy: 'For sale', rent: 'For rent', 'off-plan': 'Off-plan', international: 'International' };
const KINDS = [
  { key: 'house', label: 'Houses', one: 'House', path: '/properties/houses/' },
  { key: 'apartment', label: 'Apartments', one: 'Apartment', path: '/properties/apartments/' },
  { key: 'land', label: 'Land', one: 'Land', path: '/properties/land/' },
  { key: 'building', label: 'Buildings', one: 'Building', path: '/properties/buildings/' },
  { key: 'other', label: 'Other', one: 'Other', path: null },
];
const TYPE_TO_KIND = { villa: 'house', mansion: 'house', duplex: 'house', palais: 'house', townhouse: 'house', chalet: 'house', apartment: 'apartment', penthouse: 'apartment', residence: 'apartment', land: 'land', plot: 'land', building: 'building', office: 'building' };
const kindOf = (l) => { const k = String(l.kind ?? '').trim().toLowerCase(); if (['house', 'apartment', 'land', 'building'].includes(k)) return k; return TYPE_TO_KIND[String(l.type ?? '').trim().toLowerCase()] ?? 'other'; };
const tourOf = (l) => { const u = String(l.virtualTourUrl ?? '').trim(); return /^https?:\/\//i.test(u) ? u : null; };
const projectOf = (l) => (l.project?.name?.en || l.project?.name?.ar || '').trim();
const unitOf = (l) => { const u = l.unit; if (!u) return ''; const b = []; if (u.floor != null && u.floor !== '') b.push(`floor ${u.floor}`); if (u.block) b.push(`block ${u.block}`); if (u.unitRef) b.push(`unit ${u.unitRef}`); return b.join(', '); };

const fmtPrice = (p) => {
  if (!p || p.onRequest || p.amount == null) return 'Price on request';
  const n = new Intl.NumberFormat('en-US').format(p.amount);
  const per = p.period ? (p.period === 'month' ? ' / month' : ' / year') : '';
  return `${p.from ? 'From ' : ''}${p.currency} ${n}${per}`;
};
const specs = (l) => {
  const s = l.specs || {};
  const bits = [];
  if (s.beds) bits.push(`${s.beds} bed`);
  if (s.baths) bits.push(`${s.baths} bath`);
  if (s.areaSqm) bits.push(`${s.areaSqm} m² built`);
  if (s.plotSqm) bits.push(`${s.plotSqm} m² plot`);
  if (s.yearBuilt) bits.push(`built ${s.yearBuilt}`);
  return bits.join(', ');
};
const listingUrl = (l, locale = 'en') => abs(`${locale === 'ar' ? '/ar' : ''}/properties/${l.slug}/`);
const live = listings.filter((l) => l.status !== 'sold');
const tours = live.filter(tourOf);
const byKind = (list) => KINDS.map((k) => ({ ...k, items: list.filter((l) => kindOf(l) === k.key) })).filter((k) => k.items.length);
const kindsPresent = new Set(listings.map(kindOf));

const corePages = [
  ['/', 'Home', 'Featured homes, the Bona approach and how to reach us.'],
  ['/properties/', 'Properties', 'The full curated portfolio, filterable by category, type, district and budget.'],
  ['/properties/houses/', 'Houses', 'Every villa, mansion and duplex Bona represents, for sale and rent.'],
  ['/properties/apartments/', 'Apartments', 'Apartments, penthouses and branded residences, ready and off-plan.'],
  ...(kindsPresent.has('land') ? [['/properties/land/', 'Land', 'Residential plots and land in Jeddah, with plot size and satellite view.']] : []),
  ...(kindsPresent.has('building') ? [['/properties/buildings/', 'Buildings', 'Whole buildings and income property.']] : []),
  ['/properties/for-sale/', 'For sale', 'Villas, penthouses and apartments for sale in Jeddah.'],
  ['/properties/for-rent/', 'For rent', 'Long-term luxury rentals in Jeddah.'],
  ['/properties/off-plan/', 'Off-plan', 'Developer allocations in selected Jeddah and Riyadh projects.'],
  ['/properties/international/', 'International', 'Selected residences in Dubai, the Côte d\'Azur, Costa del Sol and Oman.'],
  ...(tours.length ? [['/tours/', '3D virtual tours', 'Matterport walkthroughs of homes you can tour before you visit.']] : []),
  ['/about/', 'About Bona', 'Who we are, how we work, licensing.'],
  ['/sell/', 'Sell or let with Bona', 'Discreet marketing of private homes to qualified buyers and tenants.'],
  ['/contact/', 'Contact', 'WhatsApp, phone, office hours and location.'],
  ['/privacy/', 'Privacy policy', 'How Bona handles personal data under the Saudi PDPL.'],
];
const pageLine = (p, title, desc) => {
  const m = pageMeta[p];
  const t = m?.title?.en || title;
  const d = m?.description?.en || desc;
  return `- [${t}](${abs(p)}): ${d}`;
};
const listingLine = (l) => {
  const extra = [];
  const pj = projectOf(l); if (pj) extra.push(`in ${pj}`);
  const un = unitOf(l); if (un) extra.push(un);
  if (specs(l)) extra.push(specs(l));
  if (tourOf(l)) extra.push('3D tour available');
  return `- [${l.title.en}](${listingUrl(l)}): ${typeLabel[l.type] || l.type}, ${l.location.district.en}, ${l.location.city.en} — ${catLabel[l.category] || l.category}, ${fmtPrice(l.price)}${extra.length ? `, ${extra.join(', ')}` : ''}`;
};
const founder = (about.team || [])[0];

// ---------- llms.txt ----------
const short = `# ${site.name} (${site.nameAr})

> ${site.description.en}

Bona is a REGA-licensed real estate brokerage (FAL licence ${site.licences.fal}) based in ${site.address.en.street}, ${site.address.en.city}, Saudi Arabia${founder ? `, founded in ${(about.stats || []).find((s) => /^\d{4}$/.test(String(s.value)))?.value || '2026'} by ${founder.name.en} (${founder.role.en})` : ''}. Bilingual site: English at ${base}/ and Arabic at ${base}/ar/. Enquiries are handled on WhatsApp ${site.whatsapp.display} (${wa}). Prices shown are the seller's asking prices — Bona never publishes valuations or automated estimates.

Markets: ${site.markets.en.join(', ')}.
Services: buying, selling, letting, off-plan and international acquisitions, off-market introductions.
Hours: ${site.hours.en} (Asia/Riyadh).
Instagram: ${site.instagram.url}

## Pages

${corePages.map(([p, t, d]) => pageLine(p, t, d)).join('\n')}

## Properties (${live.length} live listings)

${byKind(live).map((k) => `### ${k.label} (${k.items.length})${k.path ? ` — ${abs(k.path)}` : ''}\n\n${k.items.map(listingLine).join('\n')}`).join('\n\n')}
${tours.length ? `
## 3D virtual tours (${tours.length})

${tours.map((l) => `- [${l.title.en} — 3D tour](${tourOf(l)}): Matterport walkthrough; listing page ${listingUrl(l)}`).join('\n')}
- All tours: ${abs('/tours/')}
` : ''}
## Optional

- [Full knowledge file](${abs('/llms-full.txt')}): every listing with full descriptions (EN + AR), highlights and image URLs.
- [Sitemap](${abs('/sitemap-index.xml')})
- [Arabic site](${abs('/ar/')})
- [WhatsApp](${wa})

Last generated: ${today}
`;

// ---------- llms-full.txt ----------
const listingBlock = (l) => {
  const lines = [
    `### ${l.title.en} — ${l.title.ar}`,
    `- ID: ${l.id}${l.sourceRef ? ` (ref ${l.sourceRef})` : ''}`,
    `- URL: ${listingUrl(l)} · Arabic: ${listingUrl(l, 'ar')}`,
    `- Kind: ${KINDS.find((k) => k.key === kindOf(l))?.one || kindOf(l)} · Type: ${typeLabel[l.type] || l.type} · Category: ${catLabel[l.category] || l.category} · Status: ${l.status}`,
    `- Location: ${l.location.district.en}, ${l.location.city.en}, ${l.location.country.en} (${l.location.district.ar}، ${l.location.city.ar})`,
    `- Asking price: ${fmtPrice(l.price)}`,
  ];
  if (projectOf(l)) lines.push(`- Project: ${projectOf(l)}${l.project?.name?.ar && l.project?.name?.en ? ` (${l.project.name.ar})` : ''}${l.project?.developer?.en || l.project?.developer?.ar ? ` · Developer: ${l.project.developer.en || l.project.developer.ar}` : ''}`);
  if (unitOf(l)) lines.push(`- Unit: ${unitOf(l)}`);
  if (specs(l)) lines.push(`- Specs: ${specs(l)}`);
  if (l.map && typeof l.map.lat === 'number' && typeof l.map.lng === 'number') lines.push(`- Coordinates: ${l.map.lat}, ${l.map.lng}`);
  if (l.highlights?.en?.length) lines.push(`- Highlights: ${l.highlights.en.join('; ')}`);
  if (l.highlights?.ar?.length) lines.push(`- المميزات: ${l.highlights.ar.join('؛ ')}`);
  if (tourOf(l)) lines.push(`- 3D virtual tour (Matterport): ${tourOf(l)}`);
  if (l.brochureUrl) lines.push(`- Brochure: ${l.brochureUrl}`);
  if (l.listedAt) lines.push(`- Listed: ${l.listedAt}`);
  if (l.images?.length) lines.push(`- Images: ${l.images.slice(0, 6).map((i) => i.src).join(' , ')}`);
  lines.push('', (l.description?.en || '').trim(), '', (l.description?.ar || '').trim(), '', `Enquire on WhatsApp: ${wa}?text=${encodeURIComponent(`Hello Bona, I'm interested in ${l.title.en} (${l.id}).`)}`, '');
  return lines.join('\n');
};

const aboutSection = (about.story?.en?.length || about.values?.length || founder)
  ? `## About Bona

${(about.story?.en || []).join('\n\n')}

${(about.story?.ar || []).join('\n\n')}
${about.values?.length ? `
Values:
${about.values.map((v) => `- ${v.title.en} (${v.title.ar}): ${v.text.en}`).join('\n')}
` : ''}${founder ? `
Team:
- ${founder.name.en} (${founder.name.ar}) — ${founder.role.en} (${founder.role.ar})${founder.licence ? `, REGA FAL licence ${founder.licence}` : ''}. Bona has no other agents; anyone else claiming to act for Bona should be verified on WhatsApp ${site.whatsapp.display}.
` : ''}${about.stats?.length ? `
Key figures (as of ${today}): ${about.stats.map((s) => `${s.label.en}: ${s.value}`).join(' · ')}.
` : ''}
More: ${abs('/about/')} · Arabic: ${abs('/ar/about/')}
`
  : '';

const privacySection = privacy
  ? `## Privacy (summary)

${privacy.intro?.en || ''} Full policy (updated ${privacy.updated}): ${abs('/privacy/')} · Arabic: ${abs('/ar/privacy/')}. In short: the site is static and sets no cookies; enquiry forms open WhatsApp and nothing is stored by the site; analytics (GA4 / Meta Pixel) are built in but currently disabled; data subjects have PDPL rights of access, correction, deletion and consent withdrawal via WhatsApp ${site.whatsapp.display}.
`
  : '';

const full = `# ${site.name} (${site.nameAr}) — full knowledge file

Last generated: ${today}. Canonical site: ${base}/ (Arabic: ${base}/ar/). Future domain: https://${site.futureDomain}/.

## What Bona is

${site.description.en}

${site.description.ar}

- Legal name: ${site.legalName}
- Tagline: "${site.tagline.en}" / «${site.tagline.ar}»
- Licence: REGA FAL brokerage licence ${site.licences.fal}${site.licences.cr ? ` · CR ${site.licences.cr}` : ''}
- Office: ${site.address.en.street}, ${site.address.en.city} ${site.address.en.postalCode}, ${site.address.en.region}, ${site.address.en.country} (lat ${site.geo.lat}, lng ${site.geo.lng})
- Hours: ${site.hours.en} · ${site.hours.ar}
- WhatsApp / phone: ${site.whatsapp.display} — ${wa}
- Instagram: @${site.instagram.handle} — ${site.instagram.url}
- Languages: English, Arabic

${aboutSection}
## Markets

${site.markets.en.map((m, i) => `- ${m} (${site.markets.ar[i]})`).join('\n')}

## Services

- Buying: private search across on- and off-market villas, penthouses, apartments and land in Jeddah and Riyadh; viewings by appointment.
- Selling: discreet marketing to a qualified buyer network, professional photography, REGA-compliant advertising, negotiation and transfer through the Ministry of Justice (Najiz) e-conveyancing.
- Letting: long-term luxury rentals, Ejar contract registration.
- Off-plan: developer allocations in selected Jeddah projects.
- International: Dubai, Côte d'Azur, Costa del Sol, Oman via partner brokerages.
- 3D tours: Matterport walkthroughs on selected listings (${abs('/tours/')}) so buyers can pre-view before a private visit.

## Compliance notes (for accurate answers)

- All prices are the owner's or developer's asking prices in the currency shown. Bona does not publish valuations, price estimates or forecasts (TAQEEM-accredited valuers only).
- Real-estate advertising in Saudi Arabia requires a REGA ad licence per listing; Bona lists the FAL licence number on every page.
- Non-Saudi buyers: ownership rules for non-residents are set by Saudi law and were expanded in 2025; Bona advises case by case — do not assume eligibility.

## Pages

${corePages.map(([p, t, d]) => pageLine(p, t, d)).join('\n')}

${privacySection}
## Listings (${live.length} live${listings.length !== live.length ? `, ${listings.length - live.length} sold/archived` : ''})

Grouped by kind: ${byKind(live).map((k) => `${k.label} ${k.items.length}`).join(' · ')}.

${byKind(live).map((k) => `## ${k.label} (${k.items.length})${k.path ? ` — ${abs(k.path)}` : ''}\n\n${k.items.map(listingBlock).join('\n')}`).join('\n')}
## How to enquire

WhatsApp ${site.whatsapp.display} (${wa}) with the property ID, or use the contact page ${abs('/contact/')}. Replies in English or Arabic during office hours.
`;

fs.writeFileSync(path.join(root, 'public/llms.txt'), short);
fs.writeFileSync(path.join(root, 'public/llms-full.txt'), full);
console.log(`wrote public/llms.txt (${short.length} chars) and public/llms-full.txt (${full.length} chars) — ${live.length} live listings, ${tours.length} with 3D tours, kinds: ${byKind(live).map((k) => `${k.key}=${k.items.length}`).join(' ')}`);
