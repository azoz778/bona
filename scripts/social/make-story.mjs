#!/usr/bin/env node
// Static 1080x1920 story cards.
//
//   node scripts/social/make-story.mjs --listing BONA-001 --kind new
//   node scripts/social/make-story.mjs --listing BONA-004 --kind price
//   node scripts/social/make-story.mjs --listing BONA-012 --kind sold
//   node scripts/social/make-story.mjs --district "Al Khalidiyah" --kind district
//
// Kinds:
//   new       a listing arrives                       (REGA ad licence required)
//   price     the printed asking price has changed    (REGA ad licence required)
//   sold      a listing is off the market             (REGA ad licence required)
//   district  a district spotlight, no property named (editorial — no licence)
//
// `price` prints ONLY the asking price currently in listings.json. It deliberately prints no
// "was" figure: listings.json holds no price history, and a previous price typed on the
// command line is a number with no source — exactly the thing TAQEEM exists to stop. If a
// struck-through "was" is ever wanted, it has to come from a real field in listings.json and
// go through priceText() like every other price.
// `sold` refuses a listing whose status is not "sold" unless --confirm-sold is given.
import './lib/fonts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { C, SAFE, STORY, centred, fitText, iso, rule, sharp, text, wordmark } from './lib/brand.mjs';
import { canvas, captionBand, ctaCard, editorialCard, flatten, lowerThird, markLayer } from './lib/cards.mjs';
import { bestPhotos, cover } from './lib/photos.mjs';
import {
  AD_LICENCE_TOKEN, WA_DISPLAY, adLicence, districtLabel, hasPrice, listingUrl, loadListings, placeLabel,
  priceText, t, typeLabel,
} from './lib/listing.mjs';
import { byId, districtNote } from './lib/editorial.mjs';
import { OUT_ROOT, ensureDir, findListing, log, savePair } from './lib/util.mjs';

const { values: a } = parseArgs({
  options: {
    listing: { type: 'string' }, district: { type: 'string' }, kind: { type: 'string', default: 'new' },
    editorial: { type: 'string' }, ratio: { type: 'string', default: '9:16' },
    out: { type: 'string' }, 'confirm-sold': { type: 'boolean', default: false },
    centre: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (a.help || (!a.listing && !a.district && !a.editorial)) {
  console.log(`usage: make-story.mjs (--listing <ID|slug> | --district <name> | --editorial <key>)
                    [--kind new|price|sold|district] [--ratio 9:16|4:5|1:1]
                    [--out <file.png>] [--centre] [--confirm-sold]`);
  process.exit(a.help ? 0 : 1);
}

const RATIO = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080] };
const [W, H] = RATIO[a.ratio] ?? RATIO['9:16'];
const position = a.centre ? 'centre' : 'attention';
// A story carries far less platform chrome than a reel: only the reply bar and the
// profile row, so the content can sit lower than SAFE.bottom allows in-feed.
const STORY_BOTTOM = 300;

const EYEBROW = {
  new: { ar: 'جديد لدى بونا', en: 'New with Bona' },
  price: { ar: 'سعر محدَّث', en: 'Updated price' },
  sold: { ar: 'تم البيع', en: 'Sold' },
  district: { ar: 'دليل الأحياء', en: 'District guide' },
};

async function storyForListing(l, kind) {
  if (kind === 'sold' && l.status !== 'sold' && !a['confirm-sold']) {
    throw new Error(`${l.id} is "${l.status}" in listings.json — pass --confirm-sold to stamp it Sold anyway.`);
  }
  if (kind === 'price' && !hasPrice(l)) {
    throw new Error(`${l.id} prints no price (TAQEEM: we never estimate one). Use --kind new instead.`);
  }
  const photos = await bestPhotos(l, 1);
  if (!photos.length) throw new Error(`${l.id}: no usable photograph`);
  const photo = await cover(photos[0].file, W, H, { position });

  const layers = [];
  layers.push(await markLayer(W, H, { size: 40, top: 96 }));

  // Eyebrow badge, top-centre under the wordmark.
  const eb = EYEBROW[kind] ?? EYEBROW.new;
  const badgeAr = await text({ text: eb.ar, face: 'ar-body', size: 34, color: C.ink, letterSpacing: 0.5 });
  const padX = 34;
  const padY = 16;
  const bw = badgeAr.width + padX * 2;
  const bh = badgeAr.height + padY * 2;
  const badge = await canvas(bw, bh, kind === 'sold' ? C.ink : C.champagne2)
    .composite([{ input: badgeAr.data, top: padY, left: padX }]).png().toBuffer();
  const badgeAsInk = kind === 'sold'
    ? await canvas(bw, bh, C.ink).composite([{ input: (await text({ text: eb.ar, face: 'ar-body', size: 34, color: C.ivory, letterSpacing: 0.5 })).data, top: padY, left: padX }]).png().toBuffer()
    : badge;
  layers.push(await canvas(W, H).composite([{ input: badgeAsInk, top: 250, left: Math.round((W - bw) / 2) }]).png().toBuffer());

  // The lower third is the ONLY source of a price on this card, and priceText() is the only
  // source of that string. A "price" story therefore says "سعر محدَّث / Updated price" and
  // shows the figure listings.json currently holds — never a figure it used to hold, which
  // we do not have.
  layers.push(await lowerThird(W, H, l, { bottom: STORY_BOTTOM, right: 140 }));

  // The licence line every property story needs, small, at the very bottom of the safe area:
  // the REGA number (placeholder until recorded), or the developer line outside the Kingdom.
  const basis = adLicence(l);
  const lic = await text({
    text: basis.basis === 'developer-authorisation'
      ? 'عقار خارج المملكة — يُسوَّق بتفويض من المطوّر'
      : `ترخيص الإعلان العقاري ${iso(basis.number ?? AD_LICENCE_TOKEN)}`,
    face: 'ar-body', size: 24, color: 'rgba(245,241,234,0.74)',
  });
  layers.push(await canvas(W, H).composite([centred(lic, W, H - 116)]).png().toBuffer());

  return flatten(photo, layers, { w: W, h: H });
}

async function storyForDistrict(name) {
  const listings = loadListings();
  const inDistrict = listings.filter((l) => `${districtLabel(l, 'en')} ${districtLabel(l, 'ar')}`.toLowerCase().includes(String(name).toLowerCase()));
  if (!inDistrict.length) throw new Error(`no listing sits in a district matching "${name}"`);
  const ref = inDistrict[0];
  const photos = await bestPhotos(ref, 1);
  if (!photos.length) throw new Error(`no usable photograph for district "${name}"`);
  const photo = await cover(photos[0].file, W, H, { position });

  const kinds = new Set(inDistrict.map((l) => typeLabel(l, 'ar')));
  const layers = [];
  layers.push(await markLayer(W, H, { size: 40, top: 96 }));
  // Editorial: the district, what Bona represents there, and NOT a single identifying
  // property fact — no ref, no price, no address. That keeps it outside the REGA ad rule.
  const note = districtNote(districtLabel(ref, 'en'));
  layers.push(await captionBand(W, H, {
    eyebrow: 'دليل الأحياء · District guide',
    ar: `${districtLabel(ref, 'ar')}\n${note ? note.ar : [...kinds].slice(0, 3).join(' · ') + ' ضمن محفظتنا'}`,
    en: `${districtLabel(ref, 'en')} — ${note ? note.en : `${inDistrict.length} ${inDistrict.length === 1 ? 'home' : 'homes'} in our portfolio`}`,
    bottom: STORY_BOTTOM - 40,
    arSize: 58,
  }));
  const ask = await text({ text: `اسألنا عن ${districtLabel(ref, 'ar')} — ${iso(WA_DISPLAY)}`, face: 'ar-body', size: 28, color: 'rgba(245,241,234,0.82)' });
  layers.push(await canvas(W, H).composite([centred(ask, W, H - 126)]).png().toBuffer());
  return flatten(photo, layers, { w: W, h: H });
}

const kind = String(a.kind || 'new');
let buf;
let name;
if (a.editorial) {
  // Editorial: brand / education / market. No property is named, so no REGA ad licence.
  const e = byId(a.editorial);
  if (!e) { console.error(`no editorial item "${a.editorial}"`); process.exit(1); }
  const PILLAR = { brand: 'بونا', education: 'معلومة عقارية', market: 'من السوق' };
  buf = await editorialCard(W, H, { eyebrow: PILLAR[e.pillar] ?? 'بونا', ar: e.ar, en: e.en });
  name = `editorial-${e.id}${a.ratio === '9:16' ? '' : `-${a.ratio.replace(':', 'x')}`}.png`;
} else if (a.district || kind === 'district') {
  const d = a.district || districtLabel(findListing(loadListings(), a.listing), 'en');
  buf = await storyForDistrict(d);
  name = `story-district-${String(d).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`;
} else {
  const l = findListing(loadListings(), a.listing);
  buf = await storyForListing(l, kind);
  name = `story-${kind}-${l.id}.png`;
}

const out = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'stories', name);
ensureDir(path.dirname(out));
await savePair(out, buf, sharp);
log(`story → ${out}`);
console.log(out);
