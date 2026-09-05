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
import { timingSafeEqual } from 'node:crypto';
import { appendLead, leadNote } from './leads.mjs';

export const TOOL_NAMES = ['search_properties', 'show_property', 'create_lead'];

/** Constant-time token comparison; empty configured token means "deny". */
export function tokenMatches(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}

/** Token from `?token=`, `X-Bona-Token:` or `Authorization: Bearer …`. */
export function extractToken({ url, headers = {} }) {
  const fromQuery = url?.searchParams?.get('token');
  if (fromQuery) return fromQuery;
  const header = headers['x-bona-token'];
  if (typeof header === 'string' && header) return header;
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return null;
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
 * @param {{ inventory, store, dataDir: string, siteUrl: string, env: object,
 *           sendWhatsApp?: (text: string) => Promise<any>, log?: Function }} deps
 */
export function createToolHandlers({ inventory, store, dataDir, siteUrl, env = {}, sendWhatsApp, log = () => {} }) {
  async function search_properties(args, ctx) {
    const listings = inventory.search({
      kind: args.kind ?? args.section,
      type: args.type ?? args.property_type,
      district: args.district ?? args.area ?? args.location,
      category: args.category ?? args.listing_kind,
      minPrice: args.minPrice ?? args.min_price ?? args.budget_min,
      maxPrice: args.maxPrice ?? args.max_price ?? args.budget ?? args.budget_max,
      beds: args.beds ?? args.min_rooms ?? args.bedrooms,
      query: args.query ?? args.q ?? args.text,
      limit: 5,
    });
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

  async function create_lead(args, ctx) {
    const lead = {
      name: args.name, phone: args.phone ?? args.phone_number ?? args.mobile,
      interest: args.interest ?? args.enquiry, budget: args.budget,
      timeline: args.timeline, notes: args.notes, language: args.language ?? ctx.locale,
      district: args.district ?? args.area ?? args.location,
      listingId: args.listing_id ?? args.property_id ?? args.id,
    };
    if (!lead.phone && !lead.name) {
      return { saved: false, reason: 'missing_contact', note: 'Ask for a name or a phone number before saving the enquiry.' };
    }
    const record = appendLead(dataDir, lead, {
      channel: ctx.channel, source: 'concierge',
      extra: { conversationId: ctx.conversationId ?? null, page: ctx.page ?? null },
    });
    store.markLead(ctx.conversationId);
    if (sendWhatsApp) {
      try {
        const res = await sendWhatsApp(leadNote({ ...record }, { siteUrl }));
        if (!res?.ok) log({ evt: 'lead.wa_failed', id: record.id, error: res?.error ?? 'unknown' });
      } catch (err) {
        log({ evt: 'lead.wa_error', id: record.id, error: String(err?.message ?? err) });
      }
    }
    return { saved: true, id: record.id, note: 'Enquiry saved. Tell the visitor a Bona principal will be in touch, and offer WhatsApp +966 59 329 6933 to speak now.' };
  }

  const handlers = { search_properties, show_property, create_lead };

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
      ...extra,
    };
    const result = await handler(toolArgs(body), ctx);
    return JSON.stringify(result);
  }

  return { handlers, run };
}
