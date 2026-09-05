#!/usr/bin/env node
/* Instagram Graph API poster for @bona.com.sa — Node 22+, zero dependencies.
   Env:   META_ACCESS_TOKEN  (Page/System-User token with instagram_basic, instagram_content_publish, pages_read_engagement)
          IG_BUSINESS_ID     (Instagram Business account id — see marketing/instagram-connect-checklist.md)
          GRAPH_VERSION      (optional, default v21.0)
   Commands:
     whoami
     post-image    --image-url <https://…jpg> (--caption "text" | --caption-file path) [--alt-text "…"]
     post-carousel --image-urls a.jpg,b.jpg,c.jpg (--caption … | --caption-file …)
     list-media    [--limit 25]
   Flags: --dry-run (print the HTTP requests instead of sending), --json (raw output)
   Notes: image URLs must be public JPEG (PNG/WebP are rejected), ≤ 8 MB, aspect 4:5 – 1.91:1;
          carousels take 2–10 items; captions ≤ 2,200 chars, ≤ 30 hashtags; 25 published posts / 24 h. */
const API = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}`;
const TOKEN = process.env.META_ACCESS_TOKEN;
const IG = process.env.IG_BUSINESS_ID;
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = flag('--dry-run');
const fs = await import('node:fs');

const usage = `usage: node scripts/instagram-post.mjs <whoami|post-image|post-carousel|list-media> [options] [--dry-run]
  post-image    --image-url URL (--caption "…" | --caption-file FILE) [--alt-text "…"]
  post-carousel --image-urls URL,URL,… (--caption "…" | --caption-file FILE)
  list-media    [--limit 25]`;

const HINTS = {
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

function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }
function requireEnv() {
  if (dryRun) return;
  if (!TOKEN) die('META_ACCESS_TOKEN is not set');
  if (!IG) die('IG_BUSINESS_ID is not set (see marketing/instagram-connect-checklist.md for the curl to find it)');
}
const igId = () => IG || '<IG_BUSINESS_ID>';
const tokenMasked = () => (TOKEN ? TOKEN.slice(0, 6) + '…' : '<META_ACCESS_TOKEN>');

async function call(method, pathname, params = {}) {
  const url = new URL(`${API}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN || '' });
  if (dryRun) {
    const shown = new URLSearchParams({ ...params, access_token: tokenMasked() }).toString();
    if (method === 'GET') console.log(`[dry-run] GET ${url}?${shown}`);
    else console.log(`[dry-run] POST ${url}\n           ${shown}`);
    return { id: `dry_${Math.random().toString(36).slice(2, 8)}`, status_code: 'FINISHED', data: [], username: 'bona.com.sa' };
  }
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`, { signal: AbortSignal.timeout(30000) })
    : await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(30000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const hint = HINTS[e.error_subcode] || HINTS[e.code] || '';
    die(`${method} /${pathname} → HTTP ${res.status} ${e.type || ''} code=${e.code ?? '?'} subcode=${e.error_subcode ?? '-'}: ${e.message || res.statusText}${e.error_user_msg ? ` — ${e.error_user_msg}` : ''}${hint ? `\nhint: ${hint}` : ''}`);
  }
  return json;
}

async function waitForContainer(id, label = 'container') {
  const started = Date.now();
  for (let i = 0; i < 40; i++) {
    const r = await call('GET', id, { fields: 'status_code,status' });
    if (r.status_code === 'FINISHED') return r;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') die(`${label} ${id} ${r.status_code}: ${r.status || ''}`);
    if (dryRun) return r;
    process.stdout.write(`  ${label} ${id} ${r.status_code} (${Math.round((Date.now() - started) / 1000)}s)\r`);
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  die(`${label} ${id} did not finish processing within 2 minutes`);
}

function caption() {
  const file = opt('--caption-file');
  const text = file ? fs.readFileSync(file, 'utf8') : opt('--caption');
  if (!text) die('provide --caption "…" or --caption-file path');
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length > 2200) die(`caption is ${t.length} chars (max 2,200)`);
  const tags = (t.match(/(^|\s)#[^\s#]+/g) || []).length;
  if (tags > 30) die(`caption has ${tags} hashtags (max 30)`);
  return t;
}

function checkImageUrl(u) {
  let x; try { x = new URL(u); } catch { die(`not a URL: ${u}`); }
  if (x.protocol !== 'https:') die(`image URL must be https: ${u}`);
  if (!/\.jpe?g(\?|$)/i.test(x.pathname + x.search)) console.warn(`warning: ${u} is not a .jpg — Instagram rejects PNG/WebP containers`);
  return u;
}

async function main() {
  if (!cmd || flag('--help') || flag('-h')) { console.log(usage); process.exit(cmd ? 0 : 1); }
  requireEnv();
  const out = (o) => console.log(flag('--json') ? JSON.stringify(o, null, 2) : o);

  if (cmd === 'whoami') {
    const me = await call('GET', igId(), { fields: 'id,username,name,followers_count,follows_count,media_count,profile_picture_url,website' });
    out(dryRun ? me : `@${me.username} (${me.id}) — ${me.name || ''} · ${me.followers_count ?? '?'} followers · ${me.media_count ?? '?'} posts · ${me.website || ''}`);
    return;
  }
  if (cmd === 'list-media') {
    const r = await call('GET', `${igId()}/media`, { fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count', limit: opt('--limit') || '25' });
    if (flag('--json')) return out(r);
    for (const m of r.data || []) console.log(`${m.timestamp?.slice(0, 10)}  ${m.media_type.padEnd(14)} ${m.permalink}  ♥${m.like_count ?? 0} 💬${m.comments_count ?? 0}  ${(m.caption || '').split('\n')[0].slice(0, 60)}`);
    if (!(r.data || []).length) console.log('(no media)');
    return;
  }
  if (cmd === 'post-image') {
    const image_url = checkImageUrl(opt('--image-url') || die('--image-url is required'));
    const cap = caption();
    const params = { image_url, caption: cap };
    if (opt('--alt-text')) params.alt_text = opt('--alt-text');
    console.log('1/3 creating media container…');
    const c = await call('POST', `${igId()}/media`, params);
    console.log(`2/3 waiting for container ${c.id}…`);
    await waitForContainer(c.id);
    console.log('3/3 publishing…');
    const p = await call('POST', `${igId()}/media_publish`, { creation_id: c.id });
    const info = dryRun ? { permalink: '(dry-run)' } : await call('GET', p.id, { fields: 'permalink' });
    out(`published media ${p.id} → ${info.permalink}`);
    return;
  }
  if (cmd === 'post-carousel') {
    const urls = (opt('--image-urls') || die('--image-urls a,b,c is required')).split(',').map((s) => s.trim()).filter(Boolean).map(checkImageUrl);
    if (urls.length < 2 || urls.length > 10) die(`carousel needs 2–10 images (got ${urls.length})`);
    const cap = caption();
    const children = [];
    for (const [i, u] of urls.entries()) {
      console.log(`item ${i + 1}/${urls.length}: creating container…`);
      const c = await call('POST', `${igId()}/media`, { image_url: u, is_carousel_item: 'true' });
      await waitForContainer(c.id, `item ${i + 1}`);
      children.push(c.id);
    }
    console.log('creating carousel container…');
    const car = await call('POST', `${igId()}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: cap });
    await waitForContainer(car.id, 'carousel');
    console.log('publishing…');
    const p = await call('POST', `${igId()}/media_publish`, { creation_id: car.id });
    const info = dryRun ? { permalink: '(dry-run)' } : await call('GET', p.id, { fields: 'permalink' });
    out(`published carousel ${p.id} → ${info.permalink}`);
    return;
  }
  die(`unknown command "${cmd}"\n${usage}`);
}

main().catch((e) => die(e?.message || String(e)));
