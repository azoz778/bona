// Facebook Page poster: every request it would send, and every reason it refuses to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AD_LICENCE_TOKEN, GraphError, appendLedger, captionFromEntry, dueEntries, filesFor, graph, pageToken, postLink,
  postPhoto, postPhotos, postVideo, publishEntry, readLedger, redact, refusal, refuseText, whoami, withLock,
} from '../social/lib/facebook.mjs';

/** A fetch that records every request and answers from a script of JSON bodies. */
function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const req = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    if (init.body instanceof FormData) {
      req.fields = {};
      for (const [k, v] of init.body.entries()) req.fields[k] = v instanceof Blob ? { blob: true, size: v.size, type: v.type, name: v.name } : v;
    } else if (init.body instanceof URLSearchParams) {
      req.fields = Object.fromEntries(init.body.entries());
    }
    calls.push(req);
    const r = replies.shift() ?? { ok: true, body: {} };
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body };
  };
  return { fetch, calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
const png = path.join(tmp, 'a.png'); fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
const jpg = path.join(tmp, 'b.jpg'); fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 1, 2]));
const mp4 = path.join(tmp, 'c.mp4'); fs.writeFileSync(mp4, Buffer.alloc(16, 1));

const entry = (over = {}) => ({
  id: 'q-046', date: '2026-09-17', time: '20:20', platform: 'facebook', format: 'image', pillar: 'brand',
  listingRef: null, licenceBasis: null, blocked: false, blockedReason: null,
  assets: ['marketing/queue/posts/a.png'], assetsJpg: ['marketing/queue/posts/b.jpg'],
  caption: { ar: 'بونا — بيوت استثنائية بهدوء.', en: 'Bona — exceptional homes, quietly.' },
  hashtags: ['#بونا', '#bona', '#jeddah'], firstComment: null, ...over,
});

test('graph: the token travels as a Bearer header, never in the URL or the body', async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: '1' } }, { body: { id: '2' } }, { body: { id: '3' } }]);
  await graph({ fetch, token: 'SECRET', pathname: 'me', params: { fields: 'id' } });
  await graph({ fetch, token: 'SECRET', method: 'POST', pathname: 'p/feed', params: { message: 'hi' } });
  await graph({ fetch, token: 'SECRET', method: 'POST', pathname: 'p/photos', params: { published: 'false' }, files: { source: { buffer: Buffer.from('x'), name: 'a.png', type: 'image/png' } } });
  for (const c of calls) {
    assert.equal(c.headers.Authorization, 'Bearer SECRET');
    assert.ok(!c.url.includes('SECRET'), 'token not in URL');
    assert.ok(!('access_token' in (c.fields || {})), 'token not in body');
  }
  assert.match(calls[0].url, /\/me\?fields=id$/);
  assert.equal(calls[1].fields.message, 'hi');
  assert.equal(calls[2].fields.published, 'false'); assert.equal(calls[2].fields.source.blob, true); assert.equal(calls[2].fields.source.type, 'image/png');
});

test('graph: an error body becomes a GraphError with the owner hint, token redacted', async () => {
  const { fetch } = fakeFetch([{ ok: false, status: 400, body: { error: { message: 'Invalid OAuth SECRET', type: 'OAuthException', code: 190 } } }]);
  await assert.rejects(graph({ fetch, token: 'SECRET', pathname: 'me' }), (e) => e instanceof GraphError && /code=190/.test(e.message) && /bona-secret META_ACCESS_TOKEN/.test(e.message) && !e.message.includes('SECRET'));
  const boom = async () => { throw new Error('connect failed for ?access_token=SECRET'); };
  await assert.rejects(graph({ fetch: boom, token: 'SECRET', pathname: 'me' }), (e) => !e.message.includes('SECRET') && /access_token=<token>/.test(e.message));
});

test('redact: exact token, access_token query values and EAA-shaped strings', () => {
  const tok = 'EAA' + 'x'.repeat(40);
  assert.equal(redact(`a ${tok} b access_token=${tok}&c=1 EAA${'y'.repeat(30)}`, tok), 'a <token> b access_token=<token>&c=1 EAA<token>');
});

test('whoami: user, then the Page token, then the Page read with that token', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { id: '61594055259353', name: 'bona-poster' } },
    { body: { id: '1245646955305748', name: 'Bona Real Estate', access_token: 'PAGE' } },
    { body: { id: '1245646955305748', name: 'Bona Real Estate', link: 'https://www.facebook.com/x', fan_count: 12, is_published: true } },
  ]);
  const r = await whoami({ fetch, token: 'SYS', pageId: '1245646955305748' });
  assert.equal(r.user.name, 'bona-poster'); assert.equal(r.page.followers, 12);
  assert.equal(calls[1].headers.Authorization, 'Bearer SYS'); assert.equal(calls[2].headers.Authorization, 'Bearer PAGE');
});

test('pageToken: refuses when the Page is not assigned (no access_token in the reply)', async () => {
  const { fetch } = fakeFetch([{ body: { id: '1', name: 'Bona' } }]);
  await assert.rejects(pageToken({ fetch, token: 'T', pageId: '1' }), /assigned to the system user/);
});

test('postPhotos: 2–10 unpublished uploads then one feed post with attached_media', async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: 'p1' } }, { body: { id: 'p2' } }, { body: { id: 'post_9' } }]);
  const r = await postPhotos({ fetch, pageToken: 'PAGE', pageId: 'PG', files: [png, jpg], message: 'm' });
  assert.deepEqual(r, { postId: 'post_9', photoIds: ['p1', 'p2'] });
  assert.equal(calls[0].fields.published, 'false'); assert.equal(calls[0].fields.source.type, 'image/png');
  assert.ok(!('caption' in calls[0].fields), 'unpublished photos carry no caption');
  assert.equal(calls[1].fields.source.type, 'image/jpeg');
  assert.match(calls[2].url, /\/PG\/feed$/);
  assert.equal(calls[2].fields['attached_media[0]'], JSON.stringify({ media_fbid: 'p1' }));
  assert.equal(calls[2].fields['attached_media[1]'], JSON.stringify({ media_fbid: 'p2' }));
  await assert.rejects(postPhotos({ fetch, pageToken: 'PAGE', pageId: 'PG', files: [png], message: 'm' }), /2–10 photos/);
});

test('postPhoto / postLink / postVideo hit the right edges with the right field names', async () => {
  const { fetch, calls } = fakeFetch([{ body: { id: 'ph', post_id: 'PG_1' } }, { body: { id: 'PG_2' } }, { body: { id: 'v1' } }]);
  assert.deepEqual(await postPhoto({ fetch, pageToken: 'P', pageId: 'PG', file: jpg, message: 'a' }), { photoId: 'ph', postId: 'PG_1' });
  assert.deepEqual(await postLink({ fetch, pageToken: 'P', pageId: 'PG', link: 'https://bona-real-estate.com/', message: 'b' }), { postId: 'PG_2' });
  assert.deepEqual(await postVideo({ fetch, pageToken: 'P', pageId: 'PG', file: mp4, description: 'c' }), { videoId: 'v1' });
  assert.match(calls[0].url, /\/PG\/photos$/); assert.equal(calls[0].fields.published, 'true');
  assert.equal(calls[0].fields.caption, 'a', '/photos takes caption, not the deprecated message'); assert.ok(!('message' in calls[0].fields));
  assert.match(calls[1].url, /\/PG\/feed$/); assert.equal(calls[1].fields.link, 'https://bona-real-estate.com/'); assert.equal(calls[1].fields.message, 'b');
  assert.match(calls[2].url, /\/PG\/videos$/); assert.equal(calls[2].fields.source.type, 'video/mp4'); assert.equal(calls[2].fields.description, 'c');
});

test('postVideo: refuses an oversized file before any request', async () => {
  const big = path.join(tmp, 'big.mp4');
  fs.writeFileSync(big, Buffer.alloc(8));
  fs.truncateSync(big, 1024 * 1024 * 1024 + 1); // sparse: no real disk use
  const { fetch, calls } = fakeFetch([]);
  await assert.rejects(postVideo({ fetch, pageToken: 'P', pageId: 'PG', file: big }), /single-request limit/);
  assert.equal(calls.length, 0);
});

test('refuseText: placeholder and the Valuers-Law phrase, through diacritics, tatweel and zero-width tricks', () => {
  assert.equal(refuseText('بونا — بيوت استثنائية'), null);
  assert.match(refuseText(`x ${AD_LICENCE_TOKEN}`), /AD_LICENCE/);
  for (const v of ['تقييم مجاني', 'تقييم مجّاني', 'تقييمٌ مجانيّ', 'تقـييم مجاني', 'تقييم​مجاني', 'تقييم   مجاني', 'Free Valuation today', 'FREE  valuation']) {
    assert.match(refuseText(`عرض: ${v}`) || '', /forbidden phrase/, JSON.stringify(v));
  }
});

test('refusal: blocked, placeholder, forbidden phrase, wrong platform, no assets', () => {
  assert.equal(refusal(entry()), null);
  assert.match(refusal(entry({ blocked: true, blockedReason: 'REGA pending' })), /blocked/);
  assert.match(refusal(entry({ caption: { ar: `x ${AD_LICENCE_TOKEN}`, en: 'y' } })), /AD_LICENCE/);
  assert.match(refusal(entry({ hashtags: ['#تقييم_عقاري'], caption: { ar: 'تقييم مجاني للعقار', en: 'y' } })), /forbidden phrase/);
  assert.match(refusal(entry({ platform: 'instagram' })), /not facebook/);
  assert.match(refusal(entry({ assets: [] })), /no assets/);
  assert.match(refusal(undefined), /no such entry/);
});

test('captionFromEntry: Arabic, English, then hashtags inline; throws on a refusal', () => {
  const c = captionFromEntry(entry());
  assert.equal(c, 'بونا — بيوت استثنائية بهدوء.\n\nBona — exceptional homes, quietly.\n\n#بونا #bona #jeddah');
  assert.throws(() => captionFromEntry(entry({ blocked: true })), /blocked/);
});

test('filesFor: image prefers the JPEG twin; carousel takes up to 10; video the MP4; BONA_QUEUE_ASSETS relocates', () => {
  assert.deepEqual(filesFor(entry(), '/r'), ['/r/marketing/queue/posts/b.jpg']);
  assert.deepEqual(filesFor(entry(), '/r', '/data/queue'), ['/data/queue/posts/b.jpg'], 'assets dir replaces the marketing/queue prefix');
  assert.deepEqual(filesFor(entry({ format: 'video', assets: ['elsewhere/x.mp4'], assetsJpg: [] }), '/r', '/data/queue'), ['/r/elsewhere/x.mp4'], 'other paths stay repo-relative');
  const car = entry({ format: 'carousel', assets: Array.from({ length: 12 }, (_, i) => `c/${i}.png`), assetsJpg: Array.from({ length: 12 }, (_, i) => `c/${i}.jpg`) });
  assert.equal(filesFor(car, '/r').length, 10); assert.equal(filesFor(car, '/r')[0], '/r/c/0.jpg');
  assert.deepEqual(filesFor(entry({ format: 'video', assets: ['reels/x.mp4'], assetsJpg: [] }), '/r'), ['/r/reels/x.mp4']);
});

test('dueEntries: Riyadh time window, grace, ledger, refusals and duplicate ids all apply', () => {
  const q = { entries: [
    entry({ id: 'a', date: '2026-09-17', time: '20:20' }),
    entry({ id: 'a', date: '2026-09-17', time: '20:20' }),               // duplicated id in the file
    entry({ id: 'b', date: '2026-09-17', time: '21:00' }),               // in the future
    entry({ id: 'c', date: '2026-09-17', time: '10:00' }),               // older than the grace window
    entry({ id: 'd', date: '2026-09-17', time: '20:00', blocked: true }),
    entry({ id: 'e', date: '2026-09-17', time: '19:00' }),               // already in the ledger
    entry({ id: 'f', date: '2026-09-17', time: '19:30', platform: 'instagram' }),
  ] };
  const now = new Date('2026-09-17T17:30:00Z'); // 20:30 Riyadh
  assert.deepEqual(dueEntries(q, { now, graceHours: 6, ledger: new Set(['e']) }).map((e) => e.id), ['a']);
  assert.deepEqual(dueEntries(q, { now, graceHours: 12, ledger: new Set() }).map((e) => e.id), ['c', 'e', 'a']);
});

test('publishEntry: routes by format and refuses a missing file before any request', async () => {
  const root = tmp;
  const img = entry({ assets: ['a.png'], assetsJpg: ['b.jpg'] });
  const { fetch, calls } = fakeFetch([{ body: { id: 'ph', post_id: 'PG_1' } }]);
  const r = await publishEntry(img, { fetch, pageToken: 'P', pageId: 'PG', root });
  assert.equal(r.kind, 'photo'); assert.equal(calls[0].fields.source.type, 'image/jpeg');
  const missing = entry({ assets: ['nope.png'], assetsJpg: [] });
  const f2 = fakeFetch([]);
  await assert.rejects(publishEntry(missing, { fetch: f2.fetch, pageToken: 'P', pageId: 'PG', root }), /asset missing on disk/);
  assert.equal(f2.calls.length, 0);
});

test('ledger: append and read back', () => {
  const f = path.join(tmp, 'ledger.jsonl');
  appendLedger(f, { id: 'q-1', postId: 'x', at: 't' });
  appendLedger(f, { id: 'q-2', postId: 'y', at: 't' });
  assert.deepEqual(readLedger(f).map((r) => r.id), ['q-1', 'q-2']);
  assert.deepEqual(readLedger(path.join(tmp, 'none.jsonl')), []);
});

test('withLock: a second run is refused while the first holds the lock; a stale lock is taken over', async () => {
  const lock = path.join(tmp, 'publish.lock');
  let release;
  const held = withLock(lock, () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(withLock(lock, async () => 'second'), /another publish run holds/);
  release('done');
  assert.equal(await held, 'done');
  assert.ok(!fs.existsSync(lock), 'lock released');
  fs.writeFileSync(lock, 'stale');
  const old = Date.now() - 2 * 60 * 60_000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  assert.equal(await withLock(lock, async () => 'took over'), 'took over');
  assert.ok(!fs.existsSync(lock));
});
