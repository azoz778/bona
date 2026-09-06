// A video with no listing id in its caption — the way the owner actually sends them.
//
// Real history, 2026-09-06 (group "PDF Bona"): the Knightsbridge brochure PDF at 14:14:07,
// then four captionless mp4 clips at 14:14:19, then four more brochures at 14:16:06. The
// clips belong to the brochure sent 12 seconds before them, not to the ones sent two
// minutes after. `pickListingForVideo` encodes exactly that: nearest PDF in time wins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pickListingForVideo, wakeParkedClip } from '../lib/video.mjs';
import { createState } from '../lib/state.mjs';
import { messageTs, oldestFirst } from '../lib/evolution.mjs';
import * as edits from '../lib/edits.mjs';
import * as msg from '../lib/messages.mjs';

const JID = '120363135705763548@g.us';
const T0 = 1757160847; // 2026-09-06 14:14:07 +03 — the Knightsbridge brochure
const job = (id, ts, status, extra = {}) => ({ id, jid: JID, ts, status, fileName: `${id}.pdf`, ...extra });

// bySha256 answers "which listing did this PDF message publish?"
const publishedBy = (map) => (messageId) => map[messageId] || null;

describe('pickListingForVideo — a captionless clip belongs to the nearest brochure', () => {
  it('reproduces 2026-09-06: four clips 12 s after Knightsbridge attach to Knightsbridge, not to the batch two minutes later', () => {
    const jobs = [
      job('KNIGHTS_PDF', T0, 'done'),
      job('KNIGHTS_FLOORPLANS', T0, 'rejected'),
      job('KNIGHTS_SPECS', T0, 'rejected'),
      job('ELVIRA_PDF', T0 + 119, 'done'),
      job('ALHAYAT_PDF', T0 + 119, 'done'),
      job('SADANA_PDF', T0 + 119, 'rejected'),
    ];
    const by = publishedBy({
      KNIGHTS_PDF: { id: 'BONA-W008', slug: 'knightsbridge-villas-meydan-district-11' },
      ELVIRA_PDF: { id: 'BONA-W009', slug: 'elvira-murjan-townhouses-in-al-murjan' },
      ALHAYAT_PDF: { id: 'BONA-W010', slug: 'alhayat-residence-al-salama' },
    });
    const pick = pickListingForVideo({ ts: T0 + 12, jid: JID }, jobs, by);
    assert.equal(pick.kind, 'attach');
    assert.equal(pick.listingId, 'BONA-W008');
    assert.equal(pick.pdfMessageId, 'KNIGHTS_PDF');
    assert.equal(pick.deltaSec, 12);
  });

  it('waits while the nearest brochure is still being published', () => {
    const jobs = [job('PDF_A', T0, 'pending')];
    const pick = pickListingForVideo({ ts: T0 + 10, jid: JID }, jobs, publishedBy({}));
    assert.deepEqual(pick, { kind: 'wait', pdfMessageId: 'PDF_A' });
  });

  it('a clip sent BEFORE its brochure (owner picks the video first) still matches it', () => {
    const jobs = [job('PDF_A', T0 + 30, 'done')];
    const pick = pickListingForVideo({ ts: T0, jid: JID }, jobs, publishedBy({ PDF_A: { id: 'BONA-W011', slug: 'x' } }));
    assert.equal(pick.kind, 'attach');
    assert.equal(pick.listingId, 'BONA-W011');
  });

  it('asks rather than guesses when two different listings are equally close', () => {
    const jobs = [job('PDF_A', T0, 'done'), job('PDF_B', T0 + 20, 'done')];
    const by = publishedBy({ PDF_A: { id: 'BONA-W001', slug: 'a' }, PDF_B: { id: 'BONA-W002', slug: 'b' } });
    const pick = pickListingForVideo({ ts: T0 + 10, jid: JID }, jobs, by);
    assert.equal(pick.kind, 'ambiguous');
    assert.deepEqual([...pick.listingIds].sort(), ['BONA-W001', 'BONA-W002']);
  });

  it('two equally-close PDFs that published the SAME listing (a duplicate send) are not ambiguous', () => {
    const jobs = [job('PDF_A', T0, 'done'), job('PDF_A2', T0 + 20, 'done')];
    const by = publishedBy({ PDF_A: { id: 'BONA-W001', slug: 'a' }, PDF_A2: { id: 'BONA-W001', slug: 'a' } });
    assert.equal(pickListingForVideo({ ts: T0 + 10, jid: JID }, jobs, by).kind, 'attach');
  });

  it('finds nothing outside the window, in another group, or when the only brochure was rejected', () => {
    const by = publishedBy({ PDF_A: { id: 'BONA-W001', slug: 'a' } });
    assert.equal(pickListingForVideo({ ts: T0 + 3600, jid: JID }, [job('PDF_A', T0, 'done')], by).kind, 'none');
    assert.equal(pickListingForVideo({ ts: T0 + 10, jid: 'other@g.us' }, [job('PDF_A', T0, 'done')], by).kind, 'none');
    assert.equal(pickListingForVideo({ ts: T0 + 10, jid: JID }, [job('PDF_A', T0, 'rejected')], by).kind, 'none');
    assert.equal(pickListingForVideo({ ts: T0 + 10, jid: JID }, [], by).kind, 'none');
  });

  it('never matches a video to another video job, and falls back to the job\'s `at` when it has no `ts`', () => {
    const at = new Date((T0 + 5) * 1000).toISOString();
    const jobs = [
      { id: 'OLD_PDF', jid: JID, at, status: 'done', fileName: 'old.pdf' }, // pre-ts job record
      { id: 'OTHER_VIDEO', jid: JID, ts: T0 + 6, status: 'done', kind: 'video' },
    ];
    const pick = pickListingForVideo({ ts: T0 + 10, jid: JID }, jobs, publishedBy({ OLD_PDF: { id: 'BONA-W003', slug: 'c' } }));
    assert.equal(pick.kind, 'attach');
    assert.equal(pick.listingId, 'BONA-W003');
  });

  it('a done brochure the state can no longer resolve to a listing is skipped, not matched to nothing', () => {
    const jobs = [job('LOST', T0, 'done'), job('PDF_B', T0 + 40, 'done')];
    const pick = pickListingForVideo({ ts: T0 + 10, jid: JID }, jobs, publishedBy({ PDF_B: { id: 'BONA-W002', slug: 'b' } }));
    assert.equal(pick.kind, 'attach');
    assert.equal(pick.listingId, 'BONA-W002');
  });
});

describe('wakeParkedClip — a parked clip comes back once per reason, never on every poll', () => {
  const WAIT = 30 * 60 * 1000;
  const at = (sec) => new Date(sec * 1000).toISOString();
  const parked = (extra = {}) => ({ id: 'VID', jid: JID, kind: 'video', status: 'pending', waitSince: at(T0 + 12), ...extra });

  it('keeps waiting while the named brochure is still publishing, wakes once it has answered', () => {
    const jobs = [job('PDF_A', T0, 'pending')];
    assert.equal(wakeParkedClip(parked({ waitingFor: 'PDF_A' }), jobs, { now: (T0 + 60) * 1000, waitMs: WAIT }).wake, false);
    jobs[0].status = 'done';
    assert.deepEqual(wakeParkedClip(parked({ waitingFor: 'PDF_A' }), jobs, { now: (T0 + 60) * 1000, waitMs: WAIT }), { wake: true, reason: 'brochure-done' });
    assert.equal(wakeParkedClip(parked({ waitingFor: 'PDF_GONE' }), jobs, { now: (T0 + 60) * 1000, waitMs: WAIT }).reason, 'brochure-gone');
  });

  // Codex review 2026-09-06: without tracking, one rejected PDF that arrived after the clip was
  // parked satisfied "a newer brochure exists" on every poll — a requeue loop until expiry. And
  // a timestamp cursor could skip a brochure whose `at` equalled it, so it is ids, not a time.
  it('with nothing to wait on, wakes ONCE per new brochure, tracked by id', () => {
    const jobs = [{ ...job('PDF_LATER', T0 + 40, 'rejected'), at: at(T0 + 45) }];
    const first = wakeParkedClip(parked(), jobs, { now: (T0 + 90) * 1000, waitMs: WAIT });
    assert.equal(first.wake, true);
    assert.equal(first.reason, 'new-brochure');
    assert.deepEqual(first.seen, ['PDF_LATER']);
    // index.mjs stores that list on the job; the same rejected PDF must not wake it again.
    const again = wakeParkedClip(parked({ wakeSeen: first.seen }), jobs, { now: (T0 + 110) * 1000, waitMs: WAIT });
    assert.deepEqual(again, { wake: false, reason: 'nothing-new' });
    // A brochure with the SAME `at` as the first (two PDFs polled in one tick) still wakes it.
    jobs.push({ ...job('PDF_TWIN', T0 + 40, 'pending'), at: at(T0 + 45) });
    const twin = wakeParkedClip(parked({ wakeSeen: first.seen }), jobs, { now: (T0 + 120) * 1000, waitMs: WAIT });
    assert.equal(twin.wake, true);
    assert.deepEqual(twin.seen, ['PDF_LATER', 'PDF_TWIN']);
    // A brochure whose `at` equals waitSince itself counts as new (inclusive), one before it does not.
    assert.equal(wakeParkedClip(parked(), [{ ...job('PDF_SAME_MS', T0 + 12, 'done'), at: at(T0 + 12) }], { now: (T0 + 60) * 1000, waitMs: WAIT }).wake, true);
    assert.equal(wakeParkedClip(parked(), [{ ...job('PDF_BEFORE', T0, 'done'), at: at(T0 + 11) }], { now: (T0 + 60) * 1000, waitMs: WAIT }).wake, false);
  });

  it('ignores other video jobs and other groups when looking for a new brochure', () => {
    const jobs = [
      { id: 'V2', jid: JID, kind: 'video', status: 'pending', at: at(T0 + 50) },
      { ...job('PDF_ELSEWHERE', T0 + 50, 'done'), jid: 'other@g.us', at: at(T0 + 50) },
    ];
    assert.equal(wakeParkedClip(parked(), jobs, { now: (T0 + 90) * 1000, waitMs: WAIT }).wake, false);
  });

  it('wakes on expiry whatever else is true, and never wakes a clip that is not parked', () => {
    assert.deepEqual(wakeParkedClip(parked({ waitingFor: 'PDF_A' }), [job('PDF_A', T0, 'pending')], { now: (T0 + 12) * 1000 + WAIT + 1, waitMs: WAIT }), { wake: true, reason: 'expired' });
    assert.equal(wakeParkedClip({ id: 'V', kind: 'video', status: 'pending' }, [], { waitMs: WAIT }).wake, false);
  });

  it('index.mjs persists the wake list it is handed', () => {
    const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
    const rq = src.slice(src.indexOf('function requeueWaitingVideos('), src.indexOf('// ---------------------------------------------------------------- queue'));
    assert.match(rq, /wakeParkedClip\(job, Object\.values\(state\.raw\.jobs/);
    assert.match(rq, /wakeSeen: w\.seen/);
  });
});

describe('state — video jobs and the message → listing lookup', () => {
  let dir;
  let file;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-video-state-')); file = path.join(dir, 'intake-state.json'); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('publishedByMessage answers from bySha256, and null for an unknown message', () => {
    const s = createState(file);
    s.completePublish({ sha: 'a'.repeat(64), messageId: 'PDF_A', id: 'BONA-W001', slug: 'a', url: 'https://bona.azoz.uk/properties/a/' });
    assert.equal(s.publishedByMessage('PDF_A').id, 'BONA-W001');
    assert.equal(s.publishedByMessage('nope'), null);
  });

  it('a video job is durable like a PDF job and keeps its kind, timestamp and wait target across a reload', () => {
    const s = createState(file);
    s.addJob({ id: 'VID_1', jid: JID, kind: 'video', ts: T0 + 12, caption: '' });
    s.markSeen('VID_1');
    s.updateJob('VID_1', { waitingFor: 'PDF_A', waitSince: '2026-09-06T11:14:30.000Z' });
    const back = createState(file).pendingJobs().find((j) => j.id === 'VID_1');
    assert.equal(back.kind, 'video');
    assert.equal(back.ts, T0 + 12);
    assert.equal(back.waitingFor, 'PDF_A');
    assert.equal(back.status, 'pending');
  });

  it('completeVideo closes the job in one write with what it produced, and clears any wait', () => {
    const s = createState(file);
    s.addJob({ id: 'VID_2', jid: JID, kind: 'video', ts: T0 + 12 });
    s.updateJob('VID_2', { waitingFor: 'PDF_A', waitSince: '2026-09-06T11:14:30.000Z' });
    const done = s.completeVideo({ messageId: 'VID_2', id: 'BONA-W008', src: '/listings/k/v-01.mp4' });
    assert.equal(done.status, 'done');
    assert.equal(done.listingId, 'BONA-W008');
    assert.equal(done.videoSrc, '/listings/k/v-01.mp4');
    assert.equal(done.waitingFor, null);
    assert.equal(createState(file).pendingJobs().some((j) => j.id === 'VID_2'), false, 'never replayed again');
    assert.equal(s.completeVideo({ messageId: 'unknown' }), null);
  });

  // Codex review 2026-09-06: publishEdit pushed, onPushed closed the job, then the WhatsApp
  // reply threw → drain() called failJob(), which reopened a finished publish as `pending`.
  it('failJob never reopens a job that is already closed — a reply failing after the push is not a failed publish', () => {
    const s = createState(file);
    s.addJob({ id: 'VID_3', jid: JID, kind: 'video', ts: T0 });
    s.completeVideo({ messageId: 'VID_3', id: 'BONA-W008', src: '/listings/k/v-01.mp4' });
    const after = s.failJob('VID_3', 'sendText: HTTP 500');
    assert.equal(after.status, 'done');
    assert.equal(after.attempts, 0);
    assert.equal(after.lastError, undefined);
    assert.equal(createState(file).pendingJobs().some((j) => j.id === 'VID_3'), false);
    // The same rule protects a rejected PDF whose reply failed.
    s.addJob({ id: 'PDF_R', jid: JID });
    s.finishJob('PDF_R', 'rejected');
    assert.equal(s.failJob('PDF_R', 'boom').status, 'rejected');
    // And a job still in flight still fails normally.
    s.addJob({ id: 'VID_4', jid: JID, kind: 'video', ts: T0 });
    assert.equal(s.failJob('VID_4', 'boom').status, 'pending');
    assert.equal(s.failJob('VID_4', 'boom').attempts, 2);
  });

  it('forgetSeen lets a dropped message be picked up again — the recovery path for clips the old daemon swallowed', () => {
    const s = createState(file);
    s.markSeen('VID_OLD');
    s.addJob({ id: 'VID_OLD', jid: JID, kind: 'video', ts: T0 });
    s.finishJob('VID_OLD', 'rejected');
    assert.equal(s.forgetSeen(['VID_OLD', 'never-seen']), 1);
    const back = createState(file);
    assert.equal(back.hasSeen('VID_OLD'), false);
    assert.equal(back.getJob('VID_OLD'), null, 'the stale job record goes too, so the replay starts clean');
  });
});

describe('edits.addVideo — a replay or a re-send of the same clip is a no-op, never a second copy', () => {
  it('returns `duplicate` for identical bytes and writes nothing', () => {
    const slug = 'dup-villa';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-video-dup-'));
    try {
      const inbox = path.join(tmp, 'scripts', 'curate', 'inbox');
      fs.mkdirSync(inbox, { recursive: true });
      fs.writeFileSync(path.join(inbox, `${slug}.json`), JSON.stringify({ id: 'BONA-W030', slug, title: { en: 'Dup Villa', ar: 'x' }, images: [], videos: [] }));
      const clip = Buffer.from('the same walkthrough, byte for byte');
      const first = edits.addVideo(tmp, 'BONA-W030', clip);
      assert.equal(first.duplicate, undefined);
      assert.deepEqual(first.listing.videos, [`/listings/${slug}/v-01.mp4`]);

      const again = edits.addVideo(tmp, 'BONA-W030', Buffer.from(clip));
      assert.equal(again.duplicate, true);
      assert.equal(again.video.src, `/listings/${slug}/v-01.mp4`, 'points at the copy that is already there');
      assert.deepEqual(again.listing.videos, [`/listings/${slug}/v-01.mp4`], 'no second entry');
      assert.deepEqual(fs.readdirSync(path.join(tmp, 'public', 'listings', slug)), ['v-01.mp4'], 'no second file');

      const different = edits.addVideo(tmp, 'BONA-W030', Buffer.from('a different clip of the same length!!!!'));
      assert.equal(different.duplicate, undefined);
      assert.equal(different.video.src, `/listings/${slug}/v-02.mp4`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('index.mjs — the video job closes inside the lock, after the push, like a PDF', () => {
  it('uses publishEdit\'s onPushed hook with completeVideo, never a separate finishJob after the reply', () => {
    const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async function handleVideo('), src.indexOf('async function publishEdit('));
    assert.match(fn, /onPushed: \(r\) => state\.completeVideo\(/, 'the close rides on the push');
    assert.ok(!/finishJob\(messageId, 'done'\)/.test(fn), 'no second write after the fact');
    const pe = src.slice(src.indexOf('async function publishEdit('), src.indexOf('async function handleCommand('));
    const push = pe.indexOf('gitCommitPush(');
    const hook = pe.indexOf('onPushed(res)');
    const say = pe.indexOf('reply(jid, replyText(res))');
    assert.ok(push > 0 && push < hook && hook < say, 'push, then the durable close, then — and only then — the reply');
  });
});

describe('poll ordering and timestamps — the brochure is handled before the clip sent after it', () => {
  // Codex review 2026-09-06: with messageTimestamp absent, the old `Number(x || 0)` comparator
  // kept Evolution's newest-first order, so the clip was handled before its PDF job existed
  // and was rejected instead of parked.
  it('messageTs reads a number, a numeric string, milliseconds, or the Baileys Long — and null when absent', () => {
    assert.equal(messageTs({ messageTimestamp: 1757160847 }), 1757160847);
    assert.equal(messageTs({ messageTimestamp: '1757160847' }), 1757160847);
    assert.equal(messageTs({ messageTimestamp: 1757160847000 }), 1757160847, 'milliseconds are tolerated');
    assert.equal(messageTs({ messageTimestamp: { low: 1757160847, high: 0, unsigned: true } }), 1757160847);
    assert.equal(messageTs({ messageTimestamp: null }), null);
    assert.equal(messageTs({}), null);
    assert.equal(messageTs({ messageTimestamp: 'soon' }), null);
  });

  it('oldestFirst sorts by timestamp, and reverses the API order (newest-first) when timestamps are missing', () => {
    const pdf = { key: { id: 'PDF' }, messageTimestamp: 100 };
    const clip = { key: { id: 'CLIP' }, messageTimestamp: 112 };
    assert.deepEqual(oldestFirst([clip, pdf]).map((r) => r.key.id), ['PDF', 'CLIP']);
    // No timestamps at all: Evolution handed us [newest … oldest]; we must handle oldest first.
    assert.deepEqual(oldestFirst([{ key: { id: 'CLIP' } }, { key: { id: 'PDF' } }]).map((r) => r.key.id), ['PDF', 'CLIP']);
    // Long-shaped timestamps sort like numbers.
    const a = { key: { id: 'A' }, messageTimestamp: { low: 200, high: 0 } };
    const b = { key: { id: 'B' }, messageTimestamp: { low: 150, high: 0 } };
    assert.deepEqual(oldestFirst([a, b]).map((r) => r.key.id), ['B', 'A']);
    assert.deepEqual(oldestFirst([]), []);
  });

  it('index.mjs parks a fresh unmatched clip instead of rejecting it, and falls back through ts → job.ts → job.at', () => {
    const src = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async function handleVideo('), src.indexOf('async function publishEdit('));
    assert.match(fn, /messageTs\(record\) \?\? job\?\.ts \?\? \(job\?\.at/, 'three-step timestamp fallback');
    assert.match(fn, /pick\.kind === 'wait' \|\| \(pick\.kind === 'none' && freshClip\)/, 'a fresh clip with no brochure yet waits');
    assert.match(src, /oldestFirst\(records\.filter/, 'the poll handles oldest first');
    const rq = src.slice(src.indexOf('function requeueWaitingVideos('), src.indexOf('// ---------------------------------------------------------------- queue'));
    assert.match(rq, /if \(job\.kind !== 'video' \|\| !job\.waitSince\) continue;/, 'a parked clip is found by waitSince, with or without a named brochure');
  });
});

describe('reply messages — video', () => {
  it('the waiting reply works with no brochure name yet', () => {
    assert.match(msg.videoWaiting(null), /the brochure/);
  });
  it('says so when the clip is already on the listing', () => {
    const t = msg.videoAlreadyOn('BONA-W008', { title: { en: 'Knightsbridge Villas' } }, { n: 1 });
    assert.match(t, /already on/);
    assert.match(t, /video 1/);
  });
  it('tells the owner both ways to attach a clip when nothing matched', () => {
    const t = msg.videoNoId();
    assert.match(t, /brochure/i);
    assert.match(t, /video BONA-W\d{3}/);
  });
  it('lists the candidate ids when two brochures are equally close', () => {
    const t = msg.videoAmbiguous(['BONA-W001', 'BONA-W002']);
    assert.match(t, /BONA-W001/);
    assert.match(t, /BONA-W002/);
    assert.match(t, /video BONA-W001/);
  });
  it('the auto-match reply says which brochure it matched and how far apart they were', () => {
    const listing = { title: { en: 'Knightsbridge Villas' }, videos: ['/listings/k/v-01.mp4'] };
    const t = msg.videoAdded('BONA-W008', listing, { bytes: 3 * 1048576 }, { matched: { deltaSec: 12 } });
    assert.match(t, /Knightsbridge Villas/);
    assert.match(t, /12 s/);
    assert.match(t, /brochure/i);
  });
  it('the waiting reply is one line and mentions the brochure it is waiting on', () => {
    const t = msg.videoWaiting('Knightsbridge_Phase 2_Brochure_EN.pdf');
    assert.equal(t.split('\n').length, 1);
    assert.match(t, /Knightsbridge/);
  });
});
