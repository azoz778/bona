/**
 * The tools the brain offers, one list per route (brain/DESIGN-brain.md §3.1, DESIGN §4.3). The
 * schemas live in code next to the handlers (lib/tools.mjs); nothing is provisioned on Retell
 * for WhatsApp. Seeded (PR-BR) with today's three WhatsApp tools, each description copied word
 * for word from retell/provision.mjs `whatsappToolsPayload` (as of 13e4954) without the
 * Retell-only fields (`url`, `headers`, `timeout_ms`, `speak_*`, `execution_message_*`).
 * T13 adds the six new tools, `kind` and the reworded request_human / search_units
 * descriptions; T22 the `mail` route; T28 the `web` route. A route with no list offers nothing,
 * and the brain answers such a turn `off`.
 *
 * The schemas are written in plain JSON Schema (optional = not in `required`). `toolsFor` turns
 * them into OpenAI strict functions: every property required, an optional one nullable, no
 * additional properties, keys sorted, so the request is byte-stable and shares one cached prefix.
 * These are behaviour: bona-api loads them at start, so a change here is a latent deploy.
 */

export const TOOL_SCHEMAS = Object.freeze({
  search_properties: {
    description:
      "Search Bona's live inventory. Call this BEFORE answering anything about what is available, in which district, at what price, or how many bedrooms. Returns up to 5 real listings with their asking prices. If it returns nothing, say so honestly — never invent a property and never estimate a price.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text of what the visitor asked, in their own words (Arabic or English).' },
        kind: { type: 'string', enum: ['house', 'apartment', 'land', 'building'], description: 'Section of the site.' },
        district: { type: 'string', description: 'Neighbourhood or city, e.g. Al Khalidiyah, Al Shati, Obhur, الروضة, Jeddah, Riyadh.' },
        category: { type: 'string', enum: ['buy', 'rent', 'off-plan', 'international'], description: 'buy = for sale, rent = rental, off-plan = under construction, international = outside Saudi Arabia.' },
        minPrice: { type: 'string', description: 'Lowest budget as the visitor said it, e.g. "2m", "٣ ملايين", "1500000".' },
        maxPrice: { type: 'string', description: 'Highest budget as the visitor said it.' },
        beds: { type: 'integer', description: 'Minimum number of bedrooms.' },
      },
      required: [],
    },
  },
  search_units: {
    description:
      "Look inside a project at the developer's per-unit stock list, and answer WHICH units are still available and at what price. Call this instead of search_properties as soon as the visitor asks about a specific project's apartments — how many bedrooms, which floor, which view, which building, what it costs, or what payment plans exist. Returns matching units with their reference (e.g. B08-19), floor, facing, area and exact price, plus an `availability` summary of the whole project. Quote these figures exactly; never estimate a price and never invent a unit number.",
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'Project listing id, e.g. BONA-W014 (Darco Prime Waterfront). Defaults to BONA-W014.' },
        beds: { type: 'number', description: 'Exact bedroom count the visitor asked for.' },
        min_beds: { type: 'number', description: 'Minimum bedrooms, when they said "at least".' },
        max_beds: { type: 'number', description: 'Maximum bedrooms.' },
        building: { type: 'string', description: 'Building/block reference, e.g. B08.' },
        floor: { type: 'string', description: 'Floor as the visitor said it: Ground, 1st, 2nd, 3rd, or "Roof annex".' },
        facing: { type: 'string', description: 'Orientation: North, South, East, West, North-East, South-West…' },
        class: { type: 'string', description: 'Unit class: Standard, Premium, Penthouse or The Jewel.' },
        maid_room: { type: 'boolean', description: 'True when they specifically want a maid\'s room.' },
        min_price: { type: 'number', description: 'Lowest price they will consider, in SAR.' },
        max_price: { type: 'number', description: 'Budget ceiling in SAR — the most useful filter.' },
        min_area: { type: 'number', description: 'Minimum built area in square metres.' },
        max_area: { type: 'number', description: 'Maximum built area in square metres.' },
        plan: {
          type: 'string',
          enum: ['cash', 'half', 'year', 'twoYear'],
          description: 'Which published price to quote: cash (default), half = 6-month instalments, year = 1-year, twoYear = 2-year/finance.',
        },
        limit: { type: 'number', description: 'How many units to return, 1–20. Default 8.' },
      },
      required: [],
    },
  },
  request_human: {
    description:
      'Hand this WhatsApp conversation to Abdulaziz at Bona. Always hand off every serious buyer, including when no current listing matches. Also call it when the client asks to see or visit a property, makes or asks about an offer, a discount, a negotiation, a contract, a deposit or a payment, asks for a person or a call, complains, wants to sell or value their own property, keeps sending voice notes or photos you cannot open, or asks anything you cannot answer from the tools. After it returns, tell the client in one short sentence that the team will reply shortly, and say nothing else.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why: serious buyer, no current match, viewing, wants a person, offer, complaint or unsure.' },
        budget: { type: 'string', description: 'Only what the buyer stated; never a qualification cutoff.' },
        area: { type: 'string', description: 'Requested area, district or city, if stated.' },
        property_type: { type: 'string', description: 'Requested property type, if stated.' },
        timeframe: { type: 'string', description: 'Buying timeframe in the buyer’s words, if known.' },
        financing: { type: 'string', description: 'Optional: only if the buyer raised it. Never infer creditworthiness.' },
        no_match: { type: 'boolean', description: 'True when external sourcing is needed because current inventory does not match.' },
        viewing_requested: { type: 'boolean', description: 'True only when the buyer explicitly requested a viewing. This does not confirm a booking.' },
      },
      required: ['reason'],
    },
  },
});

/** What each route offers, in this order. `mail` (T22) and `web` (T28) have none yet. */
export const ROUTE_TOOLS = Object.freeze({ wa: Object.freeze(['search_properties', 'search_units', 'request_human']) });

export const routeToolNames = (route) => [...(Object.hasOwn(ROUTE_TOOLS, route) ? ROUTE_TOOLS[route] : [])];

/** Keys sorted at every level (arrays keep their order), so the JSON is byte-stable. */
function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
  return v;
}

/** OpenAI strict mode: every property required; an optional one also takes null. */
function strictParameters(schema) {
  const required = new Set(schema.required ?? []);
  const properties = {};
  for (const [k, spec] of Object.entries(schema.properties ?? {})) {
    if (required.has(k)) { properties[k] = { ...spec }; continue; }
    properties[k] = { ...spec, type: [spec.type, 'null'], ...(spec.enum ? { enum: [...spec.enum, null] } : {}) };
  }
  const names = Object.keys(properties).sort();
  return { type: 'object', properties, required: names, additionalProperties: false };
}

/** The argument names a tool's schema knows (the dispatcher keeps only these). */
export const schemaArgNames = (name) => Object.keys(TOOL_SCHEMAS[name]?.parameters?.properties ?? {});

/**
 * @param {string} route  'wa' | 'mail' | 'web'
 * @param {string[]} [names]  the caller's offer (DESIGN-brain §3.2 `toolNames`); default: the whole route list
 * @returns {object[]} OpenAI `tools`, in the route's order: only names both offered and known for the route
 */
export function toolsFor(route, names) {
  const offer = Array.isArray(names) ? new Set(names) : null;
  return routeToolNames(route)
    .filter((n) => !offer || offer.has(n))
    .map((name) => sorted({
      type: 'function',
      function: { name, description: TOOL_SCHEMAS[name].description, strict: true, parameters: strictParameters(TOOL_SCHEMAS[name].parameters) },
    }));
}
