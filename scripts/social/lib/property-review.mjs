// Helpers for drafting and approving property photo/caption reviews (docs/daily-property-publishing.md).
// Nothing here publishes; the approve script is the only writer of marketing/daily/property-reviews.json.
import sharp from 'sharp';
import { SITE, sha256, fingerprint, advertiserFingerprint, reviewedCopy, aspectConsistent, showsPrice } from './property-daily.mjs';

/** Instagram crops a carousel to its first frame's aspect; eligibility() and buildReview() share the rule. */
export { aspectConsistent };

/** The publisher's own photo rules (eligibility() checks the same numbers). */
export const FRAME_RULES = Object.freeze({ minWidth: 1080, minHeight: 720, minAspect: 0.8, maxAspect: 1.91, maxBytes: 8_000_000 });
export const PRICE_DISCLOSURE = Object.freeze({
  ar: 'الأسعار المعروضة هي الأسعار المطلوبة وقابلة للتغيير.',
  en: 'Prices shown are asking prices and may change.',
});
export const VIEWING_DISCLOSURE = Object.freeze({
  ar: 'تُؤكَّد التفاصيل والحالة والخدمات عند المعاينة.',
  en: 'Details, condition and services are confirmed at viewing.',
});
export const OFF_PLAN_DISCLOSURE = Object.freeze({
  ar: 'مواعيد التسليم والمواصفات حسب المطوّر.',
  en: 'Delivery dates and specifications are per the developer.',
});
/** The price sentence only when the caption prints a price; ready stock is confirmed at viewing, off-plan instead per the developer. */
export function disclosuresFor(p) {
  const parts = [...(showsPrice(p) ? [PRICE_DISCLOSURE] : []), p?.category === 'off-plan' ? OFF_PLAN_DISCLOSURE : VIEWING_DISCLOSURE];
  return { ar: parts.map(x => x.ar).join(' '), en: parts.map(x => x.en).join(' ') };
}
/** Why a downloaded frame cannot be used, or null. */
export function frameProblem({ contentType, bytes, width, height }) {
  if (!String(contentType ?? '').startsWith('image/jpeg')) return 'not_jpeg';
  if (bytes > FRAME_RULES.maxBytes) return 'too_large';
  if (!(width >= FRAME_RULES.minWidth) || !(height >= FRAME_RULES.minHeight)) return 'too_small';
  const aspect = width / height;
  if (aspect < FRAME_RULES.minAspect || aspect > FRAME_RULES.maxAspect) return 'aspect';
  return null;
}
/** "BONA-022:1,2r,5p" → { id, frames: [{ index, kind }] }; kind null means the category default. */
export function parseSelection(s) {
  const m = /^([A-Z]+-[A-Z]?\d+):(\d+[pr]?(?:,\d+[pr]?){2,5})$/.exec(String(s));
  if (!m) throw new Error(`Bad selection "${s}" — use BONA-ID:1,2,3 with 3–6 frames; suffix p = photograph, r = render`);
  const frames = m[2].split(',').map(x => ({ index: Number.parseInt(x, 10), kind: x.endsWith('r') ? 'render' : x.endsWith('p') ? 'photograph' : null }));
  if (new Set(frames.map(f => f.index)).size !== frames.length) throw new Error(`Duplicate frame in "${s}"`);
  return { id: m[1], frames };
}
/** An approved review for frames a reviewer has looked at. Throws when a frame is unusable or the set would crop badly. */
export function buildReview(p, advertiser, draftFrames, selection, { reviewedAt, reviewer }) {
  const photos = selection.frames.map(({ index, kind }) => {
    const f = draftFrames.find(x => x.index === index);
    if (!f) throw new Error(`${p.id}: frame ${index} was not a usable draft frame`);
    return { url: f.url, sha256: f.sha256, width: f.width, height: f.height,
      kind: kind ?? (p.category === 'off-plan' ? 'render' : 'photograph'), visuallyApproved: true, alt: f.alt };
  });
  if (!aspectConsistent(photos)) throw new Error(`${p.id}: selected frames differ in aspect ratio by more than 15% (Instagram crops a carousel to its first frame)`);
  const review = { status: 'approved', reviewedAt, reviewer, factsSha256: fingerprint(p), advertiserSha256: advertiserFingerprint(advertiser),
    captionSha256: null, licenceEvidence: null, legalDisclosuresVerified: true, legalDisclosures: disclosuresFor(p), photos };
  review.captionSha256 = sha256(JSON.stringify(reviewedCopy(p, advertiser, review)));
  return review;
}
/** Equal apart from who approved it and when. */
export function sameReview(a, b) {
  const strip = r => JSON.stringify({ ...r, reviewedAt: null, reviewer: null });
  return Boolean(a && b) && strip(a) === strip(b);
}
/** The live public catalogue, with the publisher's freshness and shape checks. */
export async function liveCatalogue(fetchImpl = fetch, now = new Date()) {
  const res = await fetchImpl(`${SITE}/social-catalogue.json`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new Error('Live catalogue unavailable; do not review from stale local stock');
  const text = await res.text();
  if (Buffer.byteLength(text) > 3_000_000) throw new Error('Live catalogue oversized');
  const d = JSON.parse(text);
  const generated = Date.parse(d.generatedAt);
  if (d.version !== 1 || !Array.isArray(d.listings) || !d.advertiser || new Set(d.listings.map(x => x.id)).size !== d.listings.length ||
      !Number.isFinite(generated) || generated > +now || +now - generated > 48 * 3_600_000) throw new Error('Live catalogue invalid or stale');
  return d;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** One JPEG grid per listing: each usable frame letterboxed, labelled with its website index, size and aspect. */
export async function contactSheet(frames, { columns = 3, cell = 480, label = 44 } = {}) {
  const rows = Math.ceil(frames.length / columns);
  const composites = [];
  for (const [i, f] of frames.entries()) {
    const left = (i % columns) * cell, top = Math.floor(i / columns) * (cell + label);
    composites.push({ input: await sharp(f.buffer).resize(cell, cell, { fit: 'contain', background: '#111111' }).jpeg().toBuffer(), left, top });
    const text = `#${f.index}  ${f.width}x${f.height}  ${(f.width / f.height).toFixed(2)}  ${String(f.alt?.en ?? '').slice(0, 34)}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#f5f1ea"/><text x="8" y="28" font-family="DejaVu Sans, sans-serif" font-size="17" fill="#111111">${esc(text)}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + cell });
  }
  return sharp({ create: { width: columns * cell, height: rows * (cell + label), channels: 3, background: '#ffffff' } })
    .composite(composites).jpeg({ quality: 82 }).toBuffer();
}
