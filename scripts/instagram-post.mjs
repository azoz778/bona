#!/usr/bin/env node
/* Instagram Graph API poster for @bonarealestatesa — Node 22+, zero dependencies.
   Env:   META_ACCESS_TOKEN  (Page/System-User token with instagram_basic, instagram_content_publish, pages_read_engagement)
          IG_BUSINESS_ID     (Instagram Business account id — see marketing/instagram-connect-checklist.md)
          GRAPH_VERSION      (optional, default v21.0)
   Commands:
     whoami
     post-image    --image-url <https://…jpg> (--caption "text" | --caption-file path) [--alt-text "…"]
     post-carousel --image-urls a.jpg,b.jpg,c.jpg (--caption … | --caption-file …)
     post-story    --image-url <https://…jpg>
     list-media    [--limit 25]
     limit         (rolling 24 h publishing quota)
   Flags: --dry-run (print the HTTP requests instead of sending), --json (raw output)
   Notes: image URLs must be public JPEG (PNG/WebP are rejected), ≤ 8 MB, aspect 4:5 – 1.91:1;
          carousels take 2–10 items; captions ≤ 2,200 chars, ≤ 30 hashtags; 25 published posts / 24 h.
   The request/poll/publish logic and the error hints live in scripts/social/lib/graph.mjs and are
   shared with the unattended publisher, scripts/social/publish.mjs. */
import fs from 'node:fs';
import { CAROUSEL_MAX, CAROUSEL_MIN, checkCaption, checkImageUrl, createGraph } from './social/lib/graph.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = flag('--dry-run');
const TOKEN = process.env.META_ACCESS_TOKEN;
const IG = process.env.IG_BUSINESS_ID;

const usage = `usage: node scripts/instagram-post.mjs <whoami|post-image|post-carousel|post-story|list-media|limit> [options] [--dry-run]
  post-image    --image-url URL (--caption "…" | --caption-file FILE) [--alt-text "…"]
  post-carousel --image-urls URL,URL,… (--caption "…" | --caption-file FILE)
  post-story    --image-url URL
  list-media    [--limit 25]
  limit`;

function die(msg, code = 1) { console.error(`error: ${msg}`); process.exit(code); }
function requireEnv() {
  if (dryRun) return;
  if (!TOKEN) die('META_ACCESS_TOKEN is not set');
  if (!IG) die('IG_BUSINESS_ID is not set (see marketing/instagram-connect-checklist.md for the curl to find it)');
}

function caption() {
  const file = opt('--caption-file');
  const text = file ? fs.readFileSync(file, 'utf8') : opt('--caption');
  if (!text) die('provide --caption "…" or --caption-file path');
  const c = checkCaption(text);
  if (c.problems.length) die(c.problems[0]);
  return c.text;
}

function imageUrl(u) {
  const c = checkImageUrl(u);
  if (c.problems.length) die(c.problems[0]);
  if (c.warning) console.warn(`warning: ${c.warning}`);
  return c.url;
}

async function main() {
  if (!cmd || flag('--help') || flag('-h')) { console.log(usage); process.exit(cmd ? 0 : 1); }
  requireEnv();
  const graph = createGraph({ token: TOKEN, igId: IG, dryRun });
  const out = (o) => console.log(flag('--json') ? JSON.stringify(o, null, 2) : o);
  const onStep = (s) => console.log(s);

  if (cmd === 'whoami') {
    const me = await graph.me();
    out(dryRun ? me : `@${me.username} (${me.id}) — ${me.name || ''} · ${me.followers_count ?? '?'} followers · ${me.media_count ?? '?'} posts · ${me.website || ''}`);
    return;
  }
  if (cmd === 'limit') {
    const q = await graph.publishingLimit();
    out(flag('--json') ? q : `${q.quotaUsage} of ${q.quotaTotal} posts used in the last ${Math.round(q.quotaDurationSec / 3600)} h`);
    return;
  }
  if (cmd === 'list-media') {
    const r = await graph.listMedia(opt('--limit') || '25');
    if (flag('--json')) return out(r);
    for (const m of r.data || []) console.log(`${m.timestamp?.slice(0, 10)}  ${m.media_type.padEnd(14)} ${m.permalink}  ♥${m.like_count ?? 0} 💬${m.comments_count ?? 0}  ${(m.caption || '').split('\n')[0].slice(0, 60)}`);
    if (!(r.data || []).length) console.log('(no media)');
    return;
  }
  if (cmd === 'post-image') {
    const image_url = imageUrl(opt('--image-url') || die('--image-url is required'));
    const r = await graph.publishImage({ imageUrl: image_url, caption: caption(), altText: opt('--alt-text'), onStep });
    out(`published media ${r.mediaId} → ${r.permalink}`);
    return;
  }
  if (cmd === 'post-carousel') {
    const urls = (opt('--image-urls') || die('--image-urls a,b,c is required')).split(',').map((s) => s.trim()).filter(Boolean).map(imageUrl);
    if (urls.length < CAROUSEL_MIN || urls.length > CAROUSEL_MAX) die(`carousel needs ${CAROUSEL_MIN}–${CAROUSEL_MAX} images (got ${urls.length})`);
    const r = await graph.publishCarousel({ imageUrls: urls, caption: caption(), onStep });
    out(`published carousel ${r.mediaId} → ${r.permalink}`);
    return;
  }
  if (cmd === 'post-story') {
    const image_url = imageUrl(opt('--image-url') || die('--image-url is required'));
    const r = await graph.publishStory({ imageUrl: image_url, onStep });
    out(`published story ${r.mediaId} → ${r.permalink}`);
    return;
  }
  die(`unknown command "${cmd}"\n${usage}`);
}

main().catch((e) => die(e?.detail || e?.message || String(e)));
