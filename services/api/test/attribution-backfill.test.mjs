import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { planAttributionBackfill, applyAttributionBackfill, createRestrictedBackup, restoreRestrictedBackup } from '../lib/attribution-backfill.mjs';

const TOUCH = { ts: 100, utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'launch', utm_id: '1203', click_ids: { fbclid: 'click' } };

function fixture(file = ':memory:') {
  const db = openDb(file);
  db.upsertSession({ session_id: 'sess-one', anon_id: 'a'.repeat(32), ref: 'ABC234', started: 100, last_seen: 200, first_touch: TOUCH, last_touch: TOUCH });
  db.insertEvent({ event_id: 'ev-one', ts: 150, name: 'listing_view', session_id: 'sess-one', anon_id: 'a'.repeat(32), listing_id: 'BONA-W003' });
  db.insertLead({ lead_id: 'lead-one', created: 200, updated: 200, phone_e164: '966500000001', session_id: 'sess-one', stage: 'new' });
  db.insertLead({ lead_id: 'lead-two', created: 300, updated: 300, phone_e164: '966500000002', source: 'manual', campaign_id: 'keep-me', listing_id: 'BONA-002', stage: 'new' });
  db.insertLead({ lead_id: 'lead-three', created: 400, updated: 400, phone_e164: '966500000003', stage: 'new' });
  return db;
}

test('backfill proposes only deterministic missing fields and leaves unknown explicit', () => {
  const db = fixture();
  const report = planAttributionBackfill(db);
  assert.equal(report.total_leads, 3);
  assert.equal(report.proposed_updates, 1);
  assert.equal(report.untouched, 2);
  assert.equal(report.ambiguous, 0);
  assert.equal(report.unknown, 1);
  assert.equal(report.changes[0].lead_ref.length, 12);
  assert.equal(Object.hasOwn(report.changes[0], 'phone'), false);
  assert.deepEqual({
    source: report.changes[0].patch.source,
    medium: report.changes[0].patch.medium,
    campaign: report.changes[0].patch.campaign,
    campaign_id: report.changes[0].patch.campaign_id,
    click_ids: report.changes[0].patch.click_ids,
    listing_id: report.changes[0].patch.listing_id,
  }, {
    source: 'meta', medium: 'paid', campaign: 'launch', campaign_id: '1203',
    click_ids: { fbclid: 'click' }, listing_id: 'BONA-W003',
  });
  assert.equal(report.changes[0].patch.first_touch.utm_id, '1203');
  assert.equal(report.changes[0].patch.last_touch.utm_id, '1203');
  assert.deepEqual(report.changes[0].evidence, ['session_touch', 'session_exact_listing']);
  assert.equal(db.getLead('lead-one').source, null, 'dry-run does not write');
  db.close();
});

test('backfill apply is idempotent and preserves lead count and populated fields', () => {
  const db = fixture();
  const before = db.countLeads();
  const first = applyAttributionBackfill(db);
  assert.equal(first.applied, 1);
  assert.equal(first.lead_count_before, before);
  assert.equal(first.lead_count_after, before);
  assert.equal(db.getLead('lead-one').listing_id, 'BONA-W003');
  assert.equal(db.getLead('lead-two').campaign_id, 'keep-me');
  const second = applyAttributionBackfill(db);
  assert.equal(second.applied, 0);
  assert.equal(db.countLeads(), before);
  db.close();
});

test('restricted backup can restore the exact database and refuses a changed target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-backfill-'));
  const file = path.join(dir, 'bona.db');
  let db = fixture(file);
  db.close();
  const backup = createRestrictedBackup(file, { backupDir: path.join(dir, 'backups'), now: () => 1234 });
  assert.equal(fs.statSync(backup.file).mode & 0o777, 0o600);
  db = openDb(file);
  applyAttributionBackfill(db);
  db.close();
  assert.throws(() => restoreRestrictedBackup(file, backup.manifestFile), /target has changed/i);
  restoreRestrictedBackup(file, backup.manifestFile, { force: true });
  db = openDb(file);
  assert.equal(db.getLead('lead-one').source, null);
  assert.equal(db.countLeads(), 3);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
