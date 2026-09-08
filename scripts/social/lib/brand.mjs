// Bona's design system for social assets, and the Arabic-safe text renderer everything uses.
//
// Colours and type mirror src/styles/global.css and scripts/og/gen-assets.mjs so a reel, a
// carousel slide and the website look like one brand.
import './fonts.mjs'; // MUST be first: sets FONTCONFIG_FILE before libvips touches Pango
import { AR_BODY_STACK, AR_STACK, EN_STACK, FONTS } from './fonts.mjs';

const sharp = (await import('sharp')).default;
sharp.cache(false); // these scripts stream a lot of large stills; keep RSS flat

export { sharp };

// ---------- palette (src/styles/global.css) ----------
export const C = {
  ivory: '#f5f1ea',
  ivory2: '#ede7dc',
  sand: '#d9d0c1',
  stone: '#6f6a62',
  stone2: '#5f5a53',
  ink: '#0f1214',
  ink2: '#1b1f22',
  ink3: '#2a2f33',
  champagne: '#c8a96a',
  champagne2: '#e2c98f',
};

// ---------- canvases ----------
export const REEL = { w: 1080, h: 1920 };
export const STORY = { w: 1080, h: 1920 };
export const PORTRAIT = { w: 1080, h: 1350 }; // Instagram 4:5 — the biggest feed footprint
export const SQUARE = { w: 1080, h: 1080 };

/**
 * Safe areas, in px, for a 1080x1920 vertical asset. The union of what Instagram Reels,
 * TikTok and YouTube Shorts paint their own chrome over: TikTok's caption block is the
 * deepest bottom (~320) and Reels' action rail the widest right (~180).
 */
export const SAFE = { top: 180, bottom: 430, left: 90, right: 190 };

// ---------- Pango helpers ----------
/** Escape for Pango markup. */
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Force a right-to-left base direction (U+200F RLM is a strong RTL character). */
export const rtl = (s) => `‏${s}`;
/** Force a left-to-right base direction. */
export const ltr = (s) => `‎${s}`;
/**
 * Isolate a Latin/numeric run inside Arabic (U+2066 LRI … U+2069 PDI) so bidi cannot
 * reorder it against the neighbouring punctuation. Without this, "537 m²" and
 * "8,000,000 SAR" land in the wrong order inside an RTL line.
 */
export const iso = (s) => `⁦${s}⁩`;
/** True when the string contains any Arabic-script character. */
export const hasArabic = (s) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(String(s ?? ''));

const FAMILY = {
  'ar-display': AR_STACK,
  'ar-body': AR_BODY_STACK,
  'en-display': EN_STACK,
  'en-body': `${FONTS.enBody},${FONTS.enDisplay}`,
};

const WEIGHT = { 'ar-display': 'bold', 'ar-body': 'normal', 'en-display': 'semibold', 'en-body': 'normal' };

/**
 * Pango's `foreground` takes #rrggbb or a colour name — never `rgba()`, which it rejects
 * outright ("invalid markup in text"). Split any rgba() into a hex colour plus an alpha the
 * caller folds into the span's `alpha` attribute.
 * @returns {{hex:string, alpha:number}}
 */
export function splitColor(c) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(String(c).trim());
  if (!m) return { hex: String(c), alpha: 1 };
  const hex = '#' + [m[1], m[2], m[3]].map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')).join('');
  const alpha = m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4])));
  return { hex, alpha };
}

/**
 * Render one text block to a transparent RGBA PNG through Pango — the ONLY way Arabic
 * enters an asset. Never hand Arabic to ffmpeg's drawtext.
 *
 * @param {object} o
 * @param {string} o.text           plain text (escaped here; do not pre-escape)
 * @param {'ar-display'|'ar-body'|'en-display'|'en-body'} [o.face]
 * @param {number} o.size           px (dpi is pinned to 72, so 1pt == 1px)
 * @param {string} [o.color]
 * @param {number} [o.width]        wrap width in px; omit for a single unwrapped line
 * @param {'left'|'centre'|'right'} [o.align]
 * @param {'rtl'|'ltr'} [o.dir]
 * @param {number} [o.letterSpacing] px between glyphs
 * @param {number} [o.lineHeight]   multiple of size (e.g. 1.35)
 * @param {number} [o.weight]       Pango weight override (100..900 or a keyword)
 * @param {number} [o.opacity]      0..1
 * @returns {Promise<{data:Buffer,width:number,height:number}>}
 */
export async function text({
  text: body, face = 'en-body', size, color = C.ivory, width, align, dir, letterSpacing = 0, lineHeight, weight, opacity = 1,
}) {
  const family = FAMILY[face] ?? FAMILY['en-body'];
  const w = weight ?? WEIGHT[face] ?? 'normal';
  const isAr = face.startsWith('ar');
  const direction = dir ?? (isAr ? 'rtl' : 'ltr');
  const alignment = align ?? (direction === 'rtl' ? 'right' : 'left');
  let payload = direction === 'rtl' ? rtl(body) : ltr(body);
  const { hex, alpha } = splitColor(color);
  const a = Math.max(0, Math.min(1, alpha * opacity));
  const attrs = [
    `font_desc="${esc(`${family} ${w} ${Math.round(size)}`)}"`,
    `foreground="${hex}"`,
  ];
  // Pango measures letter_spacing and line_height in 1024ths of a point.
  if (letterSpacing) attrs.push(`letter_spacing="${Math.round(letterSpacing * 1024)}"`);
  if (lineHeight) attrs.push(`line_height="${lineHeight}"`);
  if (a < 1) attrs.push(`alpha="${Math.max(1, Math.round(a * 65535))}"`);
  const markup = `<span ${attrs.join(' ')}>${esc(payload)}</span>`;
  const opts = { text: markup, font: `${FONTS.enBody} ${Math.round(size)}`, rgba: true, dpi: 72, align: alignment };
  if (width) opts.width = Math.round(width);
  const img = sharp({ text: opts });
  const data = await img.png().toBuffer();
  const meta = await sharp(data).metadata();
  return { data, width: meta.width, height: meta.height };
}

/**
 * Render `body` at the largest size <= `size` that fits inside `width` x `maxHeight`.
 * Arabic and English of the same sentence are never the same length, so every headline in
 * these assets is fitted rather than assumed.
 */
export async function fitText(o, { maxHeight = Infinity, minSize = 18, step = 0.92 } = {}) {
  let size = o.size;
  let out = await text({ ...o, size });
  while ((out.height > maxHeight || (o.width && out.width > o.width + 2)) && size > minSize) {
    size = Math.max(minSize, Math.floor(size * step));
    out = await text({ ...o, size });
  }
  return { ...out, size };
}

// ---------- primitives ----------
/** A flat RGBA rectangle. */
export const rect = (w, h, fill) =>
  sharp({ create: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), channels: 4, background: fill } }).png().toBuffer();

/**
 * A soft dark shadow shaped like the glyphs of a rendered text block.
 *
 * A gradient scrim alone cannot guarantee contrast: a hook line lands wherever the
 * photograph happens to be, and ivory type over a lit window or a white wall is unreadable.
 * A scrim heavy enough to fix that would grey out the property. A shadow travels with the
 * letterforms instead, so it costs nothing visually on a dark frame and saves a bright one.
 *
 * @param {{data:Buffer,width:number,height:number}} img a block returned by text()/fitText()
 */
export async function shadowOf(img, { blur = 12, opacity = 0.8 } = {}) {
  const { data, info } = await sharp(img.data)
    .ensureAlpha()
    .extractChannel('alpha')
    .linear(opacity, 0)          // the silhouette IS the text's alpha, dimmed
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: info.width, height: info.height, channels: 3, background: '#050708' } })
    .joinChannel(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .blur(blur)
    .png()
    .toBuffer();
}

/** Hairline rule, champagne by default. */
export const rule = (w, h = 2, fill = C.champagne) => rect(w, h, fill);

/**
 * A vertical gradient scrim: `stops` is [[offset0..1, 'rgba(...)'], ...].
 * Keeps text legible over a photograph without dimming the whole frame.
 */
export async function scrim(w, h, stops, { direction = 'down' } = {}) {
  const s = stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  const [x1, y1, x2, y2] = direction === 'down' ? [0, 0, 0, 1] : direction === 'up' ? [0, 1, 0, 0] : [0, 0, 1, 0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${s}</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * The Bona wordmark: BONA in Cormorant, a champagne rule, and بونا beneath it.
 * @returns {Promise<{data:Buffer,width:number,height:number}>}
 */
export async function wordmark({ size = 54, color = C.ivory, accent = C.champagne, arabic = true, tracking = 0.24 } = {}) {
  const en = await text({ text: 'BONA', face: 'en-display', size, color, letterSpacing: size * tracking, dir: 'ltr' });
  const ar = arabic ? await text({ text: 'بونا', face: 'ar-display', size: size * 0.62, color, dir: 'rtl' }) : null;
  const ruleW = Math.round(size * 1.5);
  const ruleImg = await rule(ruleW, Math.max(1, Math.round(size * 0.035)), accent);
  const gap = Math.round(size * 0.28);
  const w = Math.max(en.width, ar?.width ?? 0, ruleW);
  const h = en.height + gap + Math.max(1, Math.round(size * 0.035)) + (ar ? gap + ar.height : 0);
  const layers = [{ input: en.data, top: 0, left: Math.round((w - en.width) / 2) }];
  let y = en.height + gap;
  layers.push({ input: ruleImg, top: y, left: Math.round((w - ruleW) / 2) });
  y += Math.max(1, Math.round(size * 0.035)) + gap;
  if (ar) layers.push({ input: ar.data, top: y, left: Math.round((w - ar.width) / 2) });
  const data = await sharp({ create: { width: w, height: h, channels: 4, background: '#00000000' } }).composite(layers).png().toBuffer();
  return { data, width: w, height: h };
}

/** Centre `child` (a {data,width,height}) horizontally on a canvas of width `w`. */
export const centred = (child, w, top) => ({ input: child.data, top: Math.round(top), left: Math.round((w - child.width) / 2) });
/** Pin `child` to the right edge, `inset` from it — the default for Arabic. */
export const rightOf = (child, w, top, inset) => ({ input: child.data, top: Math.round(top), left: Math.round(w - inset - child.width) });
/** Pin `child` to the left edge. */
export const leftOf = (child, top, inset) => ({ input: child.data, top: Math.round(top), left: Math.round(inset) });
