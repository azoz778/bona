// scripts/social/lib/graph.mjs — the Graph API client shared by instagram-post.mjs and
// publish.mjs. No network: fetch is injected everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_MAX_CHARS, checkCaption, checkImageUrl, countHashtags, createGraph, GraphError, HINTS } from '../social/lib/graph.mjs';

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, statusText: 'x', json: async () => body });

test('checkCaption: normalises CRLF, counts hashtags like Instagram, enforces 2,200 chars and 30 tags', () => {
  const c = checkCaption('hello\r\nworld #a #b  #c\n#d a#notatag');
  assert.equal(c.text, 'hello\nworld #a #b  #c\n#d a#notatag');
  assert.equal(c.hashtags, 4, 'a # glued to a word is not a hashtag');
  assert.deepEqual(c.problems, []);
  assert.equal(countHashtags('#x##y #z'), 2);
  assert.match(checkCaption('x'.repeat(CAPTION_MAX_CHARS + 1)).problems[0], /2201 chars \(max 2,200\)/);
  assert.match(checkCaption(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')).problems[0], /31 hashtags/);
  assert.match(checkCaption('   ').problems[0], /empty/);
  assert.deepEqual(checkCaption('x'.repeat(CAPTION_MAX_CHARS)).problems, [], 'exactly the limit is fine');
});

test('checkImageUrl: https is a hard problem, a non-JPEG extension is only a warning', () => {
  assert.deepEqual(checkImageUrl('https://h/a.JPG').problems, []);
  assert.equal(checkImageUrl('https://h/a.jpeg').jpegExt, true);
  assert.equal(checkImageUrl('https://h/a.png').jpegExt, false);
  assert.match(checkImageUrl('https://h/a.png').warning, /rejects PNG/);
  assert.match(checkImageUrl('http://h/a.jpg').problems[0], /must be https/);
  assert.match(checkImageUrl('not a url').problems[0], /not a URL/);
});

test('createGraph dry-run: prints every request, never calls fetch, returns fake ids', async () => {
  const lines = [];
  let fetched = 0;
  const g = createGraph({ dryRun: true, fetch: async () => { fetched++; }, log: (s) => lines.push(s), progress: () => {} });
  const r = await g.publishImage({ imageUrl: 'https://h/a.jpg', caption: 'hi', altText: 'alt' });
  assert.equal(fetched, 0);
  assert.match(r.mediaId, /^dry_/);
  assert.equal(r.permalink, '(dry-run)');
  assert.ok(lines.some((l) => l.startsWith('[dry-run] POST https://graph.facebook.com/v21.0/%3CIG_BUSINESS_ID%3E/media\n') && l.includes('alt_text=alt') && l.includes('access_token=%3CMETA_ACCESS_TOKEN%3E')));
  assert.ok(lines.some((l) => l.includes('/media_publish')));
  const s = await g.publishStory({ imageUrl: 'https://h/s.jpg' });
  assert.match(s.mediaId, /^dry_/);
  assert.ok(lines.some((l) => l.includes('media_type=STORIES')));
});

test('createGraph live: a Graph error becomes a GraphError with code, subcode and hint; 190 is an auth error', async () => {
  const g = createGraph({ token: 'tok', igId: '123', fetch: async () => jsonResponse({ error: { message: 'Bad token', type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'x' } }, 400) });
  await assert.rejects(g.me(), (e) => {
    assert.ok(e instanceof GraphError);
    assert.equal(e.code, 190);
    assert.equal(e.subcode, 463);
    assert.equal(e.isAuth, true);
    assert.match(e.hint, /long-lived Page token/);
    assert.match(e.detail, /HTTP 400 OAuthException code=190 subcode=463: Bad token\nhint: /);
    return true;
  });
  const g2 = createGraph({ token: 'tok', igId: '123', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(g2.me(), (e) => e instanceof GraphError && e.network === true && !e.isAuth && e.isTransient && !e.shouldStop);
});

test('GraphError: rate limits (4/17/32/613, subcode 2207051) stop the run and are transient; 5xx and timeouts are transient but do not stop; 4xx content errors are neither', () => {
  for (const code of [4, 17, 32, 613]) {
    const e = new GraphError('x', { code, status: 400 });
    assert.equal(e.isRateLimit, true, `code ${code}`);
    assert.equal(e.shouldStop, true);
    assert.equal(e.isTransient, true);
    assert.equal(e.isAuth, false);
  }
  const sub = new GraphError('x', { code: 100, subcode: 2207051, status: 400 });
  assert.equal(sub.isRateLimit, true, 'the publishing-limit subcode counts too');
  assert.equal(sub.shouldStop, true);
  const auth = new GraphError('x', { code: 190, status: 400 });
  assert.equal(auth.shouldStop, true);
  assert.equal(auth.isTransient, false, 'a bad token is not going to fix itself');
  const five = new GraphError('x', { code: 1, status: 500 });
  assert.equal(five.isTransient, true);
  assert.equal(five.shouldStop, false);
  assert.equal(new GraphError('x', { timeout: true }).isTransient, true);
  const content = new GraphError('x', { code: 9004, status: 400 });
  assert.equal(content.isTransient, false);
  assert.equal(content.shouldStop, false);
  assert.match(new GraphError('x', { code: 4, hint: HINTS[4] }).detail, /request limit/);
});

test('createGraph live: container is polled until FINISHED, then published; ERROR throws', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push(`${init?.method || 'GET'} ${u.split('?')[0]}`);
    if (u.endsWith('/123/media')) return jsonResponse({ id: 'c1' });
    if (u.includes('/c1?')) return jsonResponse({ status_code: ++polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
    if (u.endsWith('/123/media_publish')) return jsonResponse({ id: 'm1' });
    if (u.includes('/m1?')) return jsonResponse({ permalink: 'https://www.instagram.com/p/x/' });
    throw new Error(`unexpected ${u}`);
  };
  const slept = [];
  const g = createGraph({ token: 't', igId: '123', fetch: fetchImpl, sleep: async (ms) => slept.push(ms), progress: () => {} });
  const r = await g.publishImage({ imageUrl: 'https://h/a.jpg', caption: 'c' });
  assert.deepEqual(r, { mediaId: 'm1', permalink: 'https://www.instagram.com/p/x/', containerId: 'c1' });
  assert.equal(polls, 3);
  assert.deepEqual(slept, [3000, 3000]);
  assert.equal(calls.filter((c) => c.includes('/media_publish')).length, 1);

  const bad = createGraph({ token: 't', igId: '123', fetch: async (url) => String(url).endsWith('/123/media') ? jsonResponse({ id: 'c2' }) : jsonResponse({ status_code: 'ERROR', status: 'Media is too large' }), sleep: async () => {}, progress: () => {} });
  await assert.rejects(bad.publishImage({ imageUrl: 'https://h/a.jpg', caption: 'c' }), /container c2 ERROR: Media is too large/);
});

test('createGraph: carousel bounds and the publishing-limit shape', async () => {
  const g = createGraph({ dryRun: true, log: () => {} });
  await assert.rejects(g.publishCarousel({ imageUrls: ['https://h/1.jpg'], caption: 'c' }), /2–10 images \(got 1\)/);
  await assert.rejects(g.publishCarousel({ imageUrls: Array(11).fill('https://h/1.jpg'), caption: 'c' }), /got 11/);
  const live = createGraph({ token: 't', igId: '123', fetch: async () => jsonResponse({ data: [{ quota_usage: 7, config: { quota_total: 25, quota_duration: 86400 } }] }) });
  assert.deepEqual(await live.publishingLimit(), { quotaUsage: 7, quotaTotal: 25, quotaDurationSec: 86400 });
  assert.equal((await g.publishingLimit()).quotaUsage, 0, 'dry-run reports an empty quota');
});
