/**
 * The tools the brain offers, one list per route (brain/DESIGN-brain.md §3.1, DESIGN §4.3). The
 * schemas live in code next to the handlers (lib/tools.mjs); nothing is provisioned on Retell
 * for WhatsApp. Seeded (PR-BR) with today's three WhatsApp tools, copied from retell/provision.mjs
 * `whatsappToolsPayload` (as of 13e4954) without the Retell-only fields (`url`, `headers`,
 * `timeout_ms`, `speak_*`, `execution_message_*`); that payload stays as it is for the legacy
 * Retell agent until T27. PR-B4 (T13) added the six new tools (listing_details, viewing_slots,
 * book_viewing, send_brochure, send_location, save_needs), request_human's `kind`, the reworded
 * request_human / search_units descriptions and the `mail` list; T22 adds the email source
 * guard and the prompt's "## On email" section, T28 the `web` route. A route with no list (or
 * no prompt section) offers nothing, and the brain answers such a turn `off`.
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
  // PR-B4: the published per-bedroom "from" cut every source gets (DESIGN §4.5, lib/tools.mjs search_units); the
  // handler ignores filters, so none is offered.
  search_units: {
    description:
      "The published starting prices inside a project sold unit by unit (today BONA-W014, Darco Prime Waterfront): one row per bedroom count with how many units are available, their area range and the lowest cash price, plus the expected delivery and the date of the developer's sheet. Call it when the client asks about that project's apartments, sizes or prices. Quote each price as a 'from' price, exactly as returned. Unit-level prices, unit numbers and payment plans are not published: offer a person for those, and never invent a unit or a price.",
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'Project listing id, e.g. BONA-W014 (Darco Prime Waterfront). Defaults to BONA-W014.' },
      },
      required: [],
    },
  },
  listing_details: {
    description:
      "What one published home is like, in the client's language: its title, district, city, kind, description, highlights, amenities, project facts, what is nearby, its FAQ and its page link. Call it before answering any question about a home's features, view, layout, handover, surroundings or terms; never guess a feature. Take the price from search_properties or search_units.",
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'The listing id a search returned, e.g. BONA-W012.' },
      },
      required: ['listing_id'],
    },
  },
  viewing_slots: {
    description:
      'The free viewing times for one home, from tomorrow, Sunday to Thursday. Call it when the client wants to see or visit a home. Offer 3 or 4 of the slots it returns, by their labels, in one message. If bookable is false, call request_human with kind viewing.',
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'The listing id of the home to view, e.g. BONA-W012.' },
      },
      required: ['listing_id'],
    },
  },
  book_viewing: {
    description:
      'Ask the system to book the viewing slot the client picked: a slot_id viewing_slots returned in this chat. Pass their name if they gave it. It checks the slot and books nothing itself. If reserved, write one short sentence that you are booking it; never say or state that it is booked or confirmed, and never state the time as fixed: the system sends the confirmation. If need_name, ask for their name. Otherwise offer the other slots or a person.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string', description: 'The slot_id exactly as viewing_slots returned it, e.g. 2026-11-29T10:00+03:00.' },
        listing_id: { type: 'string', description: 'The listing id of the home to view.' },
        name: { type: 'string', description: 'The client\'s name, only as they wrote it.' },
      },
      required: ['slot_id', 'listing_id'],
    },
  },
  send_brochure: {
    description:
      "Send one home's brochure when the client asks for it. will_send pdf: the PDF goes right after your message, so say one short line that you are sending it. link: give the url it returns on its own line. false: there is no brochure to send; offer the home's page.",
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'The listing id of the home, e.g. BONA-W003.' },
      },
      required: ['listing_id'],
    },
  },
  send_location: {
    description:
      'Where one home is, when the client asks. precision exact: the system adds the map link after your message, so do not write a link or coordinates. district: describe the district in words, never a pin. none: say the team will share the location.',
    parameters: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'The listing id of the home, e.g. BONA-W003.' },
      },
      required: ['listing_id'],
    },
  },
  save_needs: {
    description:
      'Save what the client told you about themselves and what they want: their name, what they are looking for, budget, area, property type, timeline, or the home they are asking about. Only what they said, never a guess. It sends nothing and hands nothing over; once it is saved you may say you have noted it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Their name, as they wrote it.' },
        interest: { type: 'string', description: 'What they want, in their words: buy a villa, rent an apartment, invest off-plan…' },
        budget: { type: 'string', description: 'Their budget exactly as they said it, never a number you inferred.' },
        district: { type: 'string', description: 'The area, district or city they want.' },
        property_type: { type: 'string', description: 'The property type they stated.' },
        timeline: { type: 'string', description: 'When they want to buy, rent or move, in their words.' },
        listing_id: { type: 'string', description: 'The listing id of the home they are asking about, if any.' },
      },
      required: [],
    },
  },
  // PR-B4: `kind` (DESIGN §4.3; dana-wa reads it from the raw call, §4.2) and no "see or visit": viewings are booked.
  request_human: {
    description:
      'Hand this conversation to Abdulaziz at Bona. Always hand off every serious buyer, including when no current listing matches. Also call it when the client makes or asks about an offer, a discount, a negotiation, a contract, a deposit or a payment, asks for a person or a call, complains, wants to sell or value their own property, asks you to stop replying or asks about their data, their privacy or deleting it, wants a viewing that viewing_slots cannot book, keeps sending voice notes or photos you cannot open, or asks anything you cannot answer from the tools. Set kind. After it returns, tell the client in one short sentence that the team will reply shortly, and say nothing else.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['person', 'offer', 'complaint', 'contract', 'selling', 'viewing', 'other', 'stop', 'privacy', 'deletion'],
          description: 'person = asks for a person or a call; offer = an offer, a discount or a negotiation; complaint; contract = a contract, a deposit or a payment; selling = sell, rent out or value their own property; viewing = a viewing that could not be booked; stop = wants you to stop replying; privacy = asks about their data or privacy; deletion = wants their data deleted; other = anything else, a serious buyer included.',
        },
        reason: { type: 'string', description: 'Why: serious buyer, no current match, viewing, wants a person, offer, complaint or unsure.' },
        budget: { type: 'string', description: 'Only what the buyer stated; never a qualification cutoff.' },
        area: { type: 'string', description: 'Requested area, district or city, if stated.' },
        property_type: { type: 'string', description: 'Requested property type, if stated.' },
        timeframe: { type: 'string', description: 'Buying timeframe in the buyer’s words, if known.' },
        financing: { type: 'string', description: 'Optional: only if the buyer raised it. Never infer creditworthiness.' },
        no_match: { type: 'boolean', description: 'True when external sourcing is needed because current inventory does not match.' },
        viewing_requested: { type: 'boolean', description: 'True only when the buyer explicitly requested a viewing. This does not confirm a booking.' },
      },
      required: ['reason', 'kind'],
    },
  },
});

/**
 * What each route offers, in this order (PLAN T13 test 3). `mail` is the email reply's list (no booking, no brochure
 * or location: DESIGN §9.2 step 10); the brain answers a `mail` turn only once prompts/assistant.md has its
 * "## On email" section (T22), and nothing calls it before then. `web` (T28) has none yet.
 */
export const ROUTE_TOOLS = Object.freeze({
  wa: Object.freeze(['search_properties', 'search_units', 'listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs', 'request_human']),
  mail: Object.freeze(['search_properties', 'search_units', 'listing_details', 'save_needs', 'request_human']),
});

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
