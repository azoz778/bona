import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';
import { importJsonl } from '../lib/import-legacy.mjs';
import { appendLead, createOrMergeLead } from '../lib/leads.mjs';

const LEGACY = [
  { id: 'LEAD-20260905-0a1b2c3d', ts: '2026-09-05T20:00:00.000Z', source: 'concierge', channel: 'chat', name: 'Sara', phone: '+966 50 000 0000', interest: 'villa in Al Shati', budget: '8m', notes: 'evenings', language: 'ar', conversationId: 'chat_1', page: 'https://bona.azoz.uk/ar/' },
  { id: 'LEAD-20260905-4e5f6a7b', ts: '2026-09-05T21:30:00.000Z', source: 'concierge', channel: 'voice', phone: '0500000001', listingId: 'BONA-005', conversationId: 'call_7', page: null },
];

function dataDirWith(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-import-'));
  fs.writeFileSync(path.join(dir, 'leads.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return dir;
}

test('every line of leads.jsonl becomes a lead once, keeping its id and its time', () => {
  const dir = dataDirWith(LEGACY);
  const db = openDb(':memory:');
  assert.deepEqual(importJsonl(db, dir), { scanned: 2, imported: 2, merged: 0, skipped: 0, bad: 0 });
  const sara = db.getLead('LEAD-20260905-0a1b2c3d');
  assert.equal(sara.legacy_id, 'LEAD-20260905-0a1b2c3d');
  assert.equal(sara.channel, 'concierge_chat');
  assert.equal(sara.source, 'concierge');
  assert.equal(sara.match_method, 'concierge');
  assert.equal(sara.created, Date.parse('2026-09-05T20:00:00.000Z'));
  assert.equal(sara.phone_e164, '966500000000');
  assert.equal(sara.name, 'Sara');
  assert.equal(sara.language, 'ar');
  assert.equal(sara.notes, 'evenings');
  assert.equal(sara.stage, 'new');
  assert.equal(sara.stage_ts, sara.created);
  assert.deepEqual(db.stageHistory(sara.lead_id).map((r) => [r.stage, r.actor]), [['new', 'system']]);
  const tps = db.touchpointsForLead(sara.lead_id);
  assert.equal(tps.length, 1);
  assert.equal(tps[0].event_type, 'lead_created');
  assert.equal(tps[0].meta.conversation_id, 'chat_1');
  const voice = db.getLead('LEAD-20260905-4e5f6a7b');
  assert.equal(voice.channel, 'concierge_voice');
  assert.equal(voice.listing_id, 'BONA-005');
  assert.equal(db.getLeadByLegacyId('LEAD-20260905-4e5f6a7b').lead_id, voice.lead_id);
  assert.equal(db.recentEvents({ name: 'lead_created' }).length, 0, 'history: no events, no fan-out');
  assert.deepEqual(db.fanoutCounts(), { pending: 0, sent: 0, failed: 0, skipped: 0 });

  assert.deepEqual(importJsonl(db, dir), { scanned: 2, imported: 0, merged: 0, skipped: 2, bad: 0 }, 'a rerun changes nothing');
  assert.equal(db.listLeads().length, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a legacy line whose phone is already a lead attaches to it; broken lines are counted, not fatal', () => {
  const dir = dataDirWith([LEGACY[0], '{not json', { ts: '2026-09-05T20:00:00Z', phone: 'no id' }]);
  const db = openDb(':memory:');
  const { lead } = createOrMergeLead(db, { phone: '0500000000', name: 'Sara A.' }, { channel: 'whatsapp', matchMethod: 'ref', now: Date.now() });
  assert.deepEqual(importJsonl(db, dir), { scanned: 3, imported: 0, merged: 1, skipped: 0, bad: 2 });
  assert.equal(db.listLeads().length, 1);
  assert.equal(db.getLead(lead.lead_id).legacy_id, 'LEAD-20260905-0a1b2c3d');
  assert.deepEqual(db.touchpointsForLead(lead.lead_id).map((t) => t.event_type), ['legacy_import', 'lead_created'], 'the legacy touch is dated when it happened, so it comes first');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('lines the store itself wrote are recognised by id and skipped, and no file at all is fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-import-'));
  const db = openDb(':memory:');
  assert.deepEqual(importJsonl(db, dir), { scanned: 0, imported: 0, merged: 0, skipped: 0, bad: 0 });
  createOrMergeLead(db, { phone: '0500000002', name: 'New' }, { channel: 'form', now: Date.now(), dataDir: dir });
  appendLead(dir, { phone: '0500000003' }, { id: 'LEAD-20260906-ffffffff', channel: 'chat' });
  assert.deepEqual(importJsonl(db, dir), { scanned: 2, imported: 1, merged: 0, skipped: 1, bad: 0 });
  assert.equal(db.listLeads().length, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
