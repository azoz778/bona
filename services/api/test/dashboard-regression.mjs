// Paths are RELATIVE on purpose. They were absolute, which meant the harness always
// imported the original working tree no matter where it was run from — a round-2
// reviewer copied the repo, deliberately broke the source, and still got 18/18 PASS.
// A check that cannot fail is worse than no check, because it is trusted.
import { openDb } from '../lib/db.mjs';
import * as R from '../lib/dashboard/render.mjs';

const now = Date.now();
let bad = 0;
const ok = (label, pass, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) bad += 1;
};

// H1 — NULL stage must appear in the waiting queue
const db = openDb(':memory:');
db.insertLead({ lead_id: 'a', created: now, updated: now, phone_e164: '+966500000001', name: 'A', stage: 'new', first_inbound_ts: now - 3600000 });
db.insertLead({ lead_id: 'b', created: now, updated: now, phone_e164: '+966500000002', name: 'B', stage: null, first_inbound_ts: now - 7200000 });
db.insertLead({ lead_id: 'c', created: now, updated: now, phone_e164: '+966500000003', name: 'C', stage: 'won', first_inbound_ts: now - 7200000 });
const got = db.waitingLeads({ limit: 50 }).map((l) => l.lead_id);
ok('H1 NULL-stage lead is in the queue', got.includes('b'), JSON.stringify(got));
ok('H1 won is still excluded', !got.includes('c'));
ok('H1 countWaitingLeads agrees', db.countWaitingLeads() === got.length, `count=${db.countWaitingLeads()}`);

// H2 — hero shows the TRUE count, not the capped slice
const waiting = Array.from({ length: 50 }, (_, i) => ({
  lead_id: `w${i}`, name: `W${i}`, phone_e164: '+96650000' + String(1000 + i),
  stage: 'new', created: now - 86400000, stage_ts: now - 86400000,
  first_inbound_ts: now - 86400000, first_reply_ts: null,
}));
const html = R.overviewPage({
  daily: [], sources: [], matchQuality: [],
  responseTimes: { median_min: null, p90_min: null, count: 0 },
  pipeline: [{ stage: 'new', count: 412, median_age_h: 24 }],
  days: 14, waiting, waitingTotal: 412, now,
});
const hero = (html.match(/<span class="n[^"]*">(\d+)<\/span>/) || [])[1];
ok('H2 hero reports the real total', hero === '412', `hero=${hero}`);
ok('H2 "more waiting" is the remainder', /406 more waiting/.test(html));

// H2b — with no total supplied it must fall back to the slice, not crash
const fb = R.overviewPage({
  daily: [], sources: [], matchQuality: [],
  responseTimes: { median_min: null, p90_min: null, count: 0 },
  pipeline: [], days: 14, waiting, now,
});
ok('H2 falls back to slice when total absent', /<span class="n">50<\/span>/.test(fb));

// M1 — all-NULL lead must not render a 57-year wait
const nullLead = { lead_id: 'n', name: null, phone_e164: null, stage: null, created: null, stage_ts: null, first_inbound_ts: null, first_reply_ts: null };
const card = R.leadCard(nullLead, now);
// ago() separates with NBSP (U+00A0). The original regexes here used an ASCII space,
// so they matched nothing and passed unconditionally — they were decoration, not tests.
const BIGWAIT = /\d{4,}[\s\u00a0]d/;
ok('M1 regex actually matches a bad value', BIGWAIT.test(R.ago(1.757e12)), 'self-check of the assertion itself');
ok('M1 no 20k-day wait badge', !BIGWAIT.test(card), (card.match(/<span class="wait[^"]*">([^<]*)</) || [])[1]);
ok('M1 replyLine omits the bogus clause', !BIGWAIT.test(R.replyLine(nullLead, now)), R.replyLine(nullLead, now));
ok('M1 agoSince(null) is an em-dash', R.agoSince(now, null) === '—', JSON.stringify(R.agoSince(now, null)));
ok('M1 Age column has no 20k-day value', !BIGWAIT.test(
  R.leadsPage({ board: {}, counts: null, leads: [nullLead], total: 1, now })));
ok('M1 lead detail has no 20k-day value', !BIGWAIT.test(
  R.leadDetailPage({ lead: nullLead, journey: [], now })));

// M2 — rail must not fall back to the rendered slice for BigInt/string counts
const L = (id) => ({ lead_id: id, name: id, phone_e164: '+966500000009', stage: 'new', created: now, stage_ts: now, first_inbound_ts: now - 3600000, first_reply_ts: now - 1800000 });
for (const [label, c] of [['BigInt', { new: 412n }], ['string', { new: '412' }]]) {
  const h = R.leadsPage({ board: { new: [L('a'), L('b'), L('c')] }, counts: c, leads: [], total: 412, now });
  ok(`M2 ${label} count reports 412 not 3`, /<b>412<\/b>/.test(h) && !/<b>3<\/b>\s*<span>New</.test(h));
}
const partial = R.leadsPage({ board: { new: [L('a'), L('b')] }, counts: { contacted: 77 }, leads: [], total: 79, now });
ok('M2 partial counts does not print the slice', !/<b>2<\/b>/.test(partial));

// M4 — a missing section must not take the page down
try {
  R.overviewPage({ daily: [], sources: [], matchQuality: [], responseTimes: { median_min: null, p90_min: null, count: 0 }, days: 14 });
  ok('M4 missing pipeline does not throw', true);
} catch (e) { ok('M4 missing pipeline does not throw', false, e.message); }

// L1 / L3 / L4
ok('L1 dateTime(null) is an em-dash', R.dateTime(null) === '—', JSON.stringify(R.dateTime(null)));
try { R.leadsPage({ board: {}, counts: null, leads: null, total: 0, now }); ok('L3 null leads does not throw', true); }
catch (e) { ok('L3 null leads does not throw', false, e.message); }
try { db.waitingLeads({ limit: 1.7 }); ok('L4 fractional limit does not throw', true); }
catch (e) { ok('L4 fractional limit does not throw', false, e.message); }

// Escaping must still hold after all the edits
const eviln = R.leadCard({ lead_id: 'x"><script>alert(1)</script>', name: '<img src=x onerror=alert(1)>', phone_e164: 'javascript:alert(1)//966500000000', stage: 'new', created: now, stage_ts: now, first_inbound_ts: now - 3600000, first_reply_ts: null, district: '" onmouseover="alert(1)" x="' }, now);
ok('XSS no raw <img', !/<img/.test(eviln));
ok('XSS no <script', !/<script/i.test(eviln));
ok('XSS no javascript: href', !/href="javascript:/i.test(eviln));

// Round-2 N-1: SQL says `first_reply_ts IS NULL`; JS used truthiness. 0 is NOT NULL,
// so the two predicates disagreed and the hero count could contradict the cards.
const replied0 = { lead_id: 'z', name: 'Z', phone_e164: '+966500000009', stage: 'new',
  created: now - 7200000, stage_ts: now - 7200000, first_inbound_ts: now - 7200000, first_reply_ts: 0 };
ok('N1 first_reply_ts=0 is NOT waiting (matches SQL IS NULL)', R.waitState(replied0, now).waiting === false);
const db2 = openDb(':memory:');
db2.insertLead({ lead_id: 'z', created: now, updated: now, phone_e164: '+966500000009', name: 'Z', stage: 'new', first_inbound_ts: now - 7200000, first_reply_ts: 0 });
ok('N1 SQL agrees it is not waiting', db2.countWaitingLeads() === 0, `count=${db2.countWaitingLeads()}`);
// The count and the sentence beside it must agree: an excluded lead must not still
// describe itself as waiting on its own card.
ok('N1 replyLine agrees it is not waiting', !/Waiting .* for your first reply/.test(R.replyLine(replied0, now)),
   R.replyLine(replied0, now));
ok('N1 card text agrees', !/Waiting .* for your first reply/.test(R.leadCard(replied0, now)));

// R1 — a reply time a human can read. The raw stat is minutes with one decimal,
// which is right for 14 min and absurd for 344.2 min. Real production data (median
// 344.2, p90 3520.5) is what surfaced this.
ok('R1 minutes stay minutes under 90', JSON.stringify(R.minutesReadable(13.7)) === '["13.7","min"]', JSON.stringify(R.minutesReadable(13.7)));
ok('R1 344.2 min becomes 5.7 hours', JSON.stringify(R.minutesReadable(344.2)) === '["5.7","hours"]', JSON.stringify(R.minutesReadable(344.2)));
ok('R1 3520.5 min becomes 2.4 days', JSON.stringify(R.minutesReadable(3520.5)) === '["2.4","days"]', JSON.stringify(R.minutesReadable(3520.5)));
// Number(null) is 0 and 0 is finite, so a missing stat must be rejected BEFORE
// coercion or the page prints a confident "0 min" for something never measured.
ok('R1 null is not 0 min', R.minutesReadable(null) === null, JSON.stringify(R.minutesReadable(null)));
ok('R1 undefined is not 0 min', R.minutesReadable(undefined) === null);
ok('R1 empty string is not 0 min', R.minutesReadable('') === null);

// R2 — leads that arrive straight into WhatsApp from an ad never touched the site, so
// leads can exceed on-site wa_clicks. Printing that as a conversion rate claimed
// "500% became a lead" on the real dashboard.
const skew = R.overviewPage({
  daily: [{ day: '2026-09-16', sessions: 319, wa_clicks: 2, leads: 10, viewings: 0 }],
  sources: [], matchQuality: [],
  responseTimes: { median_min: 344.2, p90_min: 3520.5, count: 8 },
  pipeline: [{ stage: 'new', count: 10, median_age_h: 42 }], days: 14, waiting: [], waitingTotal: 0, now,
});
ok('R2 no impossible conversion rate', !/\b[1-9]\d\d+%\s*became a lead/.test(skew),
  (skew.match(/\d+% became a lead/) || [])[0]);
ok('R2 says why the counts do not nest', /never visited/.test(skew));
ok('R2 no raw 344.2 min in the page', !/344\.2<\/span><i>min/.test(skew));

console.log(bad ? `\n${bad} FAILURE(S)` : '\nALL REGRESSION CHECKS PASS');process.exit(bad ? 1 : 0);
