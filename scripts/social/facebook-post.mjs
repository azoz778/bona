#!/usr/bin/env node
/* Publish to the Bona Real Estate Facebook Page — Node 22+, zero dependencies.

     node scripts/social/facebook-post.mjs whoami
     node scripts/social/facebook-post.mjs post-photo  --file marketing/queue/posts/x.jpg (--message "…" | --message-file f)
     node scripts/social/facebook-post.mjs post-photos --file a.jpg --file b.jpg … (--message …)      # 2–10 photos, one post
     node scripts/social/facebook-post.mjs post-link   --link https://bona-real-estate.com/ --message "…"
     node scripts/social/facebook-post.mjs post-video  --file marketing/queue/reels/reel-BONA-032.mp4 --message "…"
     node scripts/social/facebook-post.mjs queue [--dry-run] [--grace 6] [--limit 3]   # publish what marketing/queue/queue.json says is due
     node scripts/social/facebook-post.mjs queue --id q-046 [--dry-run]                 # one specific entry (still refuses blocked ones)

   Env:   META_ACCESS_TOKEN — the bona-poster system-user token (pages_manage_posts, pages_read_engagement,
          pages_show_list). Read from ~/.secrets/bona-meta-graph.env when not already exported; never printed.
          FB_PAGE_ID        — the Page id; from the same file, else the Bona Real Estate Page created 2026-09-05.
          BONA_QUEUE_ASSETS — directory holding the rendered queue assets (the files queue.json calls
                              marketing/queue/…). Ops: ~/bona-data/queue. Default: <repo>/marketing/queue.
          BONA_DATA         — data dir for the ledger + lock (default ~/bona-data), outside any git tree so
                              the publish worktree stays clean for guard-main.sh.
   Flags: --dry-run prints what would be sent (files, sizes, caption) and sends nothing; --json for raw output.

   Ledger: $BONA_DATA/fb/published.jsonl — one line per publish {id, postId, at}. An entry in the ledger
   is never sent twice; a lock file next to it keeps two runs from racing. Same layout as the Instagram
   publisher's ~/bona-data/ig/published.jsonl.

   Hard stops (lib/facebook.mjs refuseText()/refusal()): blocked entries, any text with {{AD_LICENCE}},
   the phrase «تقييم مجاني». They apply on every path — the queue, --id, and the manual commands. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendLedger, captionFromEntry, dueEntries, filesFor, pageToken, postLink, postPhoto, postPhotos, postVideo,
  publishEntry, readLedger, redact, refusal, refuseText, whoami, withLock,
} from './lib/facebook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUEUE = path.join(ROOT, 'marketing', 'queue', 'queue.json');
const DATA = process.env.BONA_DATA || path.join(os.homedir(), 'bona-data');
const LEDGER = path.join(DATA, 'fb', 'published.jsonl');
const LOCK = path.join(DATA, 'fb', '.publish.lock');
const ASSETS = process.env.BONA_QUEUE_ASSETS || undefined;
const DEFAULT_PAGE_ID = '1245646955305748'; // Facebook Page "Bona Real Estate" (docs/checklists/meta-bona-portfolio.md §2)

// ---- arguments: a value is the token after the flag, and never another flag ----
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(n);
const valueAfter = (i, n) => {
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${n} needs a value`);
  return v;
};
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? valueAfter(i, n) : undefined; };
const opts = (n) => args.flatMap((a, i) => (a === n ? [valueAfter(i, n)] : []));
const num = (n, dflt) => {
  const v = opt(n);
  if (v === undefined) return dflt;
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) die(`${n} must be a positive number, got "${v}"`);
  return x;
};
const dryRun = flag('--dry-run');
const asJson = flag('--json');

/** META_ACCESS_TOKEN (and FB_PAGE_ID) from the environment, else the secrets file — never echoed. */
function loadMetaEnv() {
  const out = { token: process.env.META_ACCESS_TOKEN || '', pageId: process.env.FB_PAGE_ID || '' };
  const f = path.join(os.homedir(), '.secrets', 'bona-meta-graph.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?(META_ACCESS_TOKEN|FB_PAGE_ID)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
      if (m[1] === 'META_ACCESS_TOKEN' && !out.token) out.token = v;
      if (m[1] === 'FB_PAGE_ID' && !out.pageId) out.pageId = v;
    }
  }
  return out;
}
const ENV = loadMetaEnv();
const TOKEN = ENV.token;
const PAGE = ENV.pageId || DEFAULT_PAGE_ID;

function die(msg, code = 1) { console.error(`error: ${redact(msg, TOKEN)}`); process.exit(code); }

function message() {
  const file = opt('--message-file');
  const text = (file ? fs.readFileSync(file, 'utf8') : opt('--message') || '').trim();
  if (!text) die('provide --message "…" or --message-file path');
  const r = refuseText(text);
  if (r) die(r);
  return text;
}
const rel = (f) => path.relative(ROOT, f);
const sizeKb = (f) => (fs.existsSync(f) ? `${Math.round(fs.statSync(f).size / 1024)} KB` : 'MISSING');

async function ctx() {
  if (!TOKEN) die('META_ACCESS_TOKEN is not set and ~/.secrets/bona-meta-graph.env has none — see docs/checklists/NEXT-SESSION.md STEP 1');
  const page = await pageToken({ fetch: globalThis.fetch, token: TOKEN, pageId: PAGE });
  return { fetch: globalThis.fetch, pageToken: page.token, pageId: PAGE, root: ROOT, assetsDir: ASSETS, pageName: page.name };
}

const out = (o) => console.log(redact(asJson ? JSON.stringify(o, null, 2) : Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n'), TOKEN));

try {
  if (!cmd || flag('--help')) {
    console.log('usage: facebook-post.mjs <whoami|post-photo|post-photos|post-link|post-video|queue> [options] [--dry-run] [--json]');
    process.exit(cmd ? 0 : 1);
  }
  if (cmd === 'whoami') {
    if (!TOKEN) die('META_ACCESS_TOKEN is not set (bona-secret META_ACCESS_TOKEN \'EAA…\' meta)');
    out(await whoami({ fetch: globalThis.fetch, token: TOKEN, pageId: PAGE }));
  } else if (cmd === 'post-photo' || cmd === 'post-photos' || cmd === 'post-video') {
    const files = opts('--file').map((f) => path.resolve(f));
    if (!files.length) die('--file is required');
    for (const f of files) if (!fs.existsSync(f)) die(`no such file: ${f}`);
    const msg = message();
    if (dryRun) { out({ dryRun: true, page: PAGE, files: files.map((f) => `${rel(f)} (${sizeKb(f)})`), message: msg }); process.exit(0); }
    const c = await ctx();
    if (cmd === 'post-video') out(await postVideo({ ...c, file: files[0], description: msg }));
    else if (cmd === 'post-photos') out(await postPhotos({ ...c, files, message: msg }));
    else out(await postPhoto({ ...c, file: files[0], message: msg }));
  } else if (cmd === 'post-link') {
    const link = opt('--link'); if (!link) die('--link is required');
    if (!/^https:\/\//.test(link)) die('--link must be an https:// URL');
    const msg = message();
    if (dryRun) { out({ dryRun: true, page: PAGE, link, message: msg }); process.exit(0); }
    out(await postLink({ ...(await ctx()), link, message: msg }));
  } else if (cmd === 'queue') {
    const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
    const ledger = new Set(readLedger(LEDGER).map((r) => r.id));
    let todo;
    if (opt('--id')) {
      const id = opt('--id');
      const matches = queue.entries.filter((x) => x.id === id);
      if (matches.length > 1) die(`${id} appears ${matches.length} times in the queue — fix queue.json first`);
      const e = matches[0];
      const r = refusal(e);
      if (r) die(`${id}: ${r}`);
      if (ledger.has(e.id)) die(`${e.id} is already in the ledger (published)`);
      todo = [e];
    } else {
      todo = dueEntries(queue, { graceHours: num('--grace', 6), ledger }).slice(0, num('--limit', 3));
    }
    if (!todo.length) { console.log('nothing due for facebook (use --id q-### to force one, --dry-run to preview)'); process.exit(0); }
    const run = async () => {
      let live = null;
      for (const e of todo) {
        const files = filesFor(e, ROOT, ASSETS);
        const cap = captionFromEntry(e);
        console.log(`\n${e.id}  ${e.date} ${e.time}  ${e.format}  ${e.pillar}${e.listingRef ? ` ${e.listingRef}` : ''}  basis=${e.licenceBasis ?? 'editorial'}`);
        files.forEach((f) => console.log(`  file: ${ASSETS ? f : rel(f)} (${sizeKb(f)})`));
        console.log(`  caption (${cap.length} chars): ${cap.split('\n')[0].slice(0, 90)}…`);
        if (dryRun) { console.log('  [dry-run] not sent'); continue; }
        live ??= await ctx();
        const r = await publishEntry(e, live);
        appendLedger(LEDGER, { id: e.id, ...r, at: new Date().toISOString() });
        console.log(`  published → ${JSON.stringify(r)}`);
      }
    };
    if (dryRun) await run(); else await withLock(LOCK, run);
  } else {
    die(`unknown command ${cmd}`);
  }
} catch (e) {
  die(e.message);
}
