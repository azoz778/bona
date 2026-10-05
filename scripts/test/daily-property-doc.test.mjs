// docs/daily-property-publishing.md is followed by hand when a property attempt is uncertain, and
// the publisher reads the lines it prescribes back: dayState and unsettled by channel, date and
// id, the 30-day repeat rule by channel, listingId and an ISO `at`, the Instagram ledger by id.
// A template missing any of those leaves the channel blocked for good or lets the same property
// return within 30 days. The verification command has to simulate today's slot, not the day
// the doc was written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as daily from '../social/lib/property-daily.mjs';
import { indexLedger } from '../social/lib/ledger.mjs';
import { legacyDayState } from '../social/property-publish.mjs';

const doc = fs.readFileSync(new URL('../../docs/daily-property-publishing.md', import.meta.url), 'utf8');
function between(from, to) {
  const i = doc.indexOf(from);
  assert.ok(i >= 0, `the doc has ${from}`);
  const j = doc.indexOf(to, i);
  return doc.slice(i, j < 0 ? undefined : j);
}
const reconcile = between('**Reconciling an uncertain attempt.**', '## Monitoring');
const templates = [...reconcile.matchAll(/`(\{"channel":[^`]*\})`/g)].map(m => JSON.parse(m[1]));
const ledgerLines = [...reconcile.matchAll(/`(\{"id":[^`]*\})`/g)].map(m => JSON.parse(m[1]));
const D = '2026-10-05';
const fill = t => ({ ...JSON.parse(JSON.stringify(t).replaceAll('YYYY-MM-DD', D).replaceAll('BONA-…', 'BONA-001')),
  at: t.status === 'published' ? '2026-10-05T17:31:00Z' : '2026-10-05T18:10:00Z' });
function attempt(row) {
  const intent = { channel: row.channel, date: D, id: row.id, listingId: row.listingId, status: 'intent', at: '2026-10-05T17:30:05Z' };
  return [intent, { ...intent, status: 'uncertain', at: '2026-10-05T17:31:30Z' }, row];
}

test('reconciliation gives a published and a confirmed-not-published line for each channel, keyed like the journal', () => {
  assert.deepEqual(templates.map(t => `${t.channel} ${t.status}`).sort(),
    ['facebook confirmed-not-published', 'facebook published', 'instagram confirmed-not-published', 'instagram published']);
  for (const t of templates) {
    assert.equal(t.date, 'YYYY-MM-DD');
    assert.equal(t.id, `bona-daily-${t.channel === 'instagram' ? 'ig' : 'fb'}-YYYY-MM-DD`);
    assert.match(t.listingId ?? '', /^BONA-/, `${t.channel} ${t.status} carries the listing id`);
    for (const k of ['evidence', 'at']) assert.ok(t[k], `${t.channel} ${t.status} carries ${k}`);
  }
  assert.ok(templates.find(t => t.channel === 'instagram' && t.status === 'published').mediaId);
  assert.ok(templates.find(t => t.channel === 'facebook' && t.status === 'published').postId);
  for (const where of ['~/bona-data/daily/property.jsonl', '~/bona-data/daily/.property-<channel>.lock',
    '~/bona-data/ig/published.jsonl', '~/bona-data/fb/published.jsonl']) assert.ok(reconcile.includes(where), `names ${where}`);
});

test('a reconciled published line closes the day and starts the 30-day repeat interval', () => {
  const published = templates.filter(t => t.status === 'published').map(fill);
  assert.equal(published.length, 2, 'one published template per channel');
  for (const row of published) {
    const events = attempt(row);
    assert.equal(daily.dayState(events, row.channel, D), 'published');
    const next = daily.chooseProperty([{ id: row.listingId }], {}, null, events, row.channel, new Date('2026-10-06T17:30:00Z'), 30);
    assert.ok(next.rejected[0].reasons.includes('recently_published'), `${row.channel}: the repeat interval counts from the reconciled line`);
  }
});

test('a reconciled line settles the attempt on its channel',
  { skip: typeof daily.unsettled !== 'function' && 'confirmed-not-published settlement lands with the property-waiver code' }, () => {
    for (const row of templates.map(fill)) {
      const events = attempt(row);
      assert.equal(daily.unsettled(events, row.channel), false, `${row.channel} ${row.status}`);
      assert.equal(daily.dayState(events, row.channel, D), row.status === 'published' ? 'published' : 'ready');
    }
  });

test('the Instagram ledger lines settle a publishing line; an absent post keeps that date closed', () => {
  assert.deepEqual(ledgerLines.map(t => `${t.id} ${t.status}`), ['bona-daily-ig-YYYY-MM-DD error']);
  const publishing = { id: `bona-daily-ig-${D}`, date: D, status: 'publishing', containerId: 'c1', ts: '2026-10-05T17:30:40Z' };
  const error = fill(ledgerLines[0]), published = fill(templates.find(t => t.channel === 'instagram' && t.status === 'published'));
  for (const line of [error, published]) assert.equal(indexLedger([publishing, line]).get(publishing.id).inFlight, null, `${line.status} settles it`);
  assert.equal(indexLedger([publishing]).get(publishing.id).inFlight, publishing);
  assert.equal(legacyDayState([publishing, published], D), 'published');
  assert.equal(legacyDayState([publishing, error], D), 'uncertain');
  assert.equal(legacyDayState([publishing, error], '2026-10-06'), 'ready');
});

test("the verification command simulates today's slot, not a fixed date", () => {
  const verify = between('## Verification', '## Rollback');
  assert.ok(verify.includes('BONA_DAILY_TEST_NOW="$(TZ=Asia/Riyadh date +%F)T17:30:00Z"'));
  assert.doesNotMatch(verify, /BONA_DAILY_TEST_NOW=\d{4}-/);
});
