// Instagram Graph API client shared by scripts/instagram-post.mjs (the hand-driven CLI) and
// scripts/social/publish.mjs (the unattended timer). Node 22+, zero dependencies.
//
// Everything that talks to graph.facebook.com lives here so the two callers cannot drift:
// the request wrapper, the container-create → poll → publish flow, the error-code hints,
// and the caption / image-URL checks. Nothing in this file reads process.argv or exits the
// process — errors are thrown as GraphError and the caller decides what to do with them.
//
// Constraints the API enforces (and this file checks up front where it can):
//   image URLs   public HTTPS, JPEG only (PNG/WebP are rejected with code 9004 / 2207xxx),
//                ≤ 8 MB, aspect 4:5 – 1.91:1
//   carousels    2–10 items
//   captions     ≤ 2,200 characters, ≤ 30 hashtags
//   quota        25 published posts per rolling 24 h (GET /{ig-id}/content_publishing_limit)

export const DEFAULT_GRAPH_VERSION = 'v21.0';
export const CAPTION_MAX_CHARS = 2200;
export const CAPTION_MAX_HASHTAGS = 30;
export const CAROUSEL_MIN = 2;
export const CAROUSEL_MAX = 10;
export const PUBLISH_QUOTA_PER_DAY = 25;

/** Human hints keyed by Graph error code / subcode. Shown after the raw error. */
export const HINTS = {
  190: 'Access token invalid/expired. Generate a new long-lived Page token (Business Settings → System Users → Generate token) and re-export META_ACCESS_TOKEN.',
  100: 'Invalid parameter. Check the IG_BUSINESS_ID, that image_url is a public JPEG, and that the caption is under 2,200 characters.',
  10: 'Permission denied. The token needs instagram_basic + instagram_content_publish (+ pages_read_engagement) and the app must be live or the user a tester.',
  200: 'Permission denied for this Page/IG account. Confirm the Instagram account is a Business account linked to the Page in Meta Business Suite.',
  9004: 'Instagram could not fetch the image URL. It must be publicly reachable over HTTPS, JPEG, ≤ 8 MB, no redirects to login.',
  9007: 'Media container still processing — retry publish in a few seconds.',
  36000: 'Caption too long (max 2,200 characters).',
  36001: 'Too many hashtags (max 30).',
  36003: 'Aspect ratio out of range (allowed 4:5 to 1.91:1).',
  2207050: 'The Instagram account is not eligible for content publishing (must be Business/Creator and linked to a Facebook Page).',
  2207051: 'Application request limit reached (25 posts / 24 h).',
};

/** Error codes that mean "no call will succeed until a human fixes the token/permissions". */
export const AUTH_ERROR_CODES = new Set([190, 10, 200]);

export class GraphError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'GraphError';
    Object.assign(this, meta);
  }
  /** Message plus the hint line, the way the CLI prints it. */
  get detail() { return this.hint ? `${this.message}\nhint: ${this.hint}` : this.message; }
  get isAuth() { return AUTH_ERROR_CODES.has(Number(this.code)); }
}

/** Hashtags the way Instagram counts them: a '#' at the start or after whitespace. */
export function countHashtags(text) {
  return (String(text ?? '').match(/(^|\s)#[^\s#]+/g) || []).length;
}

/**
 * Normalise a caption (CRLF → LF, trim) and list every reason the API would reject it.
 * Returns { text, chars, hashtags, problems }; an empty `problems` means publishable.
 */
export function checkCaption(raw) {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const problems = [];
  if (!text) problems.push('caption is empty');
  if (text.length > CAPTION_MAX_CHARS) problems.push(`caption is ${text.length} chars (max ${CAPTION_MAX_CHARS.toLocaleString('en-US')})`);
  const hashtags = countHashtags(text);
  if (hashtags > CAPTION_MAX_HASHTAGS) problems.push(`caption has ${hashtags} hashtags (max ${CAPTION_MAX_HASHTAGS})`);
  return { text, chars: text.length, hashtags, problems };
}

/**
 * Static checks on an image URL (no network): parses, https, and whether the path ends in
 * .jpg/.jpeg. A non-JPEG extension is a `warning`, not a problem — the caller decides
 * whether to look for a JPEG twin (publish.mjs) or just warn (the CLI).
 */
export function checkImageUrl(u) {
  const problems = [];
  let parsed = null;
  try { parsed = new URL(String(u)); } catch { return { url: u, https: false, jpegExt: false, problems: [`not a URL: ${u}`], warning: null }; }
  const https = parsed.protocol === 'https:';
  if (!https) problems.push(`image URL must be https: ${u}`);
  const jpegExt = /\.jpe?g$/i.test(parsed.pathname);
  const warning = jpegExt ? null : `${u} is not a .jpg — Instagram rejects PNG/WebP containers`;
  return { url: String(u), https, jpegExt, problems, warning };
}

/**
 * Build a client bound to one account.
 *   token, igId      credentials (both may be missing in dry-run; they are masked in output)
 *   dryRun           print every request instead of sending it; fake ids come back
 *   fetch, sleep     injectable for tests
 *   log(line)        where dry-run request lines and step messages go
 *   progress(text)   container-poll progress (defaults to a \r line on stdout)
 */
export function createGraph({
  token, igId, version = process.env.GRAPH_VERSION || DEFAULT_GRAPH_VERSION, dryRun = false,
  fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log, progress = (s) => process.stdout.write(s),
  timeoutMs = 30_000, pollMs = 3_000, pollMax = 40,
} = {}) {
  const api = `https://graph.facebook.com/${version}`;
  const id = igId || '<IG_BUSINESS_ID>';
  const masked = token ? `${token.slice(0, 6)}…` : '<META_ACCESS_TOKEN>';
  const fakeId = () => `dry_${Math.random().toString(36).slice(2, 8)}`;

  async function call(method, pathname, params = {}) {
    const url = new URL(`${api}/${pathname}`);
    if (dryRun) {
      const shown = new URLSearchParams({ ...params, access_token: masked }).toString();
      log(method === 'GET' ? `[dry-run] GET ${url}?${shown}` : `[dry-run] POST ${url}\n           ${shown}`);
      return { id: fakeId(), status_code: 'FINISHED', data: [], username: 'bonarealestatesa', permalink: '(dry-run)' };
    }
    const body = new URLSearchParams({ ...params, access_token: token || '' });
    let res;
    try {
      res = method === 'GET'
        ? await fetchImpl(`${url}?${body}`, { signal: AbortSignal.timeout(timeoutMs) })
        : await fetchImpl(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new GraphError(`${method} /${pathname} → network error: ${e?.message || e}`, { method, path: pathname, network: true });
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const e = json.error || {};
      const hint = HINTS[e.error_subcode] || HINTS[e.code] || '';
      throw new GraphError(
        `${method} /${pathname} → HTTP ${res.status} ${e.type || ''} code=${e.code ?? '?'} subcode=${e.error_subcode ?? '-'}: ${e.message || res.statusText}${e.error_user_msg ? ` — ${e.error_user_msg}` : ''}`,
        { method, path: pathname, status: res.status, code: e.code, subcode: e.error_subcode, hint, fbtrace: e.fbtrace_id },
      );
    }
    return json;
  }

  /** Poll a media container until FINISHED. Throws on ERROR/EXPIRED or after pollMax polls. */
  async function waitForContainer(cid, label = 'container') {
    const started = Date.now();
    for (let i = 0; i < pollMax; i++) {
      const r = await call('GET', cid, { fields: 'status_code,status' });
      if (r.status_code === 'FINISHED') return r;
      if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new GraphError(`${label} ${cid} ${r.status_code}: ${r.status || ''}`, { container: cid, statusCode: r.status_code });
      if (dryRun) return r;
      progress(`  ${label} ${cid} ${r.status_code} (${Math.round((Date.now() - started) / 1000)}s)\r`);
      await sleep(pollMs);
    }
    throw new GraphError(`${label} ${cid} did not finish processing within ${Math.round((pollMax * pollMs) / 60_000)} minutes`, { container: cid, timeout: true });
  }

  /** media_publish + best-effort permalink. The post is live once media_publish returns. */
  async function publishContainer(creationId) {
    const p = await call('POST', `${id}/media_publish`, { creation_id: creationId });
    let permalink = '(dry-run)';
    if (!dryRun) {
      try { permalink = (await call('GET', p.id, { fields: 'permalink' })).permalink || '(permalink unavailable)'; }
      catch (e) { permalink = `(permalink lookup failed: ${e.message}; media is published)`; }
    }
    return { mediaId: p.id, permalink, containerId: creationId };
  }

  /** Single-image feed post. `onStep` receives the three progress lines the CLI prints. */
  async function publishImage({ imageUrl, caption, altText, onStep = () => {} }) {
    const params = { image_url: imageUrl, caption };
    if (altText) params.alt_text = altText;
    onStep('1/3 creating media container…');
    const c = await call('POST', `${id}/media`, params);
    onStep(`2/3 waiting for container ${c.id}…`);
    await waitForContainer(c.id);
    onStep('3/3 publishing…');
    return publishContainer(c.id);
  }

  /** Carousel of 2–10 images: one child container each, then the parent, then publish. */
  async function publishCarousel({ imageUrls, caption, onStep = () => {} }) {
    if (imageUrls.length < CAROUSEL_MIN || imageUrls.length > CAROUSEL_MAX) throw new GraphError(`carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} images (got ${imageUrls.length})`, { local: true });
    const children = [];
    for (const [i, u] of imageUrls.entries()) {
      onStep(`item ${i + 1}/${imageUrls.length}: creating container…`);
      const c = await call('POST', `${id}/media`, { image_url: u, is_carousel_item: 'true' });
      await waitForContainer(c.id, `item ${i + 1}`);
      children.push(c.id);
    }
    onStep('creating carousel container…');
    const car = await call('POST', `${id}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
    await waitForContainer(car.id, 'carousel');
    onStep('publishing…');
    return publishContainer(car.id);
  }

  /** Image story (media_type=STORIES). Stories carry no caption on the API side. */
  async function publishStory({ imageUrl, onStep = () => {} }) {
    onStep('1/3 creating story container…');
    const c = await call('POST', `${id}/media`, { image_url: imageUrl, media_type: 'STORIES' });
    onStep(`2/3 waiting for container ${c.id}…`);
    await waitForContainer(c.id, 'story');
    onStep('3/3 publishing…');
    return publishContainer(c.id);
  }

  /** Rolling 24 h publishing quota. quotaUsage is the number already used out of quotaTotal. */
  async function publishingLimit() {
    const r = await call('GET', `${id}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const row = r.data?.[0] || {};
    return { quotaUsage: Number(row.quota_usage ?? 0), quotaTotal: Number(row.config?.quota_total ?? PUBLISH_QUOTA_PER_DAY), quotaDurationSec: Number(row.config?.quota_duration ?? 86_400) };
  }

  const me = (fields = 'id,username,name,followers_count,follows_count,media_count,profile_picture_url,website') => call('GET', id, { fields });
  const listMedia = (limit = 25) => call('GET', `${id}/media`, { fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count', limit: String(limit) });

  return { api, igId: id, dryRun, call, waitForContainer, publishContainer, publishImage, publishCarousel, publishStory, publishingLimit, me, listMedia };
}
