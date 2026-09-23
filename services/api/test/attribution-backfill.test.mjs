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
  assert.throws(() => restoreRestrictedBackup(file, backup.manifestFile), /API.*offline/i);
  assert.throws(() => restoreRestrictedBackup(file, backup.manifestFile, { force: true }), /API.*offline/i);
  assert.throws(() => restoreRestrictedBackup(file, backup.manifestFile, { apiOffline: true }), /target has changed/i);
  restoreRestrictedBackup(file, backup.manifestFile, { force: true, apiOffline: true });
  db = openDb(file);
  assert.equal(db.getLead('lead-one').source, null);
  assert.equal(db.countLeads(), 3);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backfilled touch is never proposed when it conflicts with a source already recorded on the lead', () => {
  const db = openDb(':memory:');
  db.upsertSession({ session_id: 'sess-conflict', anon_id: 'b'.repeat(32), ref: 'CFL123', started: 100, last_seen: 200, first_touch: TOUCH, last_touch: TOUCH });
  db.insertLead({
    lead_id: 'lead-conflict', created: 200, updated: 200, phone_e164: '966500000004',
    source: 'whatsapp_organic', medium: '(none)', session_id: 'sess-conflict', stage: 'new',
  });
  const report = planAttributionBackfill(db);
  const change = report.changes.find((c) => c.lead_id === 'lead-conflict');
  assert.ok(change, 'non-conflicting touch history may still be backfilled');
  for (const field of ['source', 'medium', 'campaign', 'campaign_id', 'click_ids']) {
    assert.equal(Object.hasOwn(change.patch, field), false, `${field} must not be stitched onto a conflicting attribution`);
  }
  db.close();
});

test('newer session attribution is not combined with an older ad referral', () => {
  const db = openDb(':memory:');
  const google = { ts: 300, utm_source: 'google', utm_medium: 'cpc', click_ids: { gclid: 'new-google' } };
  db.upsertSession({ session_id: 'sess-newest', anon_id: 'c'.repeat(32), ref: 'NEW123', started: 100, last_seen: 300, first_touch: google, last_touch: google });
  db.insertLead({ lead_id: 'lead-newest', created: 350, updated: 350, phone_e164: '966500000005', session_id: 'sess-newest', stage: 'new' });
  db.addTouchpoint({
    id: 'tp-older-meta', lead_id: 'lead-newest', ts: 200, channel: 'whatsapp', event_type: 'lead_created',
    source: 'meta', medium: 'paid', campaign: 'old-meta', campaign_id: 'meta-1', meta: { ad_meta: { ctwa_clid: 'old-click' } },
  });

  const change = planAttributionBackfill(db).changes.find((c) => c.lead_id === 'lead-newest');
  assert.equal(change.patch.source, 'google');
  assert.equal(change.patch.medium, 'cpc');
  assert.deepEqual(change.patch.click_ids, { gclid: 'new-google' });
  assert.equal(Object.hasOwn(change.patch, 'campaign_id'), false);
  assert.equal(change.evidence.includes('whatsapp_referral'), false);
  db.close();
});

test('a newer ad referral replaces the older browser attribution as one coherent bundle', () => {
  const db = openDb(':memory:');
  const google = {
    ts: 100, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'old-google',
    utm_id: 'google-old', utm_content: 'old-content', click_ids: { gclid: 'old-google-click' },
  };
  db.upsertSession({ session_id: 'sess-ad-newer', started: 100, last_seen: 200, first_touch: google, last_touch: google });
  db.insertLead({ lead_id: 'lead-ad-newer', created: 300, updated: 300, session_id: 'sess-ad-newer', stage: 'new' });
  db.addTouchpoint({
    id: 'tp-new-meta', lead_id: 'lead-ad-newer', ts: 200, channel: 'whatsapp', event_type: 'lead_created',
    source: 'meta', medium: 'paid', campaign: null, campaign_id: 'new-meta', meta: { ad_meta: {} },
  });

  const change = planAttributionBackfill(db).changes.find((c) => c.lead_id === 'lead-ad-newer');
  assert.equal(change.patch.source, 'meta');
  assert.equal(change.patch.medium, 'paid');
  assert.equal(change.patch.campaign_id, 'new-meta');
  assert.equal(Object.hasOwn(change.patch, 'campaign'), false);
  assert.equal(Object.hasOwn(change.patch, 'content'), false);
  assert.equal(Object.hasOwn(change.patch, 'click_ids'), false);
  assert.equal(change.patch.last_touch.ts, 200);
  assert.equal(change.patch.last_touch.utm_id, 'new-meta');
  assert.equal(change.evidence.includes('whatsapp_referral'), true);
  db.close();
});
