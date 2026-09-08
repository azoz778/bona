/**
 * The WhatsApp Ref-code poller.
 *
 * Most Bona enquiries arrive as a WhatsApp message, and a WhatsApp message on its own
 * says nothing about where the person came from. The site fixes that at the source: every
 * `wa.me` link is rewritten to prefill `… Ref BONA-W003 · K7Q2XR`, and the code is the
 * visitor's session. This loop reads the owner's inbound messages, finds that code, and
 * turns the message into a lead that knows its campaign.
 *
 * Read-only, by owner decision. The instance is the owner's *personal* WhatsApp, shared
 * with another agent: we poll `POST /chat/findMessages` and we never set a webhook. The
 * only thing this module writes back to WhatsApp is the owner's own new-lead note, and
 * only for a lead it just created.
 *
 * **Matched-only storage** (owner decision). A message is kept only when one of these is
 * true, in this order:
 *
 *   1. `ref`         — it carries a site Ref code (`Ref BONA-W003 · K7Q2XR`)
 *   2. `phone`       — the sender is already a lead (merge + `inbound_message` touchpoint)
 *   3. `ad_meta`     — it arrived with click-to-WhatsApp ad context
 *   4. `keyword`     — it says Bona / بونا / a listing id
 *   5. `time_window` — the sender is unknown, but a `whatsapp_click` from a lead-less
 *                      session landed within ±15 minutes (marked *inferred* in the note)
 *
 * Anything else — the owner's private conversations, which this loop can also see — is
 * discarded in memory. It is counted (`status().unmatched`) and never written to disk,
 * never logged, never sent anywhere. For the same reason nothing here logs a phone
 * number, a name or message text.
 */
import { parseRef } from './attribution.mjs';
import { MAX_PAGES, PAGE_SIZE, bareJid, fetchWindow, oldestFirst } from './evolution.mjs';
import { createOrMergeLead, leadNote } from './leads.mjs';
import { normalisePhone } from './phone.mjs';
import { waConfig } from './wa.mjs';

/** With no cursor yet, look back this far rather than at the whole history. */
export const FIRST_RUN_LOOKBACK_MS = 10 * 60_000;
/**
 * The furthest back any window ever reaches. Without it the cursor can sit still — one
 * stale message inside the overlap keeps coming back as "the newest thing we saw" — and a
 * quiet week would end with every tick asking Evolution for a week of messages.
 */
export const MAX_WINDOW_MS = 10 * 60_000;
/** Every window reaches this far back behind the cursor: WhatsApp delivery is not instant. */
export const OVERLAP_MS = 120_000;
/** How long a processed message id is remembered, so the overlap cannot double-count it. */
export const SEEN_TTL_MS = 7 * 86_400_000;
/** How close a `whatsapp_click` has to be for an unknown number to be inferred from it. */
export const CLICK_WINDOW_MS = 15 * 60_000;
/** How much of the first message is kept on a new lead. */
export const SNIPPET_MAX = 200;
/** The one keyword rule: our name, in either script, or a listing id. */
export const KEYWORD_RE = /\bbona\b|بونا|BONA-W?\d{3}/i;
const LISTING_RE = /\bBONA-W?\d{3}\b/i;
/**
 * Our own new-lead note, read back out of the owner's chat. It says "Bona" in the first
 * line, so without this it would keyword-match and become an enquiry from ourselves.
 * `fromMe` normally keeps it out; this is the belt to that pair of braces.
 */
const OWN_NOTE_RE = /^\*?Bona — new enquiry\*?/;
/** How often one record may fail before it is written off rather than retried for ever. */
export const MAX_RECORD_ATTEMPTS = 3;

const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
const str = (v, max = 300) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/* ------------------------------------------------------------------ */
/* jids                                                                */
/* ------------------------------------------------------------------ */

const isGroup = (jid) => typeof jid === 'string' && jid.endsWith('@g.us');
const isBroadcast = (jid) => typeof jid === 'string' && (jid === 'status@broadcast' || jid.endsWith('@broadcast'));
const isLid = (jid) => typeof jid === 'string' && jid.endsWith('@lid');

/**
 * A chat this loop has no business reading: a group (Bona's listings are published from
 * one and the intake daemon owns it), a status broadcast, or the owner's own chat with
 * himself — which is where this service's notes are sent, so reading it back would make
 * the poller answer its own messages.
 */
export function isIgnorableChat(jid, ownerDigits = '') {
  if (!jid) return true;
  if (isGroup(jid) || isBroadcast(jid)) return true;
  if (ownerDigits && !isLid(jid) && bareJid(jid) === ownerDigits) return true;
  return false;
}

/**
 * Split a record's jids into what a lead stores. An ad-origin or privacy-mode chat
 * arrives as `…@lid`, whose digits are an opaque WhatsApp id and NOT a phone number —
 * so the phone only ever comes from the real jid (`key.remoteJidAlt` in that case), and
 * both are kept so the next message from either matches the same lead.
 * @returns {{ phone: string|null, waJid: string|null, waLid: string|null }}
 */
export function jidsOf({ jid = null, jidAlt = null } = {}) {
  let waJid = null;
  let waLid = null;
  for (const j of [jid, jidAlt]) {
    if (typeof j !== 'string' || !j) continue;
    if (isLid(j)) waLid ??= j;
    else if (!isGroup(j) && !isBroadcast(j)) waJid ??= j;
  }
  return { phone: waJid ? normalisePhone(bareJid(waJid)) : null, waJid, waLid };
}

/* ------------------------------------------------------------------ */
/* ad context                                                          */
/* ------------------------------------------------------------------ */

/**
 * The click-to-WhatsApp metadata Meta attaches to the first message of an ad-originated
 * chat. Kept verbatim (minus the ad's own copy) on the touchpoint, because it is the only
 * proof of where that person came from — there is no session and no Ref code.
 * @returns {object|null} null when this is an ordinary message
 */
export function adMetaOf(contextInfo) {
  const ctx = contextInfo && typeof contextInfo === 'object' ? contextInfo : null;
  if (!ctx) return null;
  const ad = ctx.externalAdReply && typeof ctx.externalAdReply === 'object' ? ctx.externalAdReply : null;
  const hasAd = Boolean(ad) || ctx.conversionSource || ctx.entryPointConversionSource || ctx.entryPointConversionApp || ctx.utm;
  if (!hasAd) return null;
  const meta = compact({
    source_id: str(ad?.sourceId, 64),
    source_type: str(ad?.sourceType, 64),
    source_app: str(ad?.sourceApp, 64),
    source_url: str(ad?.sourceUrl, 500),
    ctwa_clid: str(ad?.ctwaClid, 300),
    ad_ref: str(ad?.ref, 300),
    conversion_source: str(ctx.conversionSource, 64),
    entry_point_conversion_source: str(ctx.entryPointConversionSource, 64),
    entry_point_conversion_app: str(ctx.entryPointConversionApp, 64),
    utm: typeof ctx.utm === 'object' && ctx.utm !== null ? ctx.utm : str(ctx.utm, 300),
  });
  return Object.keys(meta).length ? meta : { external_ad: true };
}

/**
 * Where an ad-originated message came from, in the site's own attribution vocabulary.
 * A click-to-WhatsApp click id is proof the click was paid for even when the record does
 * not spell `Ads` out.
 * @returns {{ source: string, medium: string, campaign_id: string|null, click_ids: object|null, referrer: string|null }}
 */
export function adSourceOf(meta = {}) {
  const app = String(meta.source_app ?? meta.entry_point_conversion_app ?? '').toLowerCase();
  const conv = `${meta.conversion_source ?? ''} ${meta.entry_point_conversion_source ?? ''} ${meta.source_type ?? ''}`.toLowerCase();
  let source = 'whatsapp_ad';
  if (app.includes('instagram') || app === 'ig') source = 'instagram';
  else if (app.includes('facebook') || app === 'fb' || app.includes('messenger')) source = 'facebook';
  else if (conv.includes('instagram') || conv.includes('ig_')) source = 'instagram';
  else if (conv.includes('facebook') || conv.includes('fb')) source = 'facebook';
  return {
    source,
    medium: /ad/.test(conv) || meta.ctwa_clid ? 'paid' : 'social_or_organic',
    campaign_id: meta.source_id ?? null,
    click_ids: meta.ctwa_clid ? { ctwa_clid: meta.ctwa_clid } : null,
    referrer: meta.source_url ?? null,
  };
}

/** `BONA-W003` mentioned anywhere in the text, uppercased. */
export function listingIdIn(text) {
  const m = LISTING_RE.exec(String(text ?? ''));
  return m ? m[0].toUpperCase() : null;
}

/* ------------------------------------------------------------------ */
/* The poller                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {ReturnType<import('./db.mjs').openDb>} o.db
 * @param {object} o.cfg                                    loadConfig(): `env`, `siteUrl`, `dataDir`, `waPollMs`
 * @param {(w: { gte: number, lte: number }) => Promise<{ records: object[] }|object[]>} [o.findMessages]
 *        injected in tests; defaults to `fetchWindow()` against the instance in `cfg.env`
 * @param {(text: string) => Promise<any>} [o.sendWhatsApp] the owner note sender
 * @param {(obj: object) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createPoller({ db, cfg = {}, findMessages = null, sendWhatsApp = null, log = () => {}, now = () => Date.now() } = {}) {
  const wa = waConfig(cfg.env ?? {});
  const instance = wa.instance;
  const ownerDigits = bareJid(wa.ownerJid);
  const configured = Boolean(findMessages) || Boolean(wa.baseUrl && wa.apiKey);
  const find = findMessages ?? (({ gte, lte }) => fetchWindow({
    baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance, gte, lte, offset: PAGE_SIZE, maxPages: MAX_PAGES,
  }));

  let timer = null;
  let busy = false;
  let matched = 0;
  /** Message ids this process has failed on, so a poison record cannot retry for ever. */
  const failures = new Map();

  /* -------------------- lookups -------------------- */

  const findLead = ({ phone, waJid, waLid }) => (phone ? db.getLeadByPhone(phone) : null)
    ?? (waJid ? db.getLeadByJid(waJid) : null)
    ?? (waLid ? db.getLeadByJid(waLid) : null)
    ?? null;

  /** The last listing this session actually looked at — the property the Ref belongs to. */
  function lastListingView(sessionId) {
    if (!sessionId) return null;
    const views = db.eventsForSession(sessionId, { limit: 200 }).filter((e) => e.name === 'listing_view' && e.listing_id);
    return views.length ? views[views.length - 1].listing_id : null;
  }

  /** Has this session already produced a lead? Any event of it carrying a lead id says yes. */
  const sessionHasLead = (sessionId) => Boolean(sessionId) && db.eventsForSession(sessionId, { limit: 200 }).some((e) => e.lead_id);

  /**
   * The `whatsapp_click` nearest in time to an unknown number's message, from a session
   * that has not become a lead yet. This is the weakest rule in the set — two visitors
   * clicking within the same quarter hour would be told apart by nothing — so the lead it
   * creates is marked `time_window` and the owner's note says *inferred*.
   */
  function closestClick(ts) {
    let best = null;
    for (const click of db.recentEvents({ name: 'whatsapp_click', sinceTs: ts - CLICK_WINDOW_MS, untilTs: ts + CLICK_WINDOW_MS, limit: 100 })) {
      if (!click.session_id || click.lead_id) continue;
      if (sessionHasLead(click.session_id)) continue;
      const distance = Math.abs((click.ts ?? ts) - ts);
      if (!best || distance < best.distance) best = { distance, click };
    }
    return best?.click ?? null;
  }

  /* -------------------- matching -------------------- */

  /**
   * Which rule, if any, keeps this message. Precedence is the spec's: the Ref code is the
   * only rule that knows the campaign for certain, so it wins even over a known sender.
   * @returns {object|null} null = discard
   */
  function classify({ text, contextInfo, existing, ts }) {
    const ref = parseRef(text);
    if (ref) {
      const session = db.getSessionByRef(ref.code);
      return {
        method: 'ref', ref: ref.code, sessionId: session?.session_id ?? null,
        listingId: ref.listingId ?? lastListingView(session?.session_id),
      };
    }
    if (existing) return { method: 'phone', listingId: listingIdIn(text) };

    const adMeta = adMetaOf(contextInfo);
    if (adMeta) return { method: 'ad_meta', adMeta, source: adSourceOf(adMeta), listingId: listingIdIn(text) };

    if (KEYWORD_RE.test(text)) return { method: 'keyword', listingId: listingIdIn(text) };

    const click = closestClick(ts);
    if (click) {
      return { method: 'time_window', sessionId: click.session_id, eventId: click.event_id, listingId: click.listing_id ?? null };
    }
    return null;
  }

  /* -------------------- one message -------------------- */

  /**
   * A message from the owner to somebody who is already a lead is the reply that stops the
   * response clock. Nothing is created here — an outbound message to a stranger is not a lead.
   */
  function recordReply(rec, ts) {
    const lead = findLead(jidsOf(rec));
    if (!lead || lead.first_reply_ts) return false;
    db.updateLead(lead.lead_id, { first_reply_ts: ts, updated: ts });
    return true;
  }

  async function handleInbound(rec, ts) {
    const jids = jidsOf(rec);
    const existing = findLead(jids);
    const text = typeof rec.text === 'string' ? rec.text : '';
    const match = classify({ text, contextInfo: rec.contextInfo, existing, ts });
    if (!match) return null;

    const { lead, created } = createOrMergeLead(db, {
      name: rec.pushName ?? null,
      phone: jids.phone,
      waJid: jids.waJid,
      waLid: jids.waLid,
      listingId: match.listingId ?? null,
      // The message body is kept only for a lead we are meeting for the first time, capped,
      // and only on the touchpoint — never as a transcript of the conversation.
      snippet: existing ? null : text.slice(0, SNIPPET_MAX) || null,
    }, {
      channel: 'whatsapp',
      matchMethod: match.method,
      sessionId: match.sessionId ?? null,
      ref: match.ref ?? null,
      adMeta: match.adMeta ?? null,
      // The enquiry happened when the message was sent, not when we noticed it: this is
      // what `first_inbound_ts` (and so every response time) is measured from.
      now: ts,
      dataDir: cfg.dataDir ?? undefined,
    });

    // An ad-originated lead has no session, so `createOrMergeLead` could only fall back to
    // "whatsapp, organic". The ad context is better than that, and it is all we will ever get.
    if (created && match.source && !lead.session_id) {
      const s = match.source;
      const touch = {
        ts, landing: null, referrer: s.referrer, utm_source: s.source, utm_medium: s.medium,
        utm_campaign: null, utm_content: null, utm_term: null, utm_id: s.campaign_id, click_ids: s.click_ids,
      };
      db.updateLead(lead.lead_id, {
        source: s.source, medium: s.medium, campaign_id: s.campaign_id, click_ids: s.click_ids,
        first_touch: touch, last_touch: touch, updated: ts,
      });
    }

    // The click that explains this message is marked as claimed, so the next unknown number
    // cannot be inferred from it too. It is deliberately NOT passed to `createOrMergeLead`
    // as `eventId`: that would fan the lead out under the click's own event id, and Meta —
    // which already heard `Contact` under it — would drop the `Lead` as a duplicate.
    if (match.eventId) db.setEventLead(match.eventId, lead.lead_id);

    const fresh = db.getLead(lead.lead_id) ?? lead;
    log({ evt: 'wa.lead', leadId: fresh.lead_id, created, match: match.method, source: fresh.source, listingId: fresh.listing_id ?? null });

    if (created && sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote(fresh, { siteUrl: cfg.siteUrl }));
        if (res && res.ok === false) log({ level: 'warn', evt: 'wa.note.failed', leadId: fresh.lead_id, error: res.error ?? 'unknown' });
      } catch (err) {
        log({ level: 'warn', evt: 'wa.note.failed', leadId: fresh.lead_id, error: String(err?.message ?? err) });
      }
    }
    return { method: match.method, created };
  }

  /* -------------------- the tick -------------------- */

  /**
   * One pass: read the window since the cursor, keep what matches, move the cursor.
   *
   * Nothing in here may throw. An Evolution outage leaves the cursor exactly where it was,
   * so the window simply widens and the messages are picked up when it comes back; what
   * the outage does change is `status().lagS`, which is the number `/health` publishes.
   */
  async function tick() {
    if (busy) return { busy: true };
    busy = true;
    try {
      if (!configured) {
        log({ evt: 'wa.poll.skipped', reason: 'evolution_not_configured' });
        return { skipped: 'not_configured' };
      }
      const t = now();
      const cursor = db.waCursorGet(instance);
      const since = Number.isFinite(cursor?.last_ts) && cursor.last_ts > 0 ? cursor.last_ts : t - FIRST_RUN_LOOKBACK_MS;
      const gte = Math.max(0, since - OVERLAP_MS);
      const lte = t;

      const answer = await find({ gte, lte, instance });
      const records = Array.isArray(answer) ? answer : (answer?.records ?? []);

      const tally = { scanned: records.length, matched: 0, unmatched: 0, created: 0, merged: 0, replies: 0, ignored: 0 };
      let maxTs = 0;
      // Evolution answers newest-first. Handled in that order, a follow-up would be judged
      // before the Ref line that creates the lead, and a reply before the enquiry it answers.
      for (const rec of oldestFirst(records)) {
        const ts = Number.isFinite(rec?.ts) ? rec.ts : t;
        if (ts > maxTs && ts <= lte) maxTs = ts;

        // The owner's own chat can also arrive as a `@lid` whose alt is his number.
        const isOwnChat = Boolean(ownerDigits) && [rec?.jid, rec?.jidAlt].some((j) => j && !isLid(j) && bareJid(j) === ownerDigits);
        const isOwnNote = !rec?.fromMe && OWN_NOTE_RE.test(String(rec?.text ?? '').trimStart());
        if (!rec?.id || isOwnChat || isOwnNote || isIgnorableChat(rec.jid, ownerDigits)) {
          tally.ignored += 1;
          continue;
        }
        if (db.waSeenHas(rec.id)) { tally.ignored += 1; continue; }

        try {
          if (rec.fromMe) {
            if (recordReply(rec, ts)) tally.replies += 1;
          } else {
            const out = await handleInbound(rec, ts);
            if (!out) tally.unmatched += 1;
            else {
              tally.matched += 1;
              if (out.created) tally.created += 1; else tally.merged += 1;
            }
          }
          // Remembered once it is safely handled, so a transient store failure costs a
          // retry rather than the lead. (One process owns this loop; two would need the
          // claim to be the INSERT itself.)
          db.waSeenAdd(rec.id, ts);
          failures.delete(rec.id);
        } catch (err) {
          // No content, no jid: a record that fails is a bug to fix, not a person to log.
          const attempts = (failures.get(rec.id) ?? 0) + 1;
          failures.set(rec.id, attempts);
          if (attempts >= MAX_RECORD_ATTEMPTS) { db.waSeenAdd(rec.id, ts); failures.delete(rec.id); }
          log({ level: 'warn', evt: 'wa.poll.record_failed', attempts, writtenOff: attempts >= MAX_RECORD_ATTEMPTS, error: String(err?.message ?? err) });
        }
      }

      // Newest-first paging means a window that overflowed the page cap hides its OLDEST
      // messages, and asking again returns the same newest ones — so this is a loss, and
      // it says so. It takes downtime long enough for 500 messages to pile up.
      if (answer?.truncated) log({ level: 'warn', evt: 'wa.poll.truncated', scanned: records.length, gte, lte });

      db.waCursorSet(instance, {
        // Forward only, no further back than the newest message we saw, and never reaching
        // back more than one window: those three together are what keeps this cheap.
        lastTs: Math.max(since, maxTs || lte, lte - MAX_WINDOW_MS),
        lastRun: t,
        unmatched: (cursor?.unmatched ?? 0) + tally.unmatched,
      });
      db.pruneWaSeen(t - SEEN_TTL_MS);
      matched += tally.matched;
      if (tally.matched || tally.replies) log({ evt: 'wa.poll.tick', ...tally });
      return tally;
    } catch (err) {
      log({ level: 'warn', evt: 'wa.poll.failed', error: String(err?.message ?? err) });
      return { error: String(err?.message ?? err) };
    } finally {
      busy = false;
    }
  }

  /**
   * What `/health` publishes. `lagS` is the age of the last COMPLETED tick, not of the
   * newest message: a quiet Saturday must not read like an outage, and an outage — which
   * leaves the cursor untouched — must.
   */
  function status() {
    const cursor = db.waCursorGet(instance);
    const lastRun = cursor?.last_run ?? null;
    return {
      instance,
      configured,
      lastRun,
      lastTs: cursor?.last_ts ?? null,
      lagS: lastRun ? Math.max(0, Math.round((now() - lastRun) / 1000)) : null,
      unmatched: cursor?.unmatched ?? 0,
      matched,
      running: Boolean(timer),
    };
  }

  function start({ intervalMs = cfg.waPollMs ?? 45_000 } = {}) {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => { tick().catch((err) => log({ level: 'warn', evt: 'wa.poll.failed', error: String(err?.message ?? err) })); }, intervalMs);
    // Polling must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, start, stop, status, get started() { return Boolean(timer); } };
}
