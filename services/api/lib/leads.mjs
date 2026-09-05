/**
 * Leads: appended as JSON lines to `${BONA_DATA}/leads.jsonl`. Append-only on
 * purpose — this file is the owner's record of every enquiry Dana handled, and it
 * is the one thing that must survive a crash mid-conversation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomId } from './store.mjs';

export const LEAD_FIELDS = ['name', 'phone', 'interest', 'budget', 'timeline', 'notes', 'language', 'district', 'listingId'];

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

export function appendLead(dataDir, lead, meta = {}) {
  const record = {
    id: `LEAD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomId(4)}`,
    ts: new Date().toISOString(),
    source: meta.source ?? 'concierge',
    channel: meta.channel ?? 'chat',
    ...normaliseLead(lead),
    ...(meta.extra ?? {}),
  };
  const file = path.join(dataDir, 'leads.jsonl');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

/** Append one line to another jsonl in the data dir (calls.jsonl, chats.jsonl…). */
export function appendJsonl(dataDir, name, record) {
  const file = path.join(dataDir, name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

/** Human-readable WhatsApp note for the owner. */
export function leadNote(lead, { siteUrl = 'https://bona.azoz.uk' } = {}) {
  const lines = ['*Bona — new enquiry*'];
  if (lead.name) lines.push(`Name: ${lead.name}`);
  if (lead.phone) lines.push(`Phone: ${lead.phone}`);
  if (lead.interest) lines.push(`Interest: ${lead.interest}`);
  if (lead.district) lines.push(`Area: ${lead.district}`);
  if (lead.budget) lines.push(`Budget: ${lead.budget}`);
  if (lead.timeline) lines.push(`Timeline: ${lead.timeline}`);
  if (lead.listingId) lines.push(`Property: ${lead.listingId}`);
  if (lead.notes) lines.push(`Notes: ${lead.notes}`);
  lines.push(`Channel: ${lead.channel ?? 'chat'} · ${lead.ts ?? new Date().toISOString()}`);
  lines.push(siteUrl);
  return lines.join('\n');
}
