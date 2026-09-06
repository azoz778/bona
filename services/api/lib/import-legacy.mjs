/**
 * One-time import of the enquiries Dana recorded before the store existed.
 *
 * `leads.jsonl` has always been the raw log; until now it was also the only
 * record. Each line becomes a lead with `legacy_id` = its `id` (and the same
 * `lead_id`, so the ids the owner already has in WhatsApp notes stay valid).
 * Idempotent: a line whose id is already a lead — imported earlier, or written
 * by `createOrMergeLead`, which logs and stores under one id — is skipped. A
 * line whose phone already belongs to another lead is attached as a touchpoint
 * rather than duplicated. Nothing here fans out or notifies: it is history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalisePhone } from './phone.mjs';
import { CHANNELS } from './leads.mjs';

/** The raw log's channel names predate the vocabulary. */
const CHANNEL_MAP = { chat: 'concierge_chat', voice: 'concierge_voice' };

const clean = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * @param {ReturnType<import('./db.mjs').openDb>} db
 * @param {string} dataDir  where `leads.jsonl` lives
 * @returns {{ scanned: number, imported: number, merged: number, skipped: number, bad: number }}
 */
export function importJsonl(db, dataDir) {
  const counts = { scanned: 0, imported: 0, merged: 0, skipped: 0, bad: 0 };
  const file = path.join(dataDir, 'leads.jsonl');
  if (!fs.existsSync(file)) return counts;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());

  db.transaction(() => {
    for (const line of lines) {
      counts.scanned += 1;
      let rec;
      try { rec = JSON.parse(line); } catch { counts.bad += 1; continue; }
      if (!rec || typeof rec !== 'object' || !rec.id) { counts.bad += 1; continue; }
      const id = String(rec.id);
      if (db.getLead(id) || db.getLeadByLegacyId(id)) { counts.skipped += 1; continue; }

      const created = Date.parse(rec.ts) || Date.now();
      const phone = normalisePhone(rec.phone);
      const channel = CHANNEL_MAP[rec.channel] ?? (CHANNELS.includes(rec.channel) ? rec.channel : 'manual');
      const concierge = channel.startsWith('concierge');
      const source = concierge ? 'concierge' : (clean(rec.source, 100) ?? channel);
      const listingId = clean(rec.listingId, 16)?.toUpperCase() ?? null;
      const meta = { legacy_id: id, conversation_id: rec.conversationId ?? null, page: rec.page ?? null };

      const existing = phone ? db.getLeadByPhone(phone) : null;
      if (existing) {
        db.addTouchpoint({ lead_id: existing.lead_id, ts: created, channel, event_type: 'legacy_import', source, medium: '(none)', listing_id: listingId, meta });
        if (!existing.legacy_id) db.updateLead(existing.lead_id, { legacy_id: id });
        counts.merged += 1;
        continue;
      }

      db.insertLead({
        lead_id: id, created, updated: created, phone_e164: phone, wa_jid: null, wa_lid: null,
        name: clean(rec.name, 200), channel, source, medium: '(none)', campaign: null, campaign_id: null, content: null, click_ids: null,
        ref: clean(rec.ref, 8)?.toUpperCase() ?? null, match_method: concierge ? 'concierge' : (channel === 'form' ? 'form' : 'phone'),
        session_id: clean(rec.session_id, 24), anon_id: null, listing_id: /^BONA-W?\d{3}$/.test(listingId ?? '') ? listingId : null,
        first_touch: null, last_touch: null,
        interest: clean(rec.interest), budget: clean(rec.budget, 200), timeline: clean(rec.timeline, 200), district: clean(rec.district, 200),
        language: ['ar', 'en'].includes(String(rec.language ?? '').toLowerCase()) ? String(rec.language).toLowerCase() : null,
        notes: clean(rec.notes, 2000), stage: 'new', stage_ts: created, value_sar: null, first_inbound_ts: null, first_reply_ts: null,
        legacy_id: id, consent_ads: 0, consent_analytics: 0,
      });
      db.setStage(id, 'new', { actor: 'system', note: 'imported from leads.jsonl', now: created });
      db.addTouchpoint({ lead_id: id, ts: created, channel, event_type: 'lead_created', source, medium: '(none)', listing_id: listingId, meta });
      counts.imported += 1;
    }
  });
  return counts;
}
