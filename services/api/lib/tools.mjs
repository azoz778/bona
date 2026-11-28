/**
 * Retell custom-tool handlers (`POST /v1/tools/<name>?token=…`).
 *
 * Request body Retell sends (docs.retellai.com/build/add-function-calling):
 *   { "call": { call_id, agent_id, metadata, retell_llm_dynamic_variables, … },
 *     "name": "search_properties", "args": { … } }
 * Chat agents send the same envelope with a `chat` object instead of `call`.
 *
 * Response: a JSON value that Retell hands to the model as the tool result. We
 * return a JSON *string* (the shape the docs' own example returns) whose content is
 * itself compact JSON, so the model gets structured data it can quote verbatim.
 * Retell truncates tool results at ~4000 characters — keep rows small.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createOrMergeLead, leadNote } from './leads.mjs';
import { normaliseSearchArgs } from './actions.mjs';
import { toAsciiDigits, exactListing, pinOf } from './inventory.mjs';
import { ensureHandoff, plausibleName, saveNeeds as saveLeadNeeds } from './lead-tasks.mjs';
import { createPublishedUnits } from './published-units.mjs';

export const TOOL_NAMES = [
  'search_properties', 'show_property', 'search_units', 'create_lead', 'request_human',
  // PR-B4 (DESIGN §4.3): the assistant's tools. They only read, validate or save needs: nothing is sent or booked
  // inside a tool (lib/dana-commit.mjs does that after preSend).
  'listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs',
];
/** The WhatsApp agent's hand-over tool (Phase 4): its invocation in a completion is what lib/dana-wa.mjs looks for. */
export const HANDOVER_TOOL = 'request_human';
/** request_human's `kind` (DESIGN §4.3); dana-wa reads it from the raw call, and anything else is `other` (§4.2). */
export const HANDOVER_KINDS = Object.freeze(['person', 'offer', 'complaint', 'contract', 'selling', 'viewing', 'other', 'stop', 'privacy', 'deletion']);
const LEAD_ID_RE = /^LEAD-[A-Za-z0-9-]{1,60}$/;

/** The brain's WhatsApp source (lib/brain.mjs SOURCES.wa): the only one the five tools below serve. */
export const WA_SOURCE = 'bona-whatsapp';
/**
 * The tools keyed on the chat's lead (ctx.attr.lead_id) and refused outside a WhatsApp chat in auto mode
 * (DESIGN §2's same-release rule, §4.3). They run only in-process (`run(name, body, { inProcess: true })`,
 * `runInProcess`: the brain), never on the HTTP /v1/tools route, where a token holder could forge the
 * metadata. listing_details is not one of them: it only reads published text.
 */
export const WA_ONLY_TOOLS = Object.freeze(['viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs']);
/**
 * Brochures held back until their PDFs are rebuilt with the published prices (PLAN T16): never sent, not even
 * as a link. PR-L2 (T16b) empties this line.
 */
export const BLOCKED_BROCHURES = Object.freeze(['BONA-W011', 'BONA-W018', 'BONA-W024']);
/** send_brochure (critic round 2 #18): the PDF goes as a document only up to this size, read by a HEAD request. */
export const BROCHURE_MAX_BYTES = 8 * 1024 * 1024;
export const BROCHURE_HEAD_MS = 5_000;
/** A measured size is kept 12 h per URL; a failed HEAD (timeout, 404, no length) only 10 min. */
export const BROCHURE_CACHE_MS = 12 * 3_600_000;
export const BROCHURE_FAIL_CACHE_MS = 10 * 60_000;
/** One PDF per chat per day (DESIGN §6.3, the brochure row): a second brochure within it goes as a link. */
export const PDF_PER_CHAT_MS = 24 * 3_600_000;
/** The only hosts a brochure may come from (https, no user, no port, no redirect), besides the configured site's. */
export const BROCHURE_HOSTS = Object.freeze(['bona-real-estate.com', 'www.bona-real-estate.com']);

/** The brochure URL when it is an https URL on Bona's site (BROCHURE_HOSTS or `siteUrl`'s https host), else null. */
export function brochureUrlOn(url, siteUrl = null) {
  if (typeof url !== 'string' || !url.trim()) return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const hosts = new Set(BROCHURE_HOSTS);
  try {
    const site = new URL(String(siteUrl ?? ''));
    if (site.protocol === 'https:' && !site.port) hosts.add(site.hostname.toLowerCase());
  } catch { /* no site configured */ }
  return hosts.has(u.hostname.toLowerCase()) ? u.href : null;
}
/** The answers of the five tools when they do nothing (DESIGN §4.3: each with "not available here"). */
export const NOT_HERE_NOTE = 'Not available here.';
export const NOT_ON_EMAIL_NOTE = 'Not on email.';
export const SLOTS_OFF_NOTE = 'Not available here: call request_human with kind viewing.';
export const BOOKING_NOTE = 'Write one short sentence that you are booking it; never state it as confirmed — the system sends the confirmation.';
const NO_BROCHURE_NOTE = 'There is no brochure to send for this home: offer its page.';
/** search_properties with no match, on WhatsApp: the client is already on Bona's WhatsApp, so no number (DESIGN §4.3). */
export const WA_NO_MATCH_NOTE = 'No match in Bona inventory. Do not invent a property or a price: say nothing matches right now, ask one question that widens the search, and offer a person from the Bona team (request_human).';
/** The save_needs arguments, each mapped by lead-tasks saveNeeds onto the lead row (DESIGN §4.3, #5). */
const NEED_KEYS = ['name', 'interest', 'budget', 'district', 'property_type', 'timeline', 'listing_id'];
/**
 * search_units sources that still get today's per-unit rows (refs, floors, every payment plan's price).
 * Empty: every source, a missing or unknown one included, gets only the published per-bedroom "from" cut
 * (DESIGN §4.5, deny by default). The owner's veto on the website-chat cut is this one line: ['bona-web'].
 */
export const FULL_UNIT_ROW_SOURCES = Object.freeze([]);

/** search_units notes: the published cut, and nothing published for that project. */
export const UNITS_NOTE = "These are the published starting cash prices per bedroom count; quote them as 'from'. Unit-level prices and payment plans are not published: offer a person for those.";
export const UNITS_NOT_PUBLISHED_NOTE = 'Unit prices for that project are not published. Answer from search_properties only, never invent a unit, a price or a payment plan, and offer a person.';

/**
 * The allow-list a client may hear (DESIGN §4.5): the live listing page's per-bedroom rows (label, count, area
 * range, lowest cash price), the delivery and the sheet date, from the summary lib/published-units.mjs read off
 * that page. Built key by key, so nothing new in the summary passes.
 */
export function publishedUnitsCut(live) {
  if (!live) return null;
  return {
    rows: live.rows.map((r) => ({
      label: { en: r.label.en, ar: r.label.ar }, count: r.count, areaMin: r.areaMin, areaMax: r.areaMax, cashFrom: r.cashFrom,
    })),
    delivery: live.delivery, updated: live.updated,
  };
}

/** A duplicate `create_lead` inside this window returns the first lead's id. */
export const LEAD_DEDUPE_MS = 10 * 60 * 1000;

/**
 * Constant-time token comparison. Both sides are hashed first, so the comparison
 * is over two fixed 32-byte digests: a wrong *length* costs exactly as much as a
 * wrong byte, and nothing about the real token's shape leaks. An empty configured
 * token means "deny".
 */
export function tokenMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = createHash('sha256').update(String(provided), 'utf8').digest();
  const b = createHash('sha256').update(String(expected), 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Token from `X-Bona-Token:` or `Authorization: Bearer …`.
 *
 * `?token=` is accepted only when `BONA_ALLOW_QUERY_TOKEN=1`: a token in a URL ends
 * up in proxy logs and in Retell's own tool-call records. Provisioning puts it in a
 * header, so the query form is off by default.
 */
export function extractToken({ url, headers = {}, allowQuery = false }) {
  const header = headers['x-bona-token'];
  if (typeof header === 'string' && header) return header;
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  if (allowQuery) {
    const fromQuery = url?.searchParams?.get('token');
    if (fromQuery) return fromQuery;
  }
  return null;
}

/**
 * Dedupe key for `create_lead`: one conversation plus one contact. Phone numbers are
 * compared on their last 9 digits so "+966500000000", "0500000000" and "٠٥٠٠٠٠٠٠٠٠"
 * are one person; with no phone, the name carries the key.
 */
export function leadKey({ conversationId, phone, name } = {}) {
  const digits = toAsciiDigits(phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const who = digits
    ? `p:${digits.slice(-9)}`
    : `n:${String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  return `${conversationId ?? 'anon'}|${who}`;
}

/** The conversation this tool call belongs to (call_id for voice, chat_id for chat). */
export function conversationId(body = {}) {
  const dyn = body.call?.retell_llm_dynamic_variables ?? body.chat?.retell_llm_dynamic_variables ?? body.retell_llm_dynamic_variables ?? {};
  return (
    body.call?.call_id ??
    body.chat?.chat_id ??
    body.call_id ??
    body.chat_id ??
    dyn.session_id ??
    null
  );
}

export function conversationLocale(body = {}) {
  const dyn = body.call?.retell_llm_dynamic_variables ?? body.chat?.retell_llm_dynamic_variables ?? body.retell_llm_dynamic_variables ?? {};
  const meta = body.call?.metadata ?? body.chat?.metadata ?? {};
  // dyn.language: what the WhatsApp agent and the brain set (DESIGN §4.3); the concierge sets dyn.locale.
  const locale = dyn.locale ?? dyn.language ?? meta.locale ?? 'en';
  return locale === 'ar' ? 'ar' : 'en';
}

/** Retell nests arguments under `args` unless the tool sets `args_at_root`. */
export function toolArgs(body = {}) {
  if (body.args && typeof body.args === 'object') return body.args;
  const { call, chat, name, ...rest } = body;
  return rest && typeof rest === 'object' ? rest : {};
}

const oneLineNeed = (v, max) => String(v).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const foldNeed = (v) => String(v ?? '').toLowerCase();
/** Whether the lead row holds this save_needs value as lead-tasks saveNeeds writes it (its own allow-list). */
function storedNeed(lead, key, value) {
  switch (key) {
    case 'name': return plausibleName(value) && lead.name === oneLineNeed(value, 200);
    case 'budget': case 'district': case 'timeline': return lead[key] === oneLineNeed(value, 200);
    case 'listing_id': return lead.listing_id === oneLineNeed(value, 20).toUpperCase();
    case 'interest': return foldNeed(lead.interest).includes(foldNeed(oneLineNeed(value, 500)));
    case 'property_type': return foldNeed(lead.interest).includes(foldNeed(oneLineNeed(value, 100)));
    default: return false;
  }
}

/**
 * Build the handlers.
 * @param {{ inventory, store, db, dataDir: string, siteUrl: string, env: object,
 *           sendWhatsApp?: (text: string) => Promise<any>, log?: Function,
 *           now?: () => number, leadDedupeMs?: number }} deps
 *   `db` is the SQLite store (`openDb`); `dataDir` is where the raw `leads.jsonl` lives.
 *   PR-B4 seams, each optional and inert when absent (index.mjs at PR-F2b passes only ownerTest; PR-INT, T14,
 *   wires the rest):
 *   - `ownerTest` (autoMode): without it, or when it throws, no lead is in auto mode, so the five WhatsApp tools
 *     do nothing;
 *   - `viewing` (lib/viewing.mjs): slots() for viewing_slots, validate() for book_viewing; without it nothing
 *     is bookable;
 *   - `notes` (lib/owner-notes.mjs): create_lead's new-enquiry note as notes.leadEvent(lead, { why: 'concierge',
 *     created }), so the ledger skips a merge; without it, today's sendWhatsApp path, byte for byte;
 *   - `fetchImpl`: send_brochure's HEAD on the brochure URL (only in auto mode, only to Bona's site);
 *     `saveNeeds` is a test seam.
 *   The five WhatsApp tools answer only an in-process call (`runInProcess`, which PR-INT hands the brain as
 *   its runTool); on the HTTP route they refuse with `not_in_process`.
 */
export function createToolHandlers({
  inventory, units = null, store, db, dataDir, siteUrl, env = {}, sendWhatsApp, log = () => {},
  now = () => Date.now(), leadDedupeMs = LEAD_DEDUPE_MS, notifyHandoff = async () => {},
  fullUnitRowSources = FULL_UNIT_ROW_SOURCES, publishedUnits = null,
  ownerTest = null, viewing = null, notes = null, fetchImpl = (...a) => globalThis.fetch(...a), saveNeeds = saveLeadNeeds,
  brochureHeadMs = BROCHURE_HEAD_MS, brochureCacheMs = BROCHURE_CACHE_MS, brochureFailCacheMs = BROCHURE_FAIL_CACHE_MS,
  blockedBrochures = BLOCKED_BROCHURES,
}) {
  if (!db) throw new TypeError('createToolHandlers needs the store (db)');
  const blocked = new Set(blockedBrochures);
  /** The live listing pages' published unit summaries (one GET per search_units call, no cache, fail closed). */
  const published = publishedUnits ?? createPublishedUnits({ siteUrl, log });
  /** leadKey → { at, id }. Bounded by the dedupe window, pruned on every save. */
  const recentLeads = new Map();

  async function search_properties(args, ctx) {
    const listings = inventory.search({ ...normaliseSearchArgs(args), limit: 5 });
    // Today's row for every caller on the HTTP route (the concierge, the legacy WhatsApp agent, the phone line);
    // the brain's in-process route gets the brochure flag and the pin too (PR-B4). A held brochure is no brochure
    // to the model (send_brochure answers false for it).
    const assistant = ctx.inProcess === true;
    const results = listings.map((l) => inventory.row(l, { assistant }))
      .map((r) => (assistant && r.has_brochure && blocked.has(r.id) ? { ...r, has_brochure: false } : r));
    for (const l of listings.slice(0, 3)) store.addCard(ctx.conversationId, inventory.card(l));
    // Only the brain's in-process WhatsApp route gets the new note: the legacy Retell WhatsApp agent's sessions say
    // source bona-whatsapp too (dana-wa.mjs), and every HTTP caller keeps main's note byte for byte (strict inert).
    const onWhatsApp = ctx.inProcess === true && (ctx.attr?.source ?? null) === WA_SOURCE;
    return {
      count: results.length,
      results,
      note: results.length
        ? 'These are the only matching homes in Bona inventory. Quote these prices exactly; never estimate.'
        : onWhatsApp
          ? WA_NO_MATCH_NOTE
          : 'No match in Bona inventory. Do not invent a property or a price — offer to connect the visitor with a Bona specialist on WhatsApp +966 57 626 7694.',
    };
  }

  async function show_property(args, ctx) {
    const listing = inventory.find(args.id ?? args.slug ?? args.property ?? args.listing_id ?? args.ref);
    if (!listing) return { shown: false, reason: 'not_found', note: 'That property is not in Bona inventory — do not describe it.' };
    const card = inventory.card(listing);
    store.addCard(ctx.conversationId, card);
    return { shown: true, id: card.id, title: card.title, url: card.url[ctx.locale] ?? card.url.en };
  }

  /**
   * Unit prices inside one project (today: Darco Prime Waterfront, BONA-W014), for every source: WhatsApp,
   * email, the website chat and a missing or unknown source. The answer is what the LIVE listing page publishes
   * (DESIGN §4.5): the summary its units table carries (lib/published-units.mjs), one row per bedroom count with
   * its lowest cash price, read by one GET of the live page on every call (no cache, no last-good fallback): the
   * quote is what the page showed to this call's GET. Nothing (the "not published" note) when the
   * inventory does not list the project as available, or the live page shows no table, a malformed one or another
   * listing's, or could not be read on this call. units.json is not read here: the page alone says what is
   * published. No unit refs, no per-unit prices, no payment plans: those are not published. The model's filters
   * are ignored.
   */
  async function search_units(args, ctx) {
    // The first id that is not blank; none (missing, null, '' or spaces) means W014, as the tool schema says.
    const listingId = [args.listing_id, args.id, args.property]
      .map((v) => (v == null ? '' : String(v).trim().toUpperCase())).find(Boolean) || 'BONA-W014';
    const source = ctx.source ?? ctx.attr?.source ?? null;
    if (units && fullUnitRowSources.includes(source)) return unitRows(args, ctx, listingId);

    const listing = inventory.find(listingId);
    // Both must hold: the inventory lists this exact id as available AND the live page shows the table. The live page
    // is the ceiling: we never quote more than it shows. The local available/sold status can only remove a quote,
    // never add one, so a sold listing is not quoted from a page that has not rebuilt yet (a delayed or failed Pages
    // deploy). Kept on purpose (PR #86 review round 6); pinned by the tools.test.mjs test "a listing the inventory
    // does not list as available".
    const available = listing?.id === listingId && listing.status === 'available';
    const live = available ? await published.get(listing) : null;
    if (!live) return { count: 0, summary: null, note: UNITS_NOT_PUBLISHED_NOTE };

    // Put the project card on screen so the visitor sees what is being discussed.
    store.addCard(ctx.conversationId, inventory.card(listing));
    return { count: live.count, summary: publishedUnitsCut(live), note: UNITS_NOTE };
  }

  /**
   * The owner's veto path only (FULL_UNIT_ROW_SOURCES, empty by default): today's per-unit rows, with the
   * developer's figures for the plan asked for. Unchanged from before the cut.
   */
  function unitRows(args, ctx, listingId) {
    const overview = units.summary(listingId);
    if (!overview) {
      return {
        count: 0, results: [],
        note: 'No per-unit stock list for that project. Answer from search_properties only, and do not invent unit numbers or prices.',
      };
    }

    const n = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const x = Number(toAsciiDigits(v));
      return Number.isFinite(x) ? x : null;
    };
    const bool = (v) => (v === true || v === 'true' || v === 'yes' ? true : v === false || v === 'false' || v === 'no' ? false : null);

    const plan = args.plan ?? 'cash';
    const { units: rows, total } = units.search({
      listingId,
      beds: n(args.beds ?? args.bedrooms),
      minBeds: n(args.min_beds), maxBeds: n(args.max_beds),
      building: args.building ?? args.block ?? null,
      floor: args.floor ?? null,
      facing: args.facing ?? args.orientation ?? args.view ?? null,
      unitClass: args.class ?? args.unit_class ?? null,
      maidRoom: bool(args.maid_room ?? args.maids_room),
      minPrice: n(args.min_price), maxPrice: n(args.max_price),
      minArea: n(args.min_area), maxArea: n(args.max_area),
      plan,
      query: args.query ?? null,
      limit: n(args.limit) ?? 8,
    });

    const results = rows.map((u) => units.toRow(u, plan));

    const listing = inventory.find(listingId);
    if (listing) store.addCard(ctx.conversationId, inventory.card(listing));

    return {
      count: results.length,
      total_matching: total,
      availability: overview,
      results,
      note: results.length
        ? `${total} unit(s) match; the ${results.length} cheapest are listed. Prices are the developer's published figures for the "${plan}" plan — quote them exactly, never estimate, and give the unit reference (e.g. B08-19) so the buyer can ask for it by name.`
        : "No unit matches those criteria in the developer's stock list. Say so plainly, offer the closest alternative from `availability`, and never invent a unit.",
    };
  }

  /**
   * The property a lead is about: the tool argument when the model named one (an id,
   * a slug or a title, resolved against inventory), else the page the widget was
   * opened on, which the visitor's `attr` carried through Retell's metadata.
   */
  function leadListing(args, ctx) {
    const named = args.listing_id ?? args.property_id ?? args.id;
    if (named) {
      const hit = inventory.find(named);
      if (hit) return hit.id;
      const upper = String(named).trim().toUpperCase();
      if (/^BONA-W?\d{3}$/.test(upper)) return upper;
    }
    return ctx.attr?.listing_id ?? null;
  }

  async function create_lead(args, ctx) {
    const lead = {
      name: args.name, phone: args.phone ?? args.phone_number ?? args.mobile,
      interest: args.interest ?? args.enquiry, budget: args.budget,
      timeline: args.timeline, notes: args.notes, language: args.language ?? ctx.locale,
      district: args.district ?? args.area ?? args.location,
      listingId: leadListing(args, ctx),
    };
    if (!lead.phone && !lead.name) {
      return { saved: false, reason: 'missing_contact', note: 'Ask for a name or a phone number before saving the enquiry.' };
    }

    // Retell retries a timed-out tool call, and a model that is being talked into it
    // will call create_lead twice. One enquiry per conversation per contact.
    const t = now();
    const key = leadKey({ conversationId: ctx.conversationId, phone: lead.phone, name: lead.name });
    for (const [k, v] of recentLeads) if (t - v.at > leadDedupeMs) recentLeads.delete(k);
    const seen = recentLeads.get(key);
    const handoff = id => ensureHandoff(db, {leadId:id,source:ctx.channel === 'chat' ? 'concierge_chat' : 'concierge_voice',reason:args.no_match === true ? 'External sourcing needed' : 'Concierge enquiry',details:{budget:args.budget,area:lead.district,property_type:args.property_type,timeframe:args.timeline,financing:args.financing,no_match:args.no_match,viewing_requested:args.viewing_requested},now:t});
    if (seen) {
      handoff(seen.id);
      await notifyHandoff(seen.id);
      log({ evt: 'lead.duplicate', id: seen.id, conversationId: ctx.conversationId ?? null });
      return {
        saved: true, id: seen.id, duplicate: true,
        note: 'This enquiry is already saved — do not save it again. Tell the visitor a Bona principal will be in touch.',
      };
    }

    // The visitor's session came through Retell's metadata (set by /v1/chat/session
    // and /v1/call/token), so a concierge lead inherits the campaign that brought them.
    const attr = ctx.attr ?? {};
    const { lead: record, created } = db.transaction(() => {
    const saved = createOrMergeLead(db, lead, {
      channel: ctx.channel === 'chat' ? 'concierge_chat' : 'concierge_voice', matchMethod: 'concierge',
      sessionId: attr.session_id ?? null, anonId: attr.anon_id ?? null, ref: attr.ref ?? null,
      now: t, dataDir, raw: { conversationId: ctx.conversationId ?? null, page: ctx.page ?? null },
    });
    handoff(saved.lead.lead_id);
    return {...saved,lead:db.getLead(saved.lead.lead_id)};
    });
    recentLeads.set(key, { at: t, id: record.lead_id });
    store.markLead(ctx.conversationId);
    log({ evt: 'lead.saved', id: record.lead_id, created, channel: record.channel, source: record.source, conversationId: ctx.conversationId ?? null });
    if (typeof notes?.leadEvent === 'function') {
      // The owner notes decide (DESIGN §7.2): with the ledger, a merge (created false) is no new client and sends nothing.
      try {
        await notes.leadEvent(record, { why: 'concierge', created: created === true });
      } catch (err) {
        log({ evt: 'lead.wa_error', id: record.lead_id, error: String(err?.message ?? err) });
      }
    } else if (sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote(record, { siteUrl }));
        if (!res?.ok) log({ evt: 'lead.wa_failed', id: record.lead_id, error: res?.error ?? 'unknown' });
      } catch (err) {
        log({ evt: 'lead.wa_error', id: record.lead_id, error: String(err?.message ?? err) });
      }
    }
    await notifyHandoff(record.lead_id);
    return { saved: true, id: record.lead_id, note: 'Enquiry saved. Tell the visitor a Bona principal will be in touch, and offer WhatsApp +966 57 626 7694 to speak now.' };
  }

  /**
   * Dana on WhatsApp hands the conversation to the team (design §6, P4-19). The tool result
   * only tells the model what to say; the hand-over itself (the flag, the alert, the one
   * line) is lib/dana-wa.mjs's, read off the completion. The `reason` argument is the
   * model's words about the client and is never logged; the lead id from the chat's
   * metadata is, when it looks like one.
   */
  async function request_human(args, ctx) {
    const leadId = typeof ctx.attr?.lead_id === 'string' && LEAD_ID_RE.test(ctx.attr.lead_id) ? ctx.attr.lead_id : null;
    log({ evt: 'tool.request_human', leadId });
    const kind = HANDOVER_KINDS.includes(args.kind) ? args.kind : 'other';
    return { ok: true, kind, note: 'A Bona team member will take this conversation over. Tell the client, in one short sentence, that the team will reply shortly — and say nothing else.' };
  }

  /* ---------------- PR-B4: the assistant's tools (DESIGN §4.3) ---------------- */

  const textArg = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
  const exact = (ref) => (typeof inventory.exact === 'function' ? inventory.exact(ref) : exactListing(inventory.all?.() ?? [], ref));
  const lang = (ctx) => (ctx.locale === 'ar' ? 'ar' : 'en');

  /**
   * The lead a WhatsApp-only tool serves, or why it serves none (DESIGN §4.3): the source and the lead id come
   * from the chat's metadata, which code sets (the brain's envelope; the model cannot forge them), the lead
   * must be in the inbox, and in auto mode (the same-release rule, §2): otherwise these tools answer as if
   * nothing was available.
   */
  function waLead(ctx) {
    if (ctx.inProcess !== true) return { why: 'not_in_process' };
    const source = ctx.attr?.source ?? null;
    if (source !== WA_SOURCE) return { why: source === 'bona-email' ? 'not_on_email' : 'not_on_this_channel' };
    const id = ctx.attr?.lead_id;
    const lead = typeof id === 'string' && LEAD_ID_RE.test(id) ? db.getLead(id) ?? null : null;
    if (!lead) return { why: 'bad_lead' };
    // Only a chat the assistant may answer (as viewing's gate): a late turn never writes to a lead that left the inbox.
    if (lead.inbox_state !== 'in') return { why: 'not_in_inbox' };
    let auto = false;
    try { auto = ownerTest?.autoMode?.(lead) === true; } catch { auto = false; }
    if (!auto) return { why: 'not_auto' };
    return { lead };
  }
  const offNote = (why) => (why === 'not_on_email' ? NOT_ON_EMAIL_NOTE : NOT_HERE_NOTE);

  async function viewing_slots(args, ctx) {
    const who = waLead(ctx);
    if (!who.lead) return { bookable: false, reason: who.why, note: who.why === 'not_on_email' ? NOT_ON_EMAIL_NOTE : SLOTS_OFF_NOTE };
    const listingId = textArg(args.listing_id)?.toUpperCase() ?? null;
    const r = viewing && listingId ? await viewing.slots({ lead: who.lead, listingId }) : { bookable: false, reason: listingId ? undefined : 'listing' };
    if (r?.bookable !== true || !Array.isArray(r.slots)) {
      // The reason code only: a calendar's own error code never reaches the model.
      return { bookable: false, ...(typeof r?.reason === 'string' ? { reason: r.reason } : {}), note: SLOTS_OFF_NOTE };
    }
    // The same name rule as book_viewing (viewing.validate → lead-tasks plausibleName): a CRM name "A" is no name.
    const askName = !plausibleName(who.lead.name);
    return {
      bookable: true, timezone: r.timezone,
      slots: r.slots.map((x) => ({ slot_id: x.slot_id, label_ar: x.label_ar, label_en: x.label_en })),
      ask_name: askName,
      note: askName
        ? 'Offer 3 or 4 of these slots by their labels in one message, and ask for their name in that same message.'
        : 'Offer 3 or 4 of these slots by their labels in one message.',
    };
  }

  /** Validates only (viewing.validate writes nothing): the booking is committed after preSend (lib/dana-commit.mjs). */
  async function book_viewing(args, ctx) {
    const who = waLead(ctx);
    if (!who.lead) return { reserved: false, reason: who.why, note: offNote(who.why) };
    const v = viewing
      ? viewing.validate({ lead: who.lead, listingId: textArg(args.listing_id)?.toUpperCase() ?? null, slotId: textArg(args.slot_id), name: textArg(args.name) ?? undefined })
      : { ok: false, reason: 'off' };
    if (v?.ok === true) return { reserved: true, slot_id: v.slotId, listing_id: v.listingId, note: BOOKING_NOTE };
    if (v?.needName) return { reserved: false, need_name: true, reason: 'need_name', note: 'Ask for their name, then call book_viewing again with it.' };
    return { reserved: false, reason: typeof v?.reason === 'string' ? v.reason : 'off', note: 'That slot cannot be taken: offer another slot from viewing_slots, or call request_human with kind viewing.' };
  }

  /** brochureUrl → its size in bytes, or null (unknown); one HEAD per URL per 12 h (10 min after a failure). */
  const sizes = new Map();
  async function brochureSize(url) {
    const t = now();
    const hit = sizes.get(url);
    if (hit && t - hit.at < hit.ttl) return hit.size;
    for (const [k, v] of sizes) if (t - v.at >= v.ttl) sizes.delete(k);
    const ac = new AbortController();
    let timer;
    let size = null;
    try {
      const res = await Promise.race([
        // No redirect is followed: the HEAD goes to Bona's own host and nowhere else.
        Promise.resolve().then(() => fetchImpl(url, { method: 'HEAD', redirect: 'error', signal: ac.signal })),
        new Promise((resolve) => { timer = setTimeout(() => { ac.abort(); resolve(null); }, brochureHeadMs); }),
      ]);
      const len = res?.ok ? Number(res.headers?.get?.('content-length')) : NaN;
      size = Number.isSafeInteger(len) && len > 0 ? len : null;
      if (size === null) log({ evt: 'tool.brochure_size', status: res ? Number(res.status) || null : 'timeout' });
    } catch {
      size = null;
      log({ evt: 'tool.brochure_size', status: 'error' });
    } finally {
      clearTimeout(timer);
    }
    sizes.set(url, { at: t, size, ttl: size === null ? brochureFailCacheMs : brochureCacheMs });
    return size;
  }
  /**
   * This chat already has its PDF for the day (DESIGN §6.3): a document row in wa_outbox in the last 24 h (accepted,
   * pending or uncertain: one that may have gone counts; it survives a restart), or a PDF this process promised it for
   * another home within 24 h (two brochures in one turn: one PDF, one link). The same home again stays a PDF, so the
   * brain's retry of a turn gets the same answer; dana-commit sends at most one document a turn anyway.
   */
  const pdfPromised = new Map();
  function pdfToday(lead, listingId) {
    const t = now();
    for (const [k, v] of pdfPromised) if (t - v.at >= PDF_PER_CHAT_MS) pdfPromised.delete(k);
    const promised = pdfPromised.get(lead.lead_id);
    if (promised && promised.listingId !== listingId) return true;
    return Boolean(db.db.prepare("SELECT 1 FROM wa_outbox WHERE lead_id = ? AND media_kind = 'document' AND status IN ('accepted','pending','uncertain') AND created >= ? LIMIT 1")
      .get(lead.lead_id, t - PDF_PER_CHAT_MS));
  }
  /** The assistant has not answered this chat yet (dana-wa's `introduced`): a first message carries no PDF. */
  const firstMessage = (lead) => Number(lead.dana_introduced) !== 1
    && !db.db.prepare("SELECT 1 FROM wa_outbox WHERE lead_id = ? AND sender_kind = 'dana' AND status = 'accepted' LIMIT 1").get(lead.lead_id);

  async function send_brochure(args, ctx) {
    const who = waLead(ctx);
    if (!who.lead) return { will_send: false, reason: who.why, note: offNote(who.why) };
    const listing = exact(args.listing_id);
    if (!listing) return { will_send: false, reason: 'not_found', note: 'That home is not in Bona inventory.' };
    if (blocked.has(listing.id)) return { will_send: false, reason: 'held', note: NO_BROCHURE_NOTE };
    if (typeof listing.brochureUrl !== 'string' || !listing.brochureUrl.trim()) return { will_send: false, reason: 'no_brochure', note: NO_BROCHURE_NOTE };
    // Only a brochure on Bona's own site is sent, linked or measured: never a request to another host.
    const url = brochureUrlOn(listing.brochureUrl, siteUrl);
    if (!url) return { will_send: false, reason: 'not_on_site', note: NO_BROCHURE_NOTE };
    const link = (reason) => ({ will_send: 'link', reason, url, note: 'Give this link on its own line; no PDF is sent.' });
    if (firstMessage(who.lead)) return link('first_message');
    if (pdfToday(who.lead, listing.id)) return link('pdf_today');
    const size = await brochureSize(url);
    if (size === null) return link('size_unknown');
    if (size > BROCHURE_MAX_BYTES) return link('too_big');
    pdfPromised.set(who.lead.lead_id, { listingId: listing.id, at: now() });
    return { will_send: 'pdf', reason: 'ok', note: 'The PDF goes right after your message: say one short line that you are sending it.' };
  }

  async function send_location(args, ctx) {
    const who = waLead(ctx);
    if (!who.lead) return { precision: 'none', reason: who.why, note: offNote(who.why) };
    const listing = exact(args.listing_id);
    const pin = listing ? pinOf(listing) : 'none';
    if (pin === 'exact') return { precision: 'exact', note: 'The map link is added after your message: do not write a link or coordinates.' };
    if (pin === 'district') {
      const l = lang(ctx);
      return {
        precision: 'district', district: listing.location?.district?.[l] ?? listing.location?.district?.en ?? null, city: listing.location?.city?.[l] ?? listing.location?.city?.en ?? null,
        note: 'Describe the district in words; never give a pin or a map link. The team shares the exact meeting point.',
      };
    }
    return { precision: 'none', note: listing ? 'Say the team will share the location.' : 'That home is not in Bona inventory.' };
  }

  /** Writes at once through lead-tasks saveNeeds' own allow-list (not cleanNeeds, which drops the name; #5). No hand-over. */
  async function save_needs(args, ctx) {
    const who = waLead(ctx);
    if (!who.lead) return { saved: false, reason: who.why, note: offNote(who.why) };
    const needs = {};
    for (const k of NEED_KEYS) {
      const v = typeof args[k] === 'string' && args[k].trim() ? args[k] : null;
      if (v) needs[k] = v;
    }
    if (!Object.keys(needs).length) return { saved: false, reason: 'nothing_to_save', note: 'Nothing to save: pass only what the client said.' };
    saveNeeds(db, { leadId: who.lead.lead_id, needs, now: now() });
    // What the lead row holds now, field by field: saved (written now or already there) or refused by
    // lead-tasks' allow-list (a name under two letters, a listing id that is not one). Idempotent.
    const fresh = db.getLead(who.lead.lead_id) ?? {};
    const keys = Object.keys(needs);
    const savedFields = keys.filter((k) => storedNeed(fresh, k, needs[k]));
    const rejected = keys.filter((k) => !savedFields.includes(k));
    if (!savedFields.length) {
      const why = rejected.includes('name') ? ' (a name needs at least two letters)' : '';
      return {
        saved: false, reason: 'rejected', saved_fields: [], rejected,
        note: `Nothing was saved: ${rejected.join(', ')} ${rejected.length > 1 ? 'were' : 'was'} not accepted${why}. Do not say you noted it; ask again if it matters.`,
      };
    }
    return {
      saved: true, saved_fields: savedFields, rejected,
      note: rejected.length
        ? `Saved: ${savedFields.join(', ')}; not saved: ${rejected.join(', ')}. Say you noted only what was saved; this hands nothing over.`
        : 'Saved. You may say you have noted it; this hands nothing over.',
    };
  }

  /** Read-only, for any source (DESIGN §4.3): published text only, so the phone line's HTTP route may serve it too. */
  async function listing_details(args, ctx) {
    const ref = args.listing_id ?? args.id;
    if (typeof inventory.details === 'function') return inventory.details(ref, lang(ctx));
    return { found: false };
  }

  const handlers = {
    search_properties, show_property, search_units, create_lead, request_human,
    listing_details, viewing_slots, book_viewing, send_brochure, send_location, save_needs,
  };

  /**
   * Run a tool by name. `extra` comes from code only, never from the body: `{ inProcess: true }` (the brain,
   * runInProcess) unlocks the five WhatsApp tools and the brain's search row; the HTTP route passes none.
   * @returns {Promise<string>} the JSON string handed back to Retell
   */
  async function run(name, body, extra = {}) {
    const handler = handlers[name];
    if (!handler) throw Object.assign(new Error(`unknown tool ${name}`), { code: 'UNKNOWN_TOOL' });
    const ctx = {
      conversationId: conversationId(body),
      locale: conversationLocale(body),
      channel: body.chat || body.chat_id ? 'chat' : 'voice',
      page: body.call?.metadata?.page ?? body.chat?.metadata?.page ?? null,
      // The metadata we set when the conversation opened: locale, page, source and the
      // visitor's attribution ids (anon_id, session_id, ref, listing_id).
      attr: body.call?.metadata ?? body.chat?.metadata ?? {},
      ...extra,
    };
    const result = await handler(toolArgs(body), ctx);
    return JSON.stringify(result);
  }

  /** The brain's way in (lib/brain.mjs runTool; PR-INT wires it): the same tools, marked in-process. */
  const runInProcess = (name, body) => run(name, body, { inProcess: true });

  return { handlers, run, runInProcess };
}
