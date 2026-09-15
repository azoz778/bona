// Facebook Page publishing over the Graph API — the library behind scripts/social/facebook-post.mjs.
//
// Pure by construction: every network call takes `fetch` as an argument so the tests inject a
// fake and assert on the exact requests. Nothing here reads a secret; the CLI passes the token in.
// The token travels as an Authorization header, never in a URL, and is redacted from errors.
//
// Why a separate poster from Instagram: the Graph API lets a PAGE take a photo or video as a
// multipart upload (`source`), so the queue's locally rendered PNG/MP4 files can go out as they
// are — Instagram insists on a public HTTPS URL and needs a media host first.
//
// What goes out:   image (one photo), carousel (2–10 photos in one post), video (one MP4).
// What never does: an entry with `blocked: true`, any text still carrying {{AD_LICENCE}}, and
//                  anything containing the Valuers-Law phrase «تقييم مجاني» — on EVERY path,
//                  the queue and the manual commands alike (refuseText()).
import fs from 'node:fs';
import path from 'node:path';

export const API = 'https://graph.facebook.com/v23.0';
export const AD_LICENCE_TOKEN = '{{AD_LICENCE}}';
/** Art. 34(5) of the Valuers Law makes "free valuation" a criminal offence to advertise. */
export const FORBIDDEN_PHRASES = ['تقييم مجاني', 'free valuation'];
/** Non-resumable `/videos` upload: Meta's documented ceiling for a single-request upload. */
export const VIDEO_MAX_BYTES = 1024 * 1024 * 1024;

export const HINTS = {
  190: 'Access token invalid/expired. Business Settings → System users → bona-poster → Generate new token (pages_manage_posts, pages_read_engagement, pages_show_list), then bona-secret META_ACCESS_TOKEN … meta.',
  10: 'Permission denied. The token needs pages_manage_posts and the system user must have the Page assigned with full control.',
  200: 'Permission denied for this Page. In Business Settings → System users → bona-poster → Assign assets, add the Bona Real Estate Page.',
  100: 'Invalid parameter. Check FB_PAGE_ID and that the file is a JPEG/PNG (photos) or MP4 (videos).',
  368: 'The Page is temporarily blocked from posting — Meta flagged the action as abusive. Wait and retry manually.',
  1: 'Unknown Graph error — usually a transient server issue or a file Facebook could not decode. Retry once.',
};

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
export const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

/** Strip the token (and any access_token=… query) out of a string before it can be printed. */
export const redact = (s, token) => {
  let out = String(s ?? '');
  if (token) out = out.split(token).join('<token>');
  return out.replace(/access_token=[^&\s'"]+/g, 'access_token=<token>').replace(/EAA[A-Za-z0-9]{20,}/g, 'EAA<token>');
};

export class GraphError extends Error {
  constructor(method, pathname, status, err = {}, token = '') {
    const hint = HINTS[err.error_subcode] || HINTS[err.code] || '';
    super(redact(`${method} /${pathname} → HTTP ${status} ${err.type || ''} code=${err.code ?? '?'} subcode=${err.error_subcode ?? '-'}: ${err.message || 'no message'}${err.error_user_msg ? ` — ${err.error_user_msg}` : ''}${hint ? `\nhint: ${hint}` : ''}`, token));
    this.name = 'GraphError';
    this.code = err.code; this.subcode = err.error_subcode; this.status = status;
  }
}

/**
 * One Graph call. The token goes in the Authorization header. `params` become a URL query on
 * GET and a form body on POST; a `files` map ({ field: { buffer, name, type } }) switches the
 * POST to multipart so a local file can be sent as `source`.
 */
export async function graph({ fetch: doFetch, token, method = 'GET', pathname, params = {}, files = null, timeoutMs = 60_000 }) {
  const url = new URL(`${API}/${pathname}`);
  const headers = { Authorization: `Bearer ${token}` };
  let res;
  try {
    if (method === 'GET') {
      url.search = new URLSearchParams(params).toString();
      res = await doFetch(url.toString(), { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    } else if (files) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
      for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([f.buffer], { type: f.type }), f.name);
      res = await doFetch(url.toString(), { method: 'POST', headers, body: fd, signal: AbortSignal.timeout(timeoutMs) });
    } else {
      res = await doFetch(url.toString(), { method: 'POST', headers, body: new URLSearchParams(params), signal: AbortSignal.timeout(timeoutMs) });
    }
  } catch (e) {
    throw new Error(redact(`${method} /${pathname}: ${e.message}`, token));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new GraphError(method, pathname, res.status, json.error || {}, token);
  return json;
}

/** The Page's own token, derived from the system-user token (the Page must be assigned to it). */
export async function pageToken({ fetch, token, pageId }) {
  const r = await graph({ fetch, token, pathname: pageId, params: { fields: 'id,name,access_token' } });
  if (!r.access_token) throw new Error(`no Page access token for ${pageId} — is the Page assigned to the system user?`);
  return { id: r.id, name: r.name, token: r.access_token };
}

/** Who is this token, and which Page can it publish to. */
export async function whoami({ fetch, token, pageId }) {
  const me = await graph({ fetch, token, pathname: 'me', params: { fields: 'id,name' } });
  const page = await pageToken({ fetch, token, pageId });
  const info = await graph({ fetch, token: page.token, pathname: `${pageId}`, params: { fields: 'id,name,link,fan_count,is_published' } });
  return { user: me, page: { id: page.id, name: page.name, link: info.link, followers: info.fan_count, published: info.is_published } };
}

const readFile = (file) => ({ buffer: fs.readFileSync(file), name: path.basename(file), type: mimeOf(file) });

/** One photo, published straight to the Page (or unpublished, to attach to a feed post). */
export async function uploadPhoto({ fetch, pageToken: tok, pageId, file, message = '', published = true }) {
  const r = await graph({
    fetch, token: tok, method: 'POST', pathname: `${pageId}/photos`,
    // `caption` is the photo's text; `message` on /photos is deprecated (Codex review, Meta docs).
    params: { published: published ? 'true' : 'false', ...(message ? { caption: message } : {}) },
    files: { source: readFile(file) },
  });
  return { photoId: r.id, postId: r.post_id ?? null };
}

/** A single-photo post. */
export const postPhoto = (o) => uploadPhoto({ ...o, published: true });

/** A multi-photo post: 2–10 unpublished uploads attached to one feed post that carries the caption. */
export async function postPhotos({ fetch, pageToken: tok, pageId, files, message }) {
  if (!Array.isArray(files) || files.length < 2 || files.length > 10) throw new Error(`a multi-photo post takes 2–10 photos, got ${files?.length ?? 0}`);
  const ids = [];
  for (const f of files) ids.push((await uploadPhoto({ fetch, pageToken: tok, pageId, file: f, published: false })).photoId);
  const params = { message };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const r = await graph({ fetch, token: tok, method: 'POST', pathname: `${pageId}/feed`, params });
  return { postId: r.id, photoIds: ids };
}

/** A link post (the site, a listing page). */
export async function postLink({ fetch, pageToken: tok, pageId, link, message }) {
  const r = await graph({ fetch, token: tok, method: 'POST', pathname: `${pageId}/feed`, params: { link, message } });
  return { postId: r.id };
}

/** One MP4 as a Page video (single-request upload — the queue's clips are a few MB). */
export async function postVideo({ fetch, pageToken: tok, pageId, file, description = '', title = '' }) {
  const size = fs.statSync(file).size;
  if (size > VIDEO_MAX_BYTES) throw new Error(`${path.basename(file)} is ${Math.round(size / 1048576)} MB — over the ${VIDEO_MAX_BYTES / 1048576} MB single-request limit; use the resumable upload`);
  const r = await graph({
    fetch, token: tok, method: 'POST', pathname: `${pageId}/videos`,
    params: { ...(description ? { description } : {}), ...(title ? { title } : {}) },
    files: { source: readFile(file) }, timeoutMs: 600_000,
  });
  return { videoId: r.id };
}

// ---------------------------------------------------------------------------- refusals

/** Arabic as a person reads it: no tashkeel, tatweel, zero-width marks, or odd spacing. */
export const normaliseArabic = (s) => String(s ?? '')
  .replace(/[ً-ْٰـ]/g, '')
  .replace(/[​-‏‪-‮⁠﻿]/g, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

/** Why this text must not be published, or null. Applies to the queue AND the manual commands. */
export function refuseText(text) {
  const t = normaliseArabic(text);
  const tight = t.replace(/ /g, ''); // a zero-width mark in place of the space must not hide the phrase
  if (t.includes(AD_LICENCE_TOKEN.toLowerCase())) return `text still carries ${AD_LICENCE_TOKEN}`;
  for (const p of FORBIDDEN_PHRASES) {
    const n = normaliseArabic(p);
    if (t.includes(n) || tight.includes(n.replace(/ /g, ''))) return `text contains the forbidden phrase «${p}» (Valuers Law art. 34(5))`;
  }
  return null;
}

/** Why an entry must not go out, or null. Checked on every path, including --id. */
export function refusal(entry) {
  if (!entry) return 'no such entry';
  if (entry.platform !== 'facebook') return `entry is for ${entry.platform}, not facebook`;
  if (entry.blocked) return `blocked: ${entry.blockedReason || 'REGA licence pending'}`;
  const r = refuseText(`${entry.caption?.ar ?? ''}\n${entry.caption?.en ?? ''}\n${(entry.hashtags || []).join(' ')}\n${entry.firstComment ?? ''}`);
  if (r) return r;
  if (!entry.assets?.length) return 'entry has no assets';
  return null;
}

/** Facebook has no first-comment convention: Arabic first, English, then the hashtags inline. */
export function captionFromEntry(entry) {
  const r = refusal(entry);
  if (r) throw new Error(r);
  const parts = [entry.caption.ar?.trim(), entry.caption.en?.trim()].filter(Boolean);
  const tags = (entry.hashtags || []).slice(0, 30).join(' ');
  if (tags) parts.push(tags);
  return parts.join('\n\n');
}

/**
 * Where a queue asset lives. queue.json paths are repo-relative (`marketing/queue/…`) but the
 * rendered files are gitignored, so the publish tree (a clean worktree of origin/main) has none.
 * BONA_QUEUE_ASSETS points at the directory that holds them (ops: ~/bona-data/queue); without it
 * the path resolves inside `root` as before.
 */
export function resolveAsset(rel, root, assetsDir = process.env.BONA_QUEUE_ASSETS) {
  const prefix = 'marketing/queue/';
  if (assetsDir && rel.startsWith(prefix)) return path.resolve(assetsDir, rel.slice(prefix.length));
  return path.resolve(root, rel);
}

/** The files a post needs: JPEG twins where they exist (smaller, photo-safe), else the PNG/MP4. */
export function filesFor(entry, root, assetsDir) {
  const list = entry.format === 'image'
    ? [entry.assetsJpg?.[0] || entry.assets[0]]
    : entry.format === 'carousel'
      ? (entry.assetsJpg?.length >= 2 ? entry.assetsJpg : entry.assets).slice(0, 10)
      : [entry.assets[0]];
  return list.map((f) => resolveAsset(f, root, assetsDir));
}

const riyadh = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const minutesOf = (date, time) => Date.parse(`${date}T${time}:00+03:00`) / 60000;

/**
 * Facebook entries whose Riyadh time has passed, not older than `graceHours`, not blocked, not
 * already in the ledger, each id at most once. Sorted by schedule.
 */
export function dueEntries(queue, { now = new Date(), graceHours = 6, ledger = new Set() } = {}) {
  const cur = riyadh(now);
  const nowMin = minutesOf(cur.date, cur.time);
  const seen = new Set();
  return queue.entries
    .filter((e) => e.platform === 'facebook' && !ledger.has(e.id) && !refusal(e))
    .filter((e) => { const m = minutesOf(e.date, e.time); return m <= nowMin && nowMin - m <= graceHours * 60; })
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => minutesOf(a.date, a.time) - minutesOf(b.date, b.time));
}

/** Publish one queue entry. Returns what Facebook created. */
export async function publishEntry(entry, { fetch, pageToken: tok, pageId, root, assetsDir }) {
  const message = captionFromEntry(entry);
  const files = filesFor(entry, root, assetsDir);
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`${entry.id}: asset missing on disk: ${f}`);
  if (entry.format === 'video') return { kind: 'video', ...(await postVideo({ fetch, pageToken: tok, pageId, file: files[0], description: message })) };
  if (entry.format === 'carousel' && files.length >= 2) return { kind: 'photos', ...(await postPhotos({ fetch, pageToken: tok, pageId, files, message })) };
  return { kind: 'photo', ...(await postPhoto({ fetch, pageToken: tok, pageId, file: files[0], message })) };
}

// ---------------------------------------------------------------------------- ledger + lock
export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
export function appendLedger(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/**
 * One publisher at a time: an exclusive lock file next to the ledger. A stale lock (older than
 * `staleMs`, e.g. a crashed run) is taken over. Two concurrent runs otherwise both see the same
 * ledger snapshot and could post the same entry twice.
 */
export async function withLock(file, fn, { staleMs = 30 * 60_000, now = () => Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = now() - fs.statSync(file).mtimeMs;
    if (age < staleMs) throw new Error(`another publish run holds ${path.basename(file)} (${Math.round(age / 1000)} s old) — wait for it, or delete the file if that run crashed`);
    fs.rmSync(file, { force: true });
    fd = fs.openSync(file, 'wx');
  }
  fs.writeSync(fd, `${process.pid} ${new Date(now()).toISOString()}\n`);
  fs.closeSync(fd);
  try {
    return await fn();
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
  }
}
