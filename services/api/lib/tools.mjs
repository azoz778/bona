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
import { toAsciiDigits } from './inventory.mjs';

export const TOOL_NAMES = ['search_properties', 'show_property', 'search_units', 'create_lead'];

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
  const locale = dyn.locale ?? meta.locale ?? 'en';
  return locale === 'ar' ? 'ar' : 'en';
}

/** Retell nests arguments under `args` unless the tool sets `args_at_root`. */
export function toolArgs(body = {}) {
  if (body.args && typeof body.args === 'object') return body.args;
  const { call, chat, name, ...rest } = body;
  return rest && typeof rest === 'object' ? rest : {};
}

/**
 * Build the three handlers.
 * @param {{ inventory, store, db, dataDir: string, siteUrl: string, env: object,
 *           sendWhatsApp?: (text: string) => Promise<any>, log?: Function,
 *           now?: () => number, leadDedupeMs?: number }} deps
 *   `db` is the SQLite store (`openDb`); `dataDir` is where the raw `leads.jsonl` lives.
 */
export function createToolHandlers({
  inventory, units = null, store, db, dataDir, siteUrl, env = {}, sendWhatsApp, log = () => {},
  now = () => Date.now(), leadDedupeMs = LEAD_DEDUPE_MS,
}) {
  if (!db) throw new TypeError('createToolHandlers needs the store (db)');
  /** leadKey → { at, id }. Bounded by the dedupe window, pruned on every save. */
  const recentLeads = new Map();

  async function search_properties(args, ctx) {
    const listings = inventory.search({ ...normaliseSearchArgs(args), limit: 5 });
    const results = listings.map((l) => inventory.row(l));
    for (const l of listings.slice(0, 3)) store.addCard(ctx.conversationId, inventory.card(l));
    return {
      count: results.length,
      results,
      note: results.length
        ? 'These are the only matching homes in Bona inventory. Quote these prices exactly; never estimate.'
        : 'No match in Bona inventory. Do not invent a property or a price — offer to connect the visitor with a Bona specialist on WhatsApp +966 59 329 6933.',
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
   * Per-unit stock inside one project (today: Darco Prime Waterfront, BONA-W014).
   * `search_properties` answers "which projects"; this answers "which unit, on
   * which floor, facing where, and for how much" — the question a buyer actually
   * asks. Prices come from the developer's own inventory sheet; the model must
   * quote them exactly and never estimate.
   */
  async function search_units(args, ctx) {
    if (!units) return { count: 0, results: [], note: 'Unit-level stock is not loaded. Use search_properties and offer a specialist.' };

    const listingId = String(args.listing_id ?? args.id ?? args.property ?? 'BONA-W014').trim().toUpperCase();
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

    // Put the project card on screen so the visitor sees what is being discussed.
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
    if (seen) {
      log({ evt: 'lead.duplicate', id: seen.id, conversationId: ctx.conversationId ?? null });
      return {
        saved: true, id: seen.id, duplicate: true,
        note: 'This enquiry is already saved — do not save it again. Tell the visitor a Bona principal will be in touch.',
      };
    }

    // The visitor's session came through Retell's metadata (set by /v1/chat/session
    // and /v1/call/token), so a concierge lead inherits the campaign that brought them.
    const attr = ctx.attr ?? {};
    const { lead: record, created } = createOrMergeLead(db, lead, {
      channel: ctx.channel === 'chat' ? 'concierge_chat' : 'concierge_voice', matchMethod: 'concierge',
      sessionId: attr.session_id ?? null, anonId: attr.anon_id ?? null, ref: attr.ref ?? null,
      now: t, dataDir, raw: { conversationId: ctx.conversationId ?? null, page: ctx.page ?? null },
    });
    recentLeads.set(key, { at: t, id: record.lead_id });
    store.markLead(ctx.conversationId);
    log({ evt: 'lead.saved', id: record.lead_id, created, channel: record.channel, source: record.source, conversationId: ctx.conversationId ?? null });
    if (sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote(record, { siteUrl }));
        if (!res?.ok) log({ evt: 'lead.wa_failed', id: record.lead_id, error: res?.error ?? 'unknown' });
      } catch (err) {
        log({ evt: 'lead.wa_error', id: record.lead_id, error: String(err?.message ?? err) });
      }
    }
    return { saved: true, id: record.lead_id, note: 'Enquiry saved. Tell the visitor a Bona principal will be in touch, and offer WhatsApp +966 59 329 6933 to speak now.' };
  }

  const handlers = { search_properties, show_property, search_units, create_lead };

  /**
   * Run a tool by name.
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

  return { handlers, run };
}
