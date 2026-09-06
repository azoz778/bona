/**
 * Leads.
 *
 * Two records for every enquiry: a row in `bona.db` (the working record — merged
 * by phone or WhatsApp jid, carrying the visitor's source, touchpoints and pipeline
 * stage) and a line in `${BONA_DATA}/leads.jsonl` (the append-only raw log, written
 * once per *new* lead and never rewritten — the thing that must survive a crash
 * mid-conversation).
 *
 * `createOrMergeLead()` is the one write path. The WhatsApp poller, the enquiry
 * form and Dana's `create_lead` tool all go through it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomId } from './store.mjs';
import { normalisePhone } from './phone.mjs';
import { sourceFromTouch } from './attribution.mjs';
import { newId } from './db.mjs';

export const LEAD_FIELDS = ['name', 'phone', 'interest', 'budget', 'timeline', 'notes', 'language', 'district', 'listingId'];

export const CHANNELS = ['whatsapp', 'form', 'concierge_chat', 'concierge_voice', 'manual'];
export const MATCH_METHODS = ['ref', 'phone', 'keyword', 'time_window', 'concierge', 'form', 'ad_meta'];

/** Where a lead came from when there is no session to say better. */
const DEFAULT_SOURCE = { whatsapp: 'whatsapp_organic', form: 'form', concierge_chat: 'concierge', concierge_voice: 'concierge', manual: 'manual' };
/** The touchpoint written when an existing lead is heard from again. */
const MERGE_EVENT = { whatsapp: 'inbound_message', form: 'form_submit', concierge_chat: 'concierge', concierge_voice: 'concierge', manual: 'manual' };
/** The raw log predates the channel vocabulary; its old names stay so the file reads as one. */
const RAW_LOG_CHANNEL = { concierge_chat: 'chat', concierge_voice: 'voice' };
/** What every destination is told about on a new lead. */
const LEAD_FANOUT = ['meta', 'ga4', 'snap'];

/** Keep only known fields, trim, cap length — the values come from an LLM. */
export function normaliseLead(input = {}) {
  const out = {};
  for (const key of LEAD_FIELDS) {
    const v = input[key];
    if (v == null || v === '') continue;
    out[key] = String(v).replace(/\s+/g, ' ').trim().slice(0, 500);
  }
  if (out.language && !['ar', 'en'].includes(out.language.toLowerCase())) delete out.language;
  else if (out.language) out.language = out.language.toLowerCase();
  return out;
}

/** `LEAD-YYYYMMDD-<8 hex>` — the id format the raw log has always used. */
export function leadId(now = Date.now()) {
  return `LEAD-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomId(4)}`;
}

/**
 * Append one enquiry to the raw log. `meta.id` / `meta.ts` let the store and the
 * log share one id and one time; without them both are minted here.
 */
export function appendLead(dataDir, lead, meta = {}) {
  const record = {
    id: meta.id ?? leadId(),
    ts: meta.ts ? new Date(meta.ts).toISOString() : new Date().toISOString(),
    source: meta.source ?? 'concierge',
    channel: meta.channel ?? 'chat',
    ...normaliseLead(lead),
    ...(meta.extra ?? {}),
  };
  const file = path.join(dataDir, 'leads.jsonl');
  // Enquiries are personal data: the directory is owner-only and so is every file in it.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return record;
}

/** Append one line to another jsonl in the data dir (calls.jsonl, chats.jsonl…). */
export function appendJsonl(dataDir, name, record) {
  const file = path.join(dataDir, name);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  return file;
}

/* ------------------------------------------------------------------ */
/* The lead model                                                      */
/* ------------------------------------------------------------------ */

const oneLine = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
/** Notes keep their line breaks — a form message is a paragraph, not a field. */
const multiLine = (v, max = 2000) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s ? s.slice(0, max) : null;
};
const asLanguage = (v) => { const s = oneLine(v, 8)?.toLowerCase(); return s === 'ar' || s === 'en' ? s : null; };
const asListingId = (v) => { const s = oneLine(v, 16)?.toUpperCase(); return s && /^BONA-W?\d{3}$/.test(s) ? s : null; };
const asRef = (v) => { const s = oneLine(v, 8)?.toUpperCase(); return s && /^[A-HJ-NP-Z2-9]{5,6}$/.test(s) ? s : null; };

/**
 * Create a lead, or merge into the one that already has this phone (or, failing a
 * phone, this WhatsApp jid/lid).
 *
 * @param {ReturnType<import('./db.mjs').openDb>} db
 * @param {{ name?, phone?, waJid?, waLid?, interest?, budget?, timeline?, district?, listingId?, language?, notes?, snippet? }} input
 * @param {{ channel: 'whatsapp'|'form'|'concierge_chat'|'concierge_voice'|'manual',
 *           matchMethod?: 'ref'|'phone'|'keyword'|'time_window'|'concierge'|'form'|'ad_meta',
 *           sessionId?, anonId?, ref?, eventId?, adMeta?, now?: number,
 *           dataDir?: string, raw?: object }} meta
 *   `dataDir` is where the raw log lives (defaults to the directory of the db file);
 *   `raw` holds extra fields for the raw-log line only (e.g. the Retell conversation id).
 * @returns {{ lead: object, created: boolean }}
 */
export function createOrMergeLead(db, input = {}, meta = {}) {
  const now = meta.now ?? Date.now();
  const channel = CHANNELS.includes(meta.channel) ? meta.channel : 'manual';
  const matchMethod = MATCH_METHODS.includes(meta.matchMethod)
    ? meta.matchMethod
    : (channel === 'form' ? 'form' : channel.startsWith('concierge') ? 'concierge' : 'phone');

  const phone = normalisePhone(input.phone);
  const waJid = oneLine(input.waJid, 100);
  const waLid = oneLine(input.waLid, 100);
  const fields = {
    name: oneLine(input.name, 200), interest: oneLine(input.interest), budget: oneLine(input.budget, 200),
    timeline: oneLine(input.timeline, 200), district: oneLine(input.district, 200),
    language: asLanguage(input.language), listing_id: asListingId(input.listingId),
  };
  const notes = multiLine(input.notes);
  const snippet = oneLine(input.snippet, 200);

  // The visitor's session: by id when the caller has one, else by the Ref code.
  let session = meta.sessionId ? db.getSession(meta.sessionId) : null;
  if (!session && meta.ref) session = db.getSessionByRef(meta.ref);
  const src = session
    ? sourceFromTouch(session.last_touch)
    : { source: DEFAULT_SOURCE[channel], medium: '(none)', campaign: null, campaign_id: null, content: null, click_ids: null };
  const ref = asRef(meta.ref) ?? session?.ref ?? null;
  const sessionId = session?.session_id ?? null;
  const anonId = oneLine(meta.anonId, 32) ?? session?.anon_id ?? null;
  const touchMeta = { match_method: matchMethod, ref, session_id: sessionId, event_id: meta.eventId ?? null, ad_meta: meta.adMeta ?? null, snippet };

  return db.transaction(() => {
    let existing = phone ? db.getLeadByPhone(phone) : null;
    if (!existing && waJid) existing = db.getLeadByJid(waJid);
    if (!existing && waLid) existing = db.getLeadByJid(waLid);

    if (existing) {
      // A merge fills what is empty and appends notes; it never blanks a field.
      const patch = { updated: now };
      for (const k of Object.keys(fields)) if (fields[k] && !existing[k]) patch[k] = fields[k];
      if (phone && !existing.phone_e164) patch.phone_e164 = phone;
      if (waJid && !existing.wa_jid) patch.wa_jid = waJid;
      if (waLid && !existing.wa_lid) patch.wa_lid = waLid;
      if (notes) patch.notes = existing.notes ? (existing.notes.includes(notes) ? existing.notes : `${existing.notes}\n${notes}`) : notes;
      if (session && !existing.session_id) {
        Object.assign(patch, {
          session_id: sessionId, anon_id: existing.anon_id ?? anonId, ref: existing.ref ?? ref,
          first_touch: existing.first_touch ?? session.first_touch, last_touch: existing.last_touch ?? session.last_touch,
          consent_ads: existing.consent_ads || session.consent_ads || 0, consent_analytics: existing.consent_analytics || session.consent_analytics || 0,
        });
      } else if (ref && !existing.ref) {
        patch.ref = ref;
      }
      if (channel === 'whatsapp' && !existing.first_inbound_ts) patch.first_inbound_ts = now;
      db.updateLead(existing.lead_id, patch);
      db.addTouchpoint({
        lead_id: existing.lead_id, ts: now, channel, event_type: MERGE_EVENT[channel],
        source: src.source, medium: src.medium, campaign: src.campaign, campaign_id: src.campaign_id,
        listing_id: fields.listing_id ?? existing.listing_id ?? null, meta: touchMeta,
      });
      if (meta.eventId) db.setEventLead(meta.eventId, existing.lead_id);
      return { lead: db.getLead(existing.lead_id), created: false };
    }

    const id = leadId(now);
    db.insertLead({
      lead_id: id, created: now, updated: now, phone_e164: phone, wa_jid: waJid, wa_lid: waLid,
      ...fields, language: fields.language ?? session?.locale ?? null,
      channel, source: src.source, medium: src.medium, campaign: src.campaign, campaign_id: src.campaign_id, content: src.content,
      click_ids: src.click_ids, ref, match_method: matchMethod, session_id: sessionId, anon_id: anonId,
      first_touch: session?.first_touch ?? null, last_touch: session?.last_touch ?? null, notes,
      stage: 'new', stage_ts: now, value_sar: null,
      first_inbound_ts: channel === 'whatsapp' ? now : null, first_reply_ts: null, legacy_id: null,
      consent_ads: session?.consent_ads ?? 0, consent_analytics: session?.consent_analytics ?? 0,
    });
    db.setStage(id, 'new', { actor: 'system', now });
    db.addTouchpoint({
      lead_id: id, ts: now, channel, event_type: 'lead_created',
      source: src.source, medium: src.medium, campaign: src.campaign, campaign_id: src.campaign_id,
      listing_id: fields.listing_id, meta: touchMeta,
    });

    // The server-side event every destination hears about. It carries the session's
    // client context so the Conversions APIs can match the person to the click.
    const event = {
      event_id: newId('ev'), ts: now, name: 'lead_created', anon_id: anonId, session_id: sessionId, lead_id: id,
      listing_id: fields.listing_id, path: null, props: { channel, match_method: matchMethod, source: src.source, medium: src.medium },
      src_first: session?.first_touch ?? null, src_last: session?.last_touch ?? null,
      ip: session?.ip ?? null, ua: session?.ua ?? null, country: session?.country ?? null,
    };
    db.insertEvent(event);
    db.enqueueFanout(event.event_id, LEAD_FANOUT, { now });
    if (meta.eventId) db.setEventLead(meta.eventId, id);

    const dataDir = meta.dataDir ?? db.dataDir;
    if (dataDir) {
      appendLead(dataDir, input, {
        id, ts: now, channel: RAW_LOG_CHANNEL[channel] ?? channel,
        source: channel.startsWith('concierge') ? 'concierge' : src.source,
        extra: { ...(meta.raw ?? {}), session_id: sessionId, ref, match_method: matchMethod },
      });
    }
    return { lead: db.getLead(id), created: true };
  });
}

/**
 * Human-readable WhatsApp note for the owner. Takes a store row (`phone_e164`,
 * `listing_id`, `created`) or a raw-log record (`phone`, `listingId`, `ts`).
 */
export function leadNote(lead, { siteUrl = 'https://bona.azoz.uk' } = {}) {
  const phone = lead.phone ?? (lead.phone_e164 ? `+${lead.phone_e164}` : null);
  const listing = lead.listingId ?? lead.listing_id ?? null;
  const ts = lead.ts ?? (lead.created ? new Date(lead.created).toISOString() : new Date().toISOString());
  const lines = ['*Bona — new enquiry*'];
  if (lead.name) lines.push(`Name: ${lead.name}`);
  if (phone) lines.push(`Phone: ${phone}`);
  if (lead.interest) lines.push(`Interest: ${lead.interest}`);
  if (lead.district) lines.push(`Area: ${lead.district}`);
  if (lead.budget) lines.push(`Budget: ${lead.budget}`);
  if (lead.timeline) lines.push(`Timeline: ${lead.timeline}`);
  if (listing) lines.push(`Property: ${listing}`);
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  if (lead.source) {
    const parts = [`${lead.source}${lead.medium ? ` / ${lead.medium}` : ''}`, lead.campaign, lead.ref ? `Ref ${lead.ref}` : null, listing].filter(Boolean);
    lines.push(`Source: ${parts.join(' · ')}`);
  }
  if (lead.match_method === 'time_window') lines.push('Match: inferred (time window)');
  lines.push(`Channel: ${lead.channel ?? 'chat'} · ${ts}`);
  lines.push(siteUrl);
  return lines.join('\n');
}
