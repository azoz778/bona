// The visual layer shared by reels, carousels and stories: scrims, the wordmark lockup,
// the property lower-third, and the CTA card. Everything here returns a PNG buffer.
//
// Design brief: quiet luxury. Ivory / ink / champagne from src/styles/global.css, Cormorant
// for Latin display, Amiri for Arabic display, Plex Arabic and Montserrat for text. Arabic
// is the primary reading line on every asset and is right-aligned; English sits under it,
// smaller and letterspaced. Nothing shouts.
import {
  C, SAFE, centred, fitText, hasArabic, iso, rect, rightOf, rule, scrim, shadowOf, sharp, text, wordmark,
} from './brand.mjs';
import {
  AD_LICENCE_TOKEN, FAL, WA_DISPLAY, adLicence, cityLabel, districtLabel, hasPrice, placeLabel,
  priceText, site, specChips, t, typeLabel,
} from './listing.mjs';

const TRANSPARENT = '#00000000';

/** A blank RGBA canvas. */
export const canvas = (w, h, bg = TRANSPARENT) =>
  sharp({ create: { width: w, height: h, channels: 4, background: bg } });

/**
 * Stack `items` ({data,width,height} plus optional gapBefore) right-aligned inside a box.
 * Pure geometry — call it once to measure, once to place.
 */
function stackRight(items, { w, right, top, gap = 18 }) {
  const layers = [];
  let y = top;
  for (const it of items) {
    if (!it) continue;
    y += it.gapBefore ?? 0;
    layers.push(rightOf(it, w, y, right));
    y += it.height + gap;
  }
  return { layers, bottom: y - gap };
}

/**
 * The same stack, with a soft shadow behind every text block so the type survives whatever
 * the photograph puts underneath it. Rules and hairlines are skipped — a blurred shadow
 * under a 2 px line just looks like dirt.
 */
async function stackRightShadowed(items, opts, { blur = 12, opacity = 0.8, dy = 2 } = {}) {
  const { layers, bottom } = stackRight(items, opts);
  const out = [];
  for (const [i, layer] of layers.entries()) {
    const item = items.filter(Boolean)[i];
    if (item && item.height > 6) {
      out.push({ input: await shadowOf(item, { blur, opacity }), top: layer.top + dy, left: layer.left });
    }
    out.push(layer);
  }
  return { layers: out, bottom };
}

// ---------- scrims ----------
export const topScrim = (w, h, depth = 0.32, strength = 0.78) =>
  scrim(w, Math.round(h * depth), [[0, `rgba(15,18,20,${strength})`], [0.55, `rgba(15,18,20,${strength * 0.42})`], [1, 'rgba(15,18,20,0)']]);

export const bottomScrim = (w, h, depth = 0.55, strength = 0.95) =>
  scrim(w, Math.round(h * depth), [[0, 'rgba(15,18,20,0)'], [0.38, `rgba(15,18,20,${strength * 0.68})`], [1, `rgba(15,18,20,${strength})`]]);

// ---------- wordmark strip ----------
/** The small BONA lockup that sits at the top of every vertical asset. */
export async function markLayer(w, h, { size = 40, top = 92, arabic = false, color = C.ivory } = {}) {
  const mark = await wordmark({ size, color, arabic });
  const place = centred(mark, w, top);
  // The wordmark sits over whatever the top of the photograph happens to be. On a bright sky
  // an ivory wordmark all but disappears, so it gets the same glyph shadow as the copy.
  const sh = { input: await shadowOf(mark, { blur: 10, opacity: 0.7 }), top: place.top + 2, left: place.left };
  return canvas(w, h).composite([sh, place]).png().toBuffer();
}

// ---------- hook ----------
/**
 * The first thing a thumb sees: one Arabic line, one English line, on a top scrim.
 * @param {{ar:string,en:string}} hook
 */
export async function hookLayer(w, h, hook, { top = 300, right = SAFE.left, arSize = 88, enSize = 38 } = {}) {
  const boxW = w - right - SAFE.left;
  const sc = await topScrim(w, h, 0.46, 0.86);
  const ar = await fitText(
    { text: hook.ar, face: 'ar-display', size: arSize, color: C.ivory, width: boxW, align: 'right', lineHeight: 1.28 },
    { maxHeight: arSize * 2.9, minSize: 46 },
  );
  const hr = { data: await rule(Math.round(boxW * 0.22), 3, C.champagne), width: Math.round(boxW * 0.22), height: 3, gapBefore: 10 };
  const en = await fitText(
    { text: hook.en, face: 'en-display', size: enSize, color: C.ivory2, width: boxW, align: 'right', dir: 'ltr', lineHeight: 1.25 },
    { maxHeight: enSize * 2.6, minSize: 24 },
  );
  en.gapBefore = 8;
  const { layers } = await stackRightShadowed([ar, hr, en], { w, right, top, gap: 16 }, { blur: 16, opacity: 0.85 });
  return canvas(w, h).composite([{ input: sc, top: 0, left: 0 }, ...layers]).png().toBuffer();
}

// ---------- property lower third ----------
/**
 * Price / kind / district, plus the ref. Sits above the platform's own chrome: the block is
 * inset from the right so Instagram's and TikTok's action rails cannot cover it.
 */
export async function lowerThird(w, h, l, { bottom = SAFE.bottom, right = 170, withTitle = true } = {}) {
  const boxW = w - right - SAFE.left;
  const sc = await bottomScrim(w, h, 0.58, 0.95);
  const items = [];

  const kindLine = `${typeLabel(l, 'ar')} · ${placeLabel(l, 'ar')}`;
  const kind = await fitText(
    { text: kindLine, face: 'ar-body', size: 36, color: C.champagne2, width: boxW, align: 'right', letterSpacing: 0.5 },
    { maxHeight: 92, minSize: 24 },
  );
  items.push(kind);

  if (withTitle) {
    const title = await fitText(
      { text: t(l.title, 'ar'), face: 'ar-display', size: 58, color: C.ivory, width: boxW, align: 'right', lineHeight: 1.22 },
      { maxHeight: 150, minSize: 36 },
    );
    title.gapBefore = 2;
    items.push(title);
  }

  const chips = specChips(l, 'ar');
  if (chips.length) {
    const sp = await fitText(
      { text: chips.join('  ·  '), face: 'ar-body', size: 33, color: C.sand, width: boxW, align: 'right' },
      { maxHeight: 86, minSize: 22 },
    );
    sp.gapBefore = 4;
    items.push(sp);
  }

  const hr = { data: await rule(Math.round(boxW * 0.30), 2, 'rgba(200,169,106,0.75)'), width: Math.round(boxW * 0.30), height: 2, gapBefore: 12 };
  items.push(hr);

  // TAQEEM: priceText() is the only source of this string and never invents a number.
  const price = await fitText(
    { text: priceText(l, 'ar'), face: hasPrice(l) ? 'ar-display' : 'ar-body', size: hasPrice(l) ? 56 : 44, color: C.ivory, width: boxW, align: 'right' },
    { maxHeight: 90, minSize: 30 },
  );
  price.gapBefore = 10;
  items.push(price);

  const enLine = `${typeLabel(l, 'en')} · ${placeLabel(l, 'en')} · ${priceText(l, 'en')}`;
  const en = await fitText(
    { text: enLine, face: 'en-body', size: 26, color: C.sand, width: boxW, align: 'right', dir: 'ltr', letterSpacing: 1.1 },
    { maxHeight: 74, minSize: 18 },
  );
  en.gapBefore = 8;
  items.push(en);

  const ref = await text({ text: `${l.id}  ·  ${WA_DISPLAY}`, face: 'en-body', size: 24, color: 'rgba(217,208,193,0.82)', dir: 'ltr', letterSpacing: 1.6 });
  ref.gapBefore = 10;
  items.push(ref);

  // Measure, then lay the stack out so its LAST line lands on the safe-area line.
  const probe = stackRight(items, { w, right, top: 0, gap: 14 });
  const top = h - bottom - probe.bottom;
  const { layers } = await stackRightShadowed(items, { w, right, top, gap: 14 }, { blur: 12, opacity: 0.8 });
  return canvas(w, h).composite([{ input: sc, top: h - Math.round(h * 0.58), left: 0 }, ...layers]).png().toBuffer();
}

// ---------- CTA ----------
/**
 * The closing card. Carries the advertising basis for the listing (adLicence(): the REGA
 * per-ad licence number, the {{AD_LICENCE}} placeholder while none is recorded, or the
 * developer-authorisation line for property outside the Kingdom) plus the FAL brokerage
 * licence, which is a real number.
 */
export async function ctaCard(w, h, { l = null, lines = null, bg = C.ivory, fg = C.ink } = {}) {
  const boxW = w - SAFE.left * 2;
  const mark = await wordmark({ size: 108, color: fg, accent: C.champagne, arabic: true });
  const tagAr = await text({ text: site.tagline.ar, face: 'ar-display', size: 50, color: C.stone2, align: 'centre', width: boxW });
  const tagEn = await text({ text: site.tagline.en, face: 'en-display', size: 38, color: C.stone, align: 'centre', width: boxW, dir: 'ltr' });
  const hr = await rule(Math.round(boxW * 0.34), 2, C.champagne);

  const body = lines ?? [
    { text: 'للاستفسار — واتساب', face: 'ar-body', size: 36, color: C.stone2 },
    { text: WA_DISPLAY, face: 'en-display', size: 68, color: fg, dir: 'ltr', letterSpacing: 1.5 },
    { text: site.futureDomain || 'bona-real-estate.com', face: 'en-body', size: 30, color: C.stone, dir: 'ltr', letterSpacing: 3 },
  ];
  const rendered = [];
  for (const b of body) rendered.push(await text({ align: 'centre', width: boxW, ...b }));

  const lic = l ? adLicence(l) : { basis: 'rega-pending', number: null };
  const foreign = lic.basis === 'developer-authorisation';
  const licAr = await text({ text: foreign ? 'عقار خارج المملكة — يُسوَّق بتفويض من المطوّر' : `رقم ترخيص الإعلان العقاري: ${iso(lic.number ?? AD_LICENCE_TOKEN)}`, face: 'ar-body', size: 26, color: C.stone, align: 'centre', width: boxW });
  const licEn = await text({ text: foreign ? `Marketed under developer authorisation  ·  FAL ${FAL}` : `REGA ad licence ${lic.number ?? AD_LICENCE_TOKEN}  ·  FAL ${FAL}`, face: 'en-body', size: 24, color: C.stone, align: 'centre', width: boxW, dir: 'ltr', letterSpacing: 1.2 });
  const ref = l ? await text({ text: `${l.id}`, face: 'en-body', size: 26, color: C.champagne, align: 'centre', width: boxW, dir: 'ltr', letterSpacing: 4 }) : null;

  const blocks = [
    { img: mark, gap: 44 },
    { img: tagAr, gap: 12 },
    { img: tagEn, gap: 44 },
    { img: { data: hr, width: Math.round(boxW * 0.34), height: 2 }, gap: 46 },
    ...rendered.map((r, i) => ({ img: r, gap: i === rendered.length - 1 ? 54 : 16 })),
    ...(ref ? [{ img: ref, gap: 40 }] : []),
    { img: licAr, gap: 10 },
    { img: licEn, gap: 0 },
  ];
  const total = blocks.reduce((a, b) => a + b.img.height + b.gap, 0);
  let y = Math.round((h - total) / 2);
  const layers = [];
  for (const b of blocks) { layers.push(centred(b.img, w, y)); y += b.img.height + b.gap; }

  // A hairline frame, the same device as og-default.png.
  const frame = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="46" y="46" width="${w - 92}" height="${h - 92}" fill="none" stroke="${C.champagne}" stroke-opacity="0.5" stroke-width="1.5"/></svg>`,
  );
  return canvas(w, h, bg).composite([{ input: frame, top: 0, left: 0 }, ...layers]).png().toBuffer();
}

// ---------- generic caption band (carousel feature slides / stories) ----------
/**
 * A band across the bottom of a photo carrying one Arabic line and one English line.
 * Used for a carousel feature slide and for editorial story cards, where there is no
 * property lower-third and therefore no price.
 */
export async function captionBand(w, h, { ar, en, eyebrow = null, right = SAFE.left, bottom = 110, arSize = 56, enSize = 30 }) {
  const boxW = w - right - SAFE.left;
  const sc = await bottomScrim(w, h, 0.52, 0.94);
  const items = [];
  if (eyebrow) {
    // A pure-Latin eyebrow (a "1 / 3" slide counter) must not be laid out RTL — bidi would
    // render it "3 / 1" and silently reverse its meaning.
    const ar = hasArabic(eyebrow);
    const e = await text({
      text: eyebrow, face: ar ? 'ar-body' : 'en-body', size: 30, color: C.champagne2,
      align: 'right', dir: ar ? 'rtl' : 'ltr', width: boxW, letterSpacing: ar ? 0.6 : 2,
    });
    items.push(e);
  }
  const a = await fitText({ text: ar, face: 'ar-display', size: arSize, color: C.ivory, width: boxW, align: 'right', lineHeight: 1.3 }, { maxHeight: arSize * 4, minSize: 32 });
  a.gapBefore = eyebrow ? 6 : 0;
  items.push(a);
  const hr = { data: await rule(Math.round(boxW * 0.20), 2, C.champagne), width: Math.round(boxW * 0.20), height: 2, gapBefore: 14 };
  items.push(hr);
  const b = await fitText({ text: en, face: 'en-display', size: enSize, color: C.sand, width: boxW, align: 'right', dir: 'ltr', lineHeight: 1.3 }, { maxHeight: enSize * 4, minSize: 20 });
  b.gapBefore = 6;
  items.push(b);
  const probe = stackRight(items, { w, right, top: 0, gap: 14 });
  const { layers } = await stackRightShadowed(items, { w, right, top: h - bottom - probe.bottom, gap: 14 }, { blur: 14, opacity: 0.82 });
  return canvas(w, h).composite([{ input: sc, top: h - Math.round(h * 0.52), left: 0 }, ...layers]).png().toBuffer();
}

/** Small helper: flatten a photo + a list of RGBA layers into a JPEG/PNG slide. */
export async function flatten(photoBuf, layers, { w, h, format = 'png', quality = 92 }) {
  const img = sharp(photoBuf).resize(w, h, { fit: 'cover' }).composite(layers.map((input) => ({ input, top: 0, left: 0 })));
  return format === 'jpg' ? img.jpeg({ quality, mozjpeg: true }).toBuffer() : img.png().toBuffer();
}

export { SAFE, C };

// ---------- editorial ----------
/**
 * A typographic card for a post that promotes no property: brand, education, market fact.
 * Deliberately not a photograph with words on it — in a feed of property photos an ink card
 * with one line on it is the thing that stops the thumb, and it cannot be mistaken for an
 * advert for a specific home (which would need a REGA licence it does not have).
 */
export async function editorialCard(w, h, { eyebrow, ar, en, footer = null, bg = C.ink, fg = C.ivory } = {}) {
  const boxW = w - SAFE.left * 2;
  const mark = await wordmark({ size: Math.round(h * 0.032), color: fg, accent: C.champagne, arabic: false });
  const eb = eyebrow
    ? await text({ text: eyebrow, face: 'ar-body', size: Math.round(h * 0.022), color: C.champagne2, align: 'centre', width: boxW, letterSpacing: 1 })
    : null;
  const head = await fitText(
    { text: ar, face: 'ar-display', size: Math.round(h * 0.062), color: fg, width: boxW, align: 'centre', lineHeight: 1.35 },
    { maxHeight: h * 0.34, minSize: 40 },
  );
  const hr = await rule(Math.round(boxW * 0.22), 2, C.champagne);
  const sub = await fitText(
    { text: en, face: 'en-display', size: Math.round(h * 0.032), color: C.sand, width: boxW, align: 'centre', dir: 'ltr', lineHeight: 1.35 },
    { maxHeight: h * 0.20, minSize: 22 },
  );
  const foot = await text({
    text: footer ?? `${site.futureDomain || 'bona-real-estate.com'}  ·  ${WA_DISPLAY}`,
    face: 'en-body', size: Math.round(h * 0.016), color: C.stone, align: 'centre', width: boxW, dir: 'ltr', letterSpacing: 2,
  });

  const blocks = [
    ...(eb ? [{ img: eb, gap: Math.round(h * 0.03) }] : []),
    { img: head, gap: Math.round(h * 0.035) },
    { img: { data: hr, width: Math.round(boxW * 0.22), height: 2 }, gap: Math.round(h * 0.032) },
    { img: sub, gap: 0 },
  ];
  const total = blocks.reduce((a, b) => a + b.img.height + b.gap, 0);
  let y = Math.round((h - total) / 2);
  const layers = [centred(mark, w, Math.round(h * 0.075))];
  for (const b of blocks) { layers.push(centred(b.img, w, y)); y += b.img.height + b.gap; }
  layers.push(centred(foot, w, h - Math.round(h * 0.075)));

  const frame = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="46" y="46" width="${w - 92}" height="${h - 92}" fill="none" stroke="${C.champagne}" stroke-opacity="0.38" stroke-width="1.5"/></svg>`,
  );
  return canvas(w, h, bg).composite([{ input: frame, top: 0, left: 0 }, ...layers]).png().toBuffer();
}
