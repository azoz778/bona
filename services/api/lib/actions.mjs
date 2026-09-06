/**
 * Turn a Retell `create-chat-completion` response into the widget contract:
 *   { messages: [{ role: 'agent', text }], actions: [...], leadCaptured? }
 *
 * Retell message roles seen in `messages` (retell-sdk 5.64.0 `MessageOrToolCall`):
 *   agent | user | tool_call_invocation | tool_call_result | node_transition |
 *   state_transition | injected | sms
 * Only `agent` text reaches the visitor. Tool invocations drive the UI actions, so
 * the panel shows the same property Dana is talking about.
 *
 * Any `[[…]]` marker the model emits is parsed then stripped — it must never be
 * read out or shown.
 */
import { toCard } from './inventory.mjs';

const MARKER_RE = /\[\[([^\]]*)\]\]/g;

/**
 * The static pages Dana may send a visitor to — exactly the list prompt.md gives her.
 * Anything else (a made-up page, an encoded traversal, another site) is dropped rather
 * than offered as a dead link. `/properties/<slug>/` is allowed separately, but only
 * for a slug that is really in inventory.
 */
export const NAV_ROUTES = [
  '/',
  '/properties/',
  '/properties/houses/',
  '/properties/apartments/',
  '/properties/for-sale/',
  '/properties/for-rent/',
  '/properties/off-plan/',
  '/properties/international/',
  '/tours/',
  '/about/',
  '/contact/',
  '/sell/',
];

const SLUG_PATH_RE = /^\/properties\/([a-z0-9][a-z0-9-]{0,120})\/$/;

/**
 * The aliases a model reaches for, folded onto the one search vocabulary
 * `inventory.search()` understands. Shared by the `search_properties` tool and by the
 * fallback search in `extractActions`, so both see the same query.
 */
export function normaliseSearchArgs(args = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = a[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const out = {
    kind: pick('kind', 'section'),
    type: pick('type', 'property_type'),
    district: pick('district', 'area', 'location', 'neighbourhood', 'neighborhood'),
    category: pick('category', 'listing_kind'),
    minPrice: pick('minPrice', 'min_price', 'price_min', 'budget_min'),
    maxPrice: pick('maxPrice', 'max_price', 'price_max', 'budget', 'budget_max'),
    beds: pick('beds', 'min_rooms', 'bedrooms', 'rooms'),
    query: pick('query', 'q', 'text', 'search'),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * Paths the widget is allowed to navigate to: same-site, decoded, and on the route
 * allowlist above (with an optional `/ar` prefix). Pass `{ inventory }` to also allow
 * a real property page.
 */
export function safePath(input, { inventory = null } = {}) {
  if (!input) return null;
  let p = String(input).trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  if (!p.startsWith('/') || p.startsWith('//')) return null;
  p = p.split(/[?#]/)[0];

  // Decode each segment on its own: "%2e%2e" and "%2f" must not sneak past as one blob.
  const decoded = [];
  for (const segment of p.split('/')) {
    let d;
    try { d = decodeURIComponent(segment); } catch { return null; }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\')) return null;
    decoded.push(d);
  }

  let clean = decoded.join('/').toLowerCase().replace(/\/{2,}/g, '/');
  if (!clean.endsWith('/')) clean += '/';
  const arabic = clean === '/ar/' || clean.startsWith('/ar/');
  const rest = arabic ? clean.slice(3) : clean;
  const prefix = arabic ? '/ar' : '';

  if (NAV_ROUTES.includes(rest)) return `${prefix}${rest}`;
  const slug = SLUG_PATH_RE.exec(rest)?.[1];
  if (slug && inventory?.find) {
    const listing = inventory.find(slug);
    if (listing && String(listing.slug).toLowerCase() === slug) return `${prefix}${rest}`;
  }
  return null;
}

/**
 * Extract markers from agent text.
 * @returns {{ text: string, actions: Array }}
 */
export function stripMarkers(text, { inventory = null } = {}) {
  const actions = [];
  const cleaned = String(text ?? '').replace(MARKER_RE, (_m, inner) => {
    const raw = String(inner).trim();
    const sep = raw.indexOf(':');
    const kind = (sep === -1 ? raw : raw.slice(0, sep)).trim().toLowerCase();
    const value = sep === -1 ? '' : raw.slice(sep + 1).trim();
    if ((kind === 'navigate' || kind === 'go' || kind === 'open') && value) {
      const path = safePath(value, { inventory });
      if (path) actions.push({ type: 'navigate', path });
    } else if ((kind === 'whatsapp' || kind === 'wa') && value !== undefined) {
      actions.push({ type: 'whatsapp', message: value.slice(0, 500) });
    } else if ((kind === 'show' || kind === 'listing' || kind === 'property') && value) {
      actions.push({ type: 'show_ref', ref: value });
    }
    return '';
  });
  return { text: plainText(cleaned), actions };
}

/**
 * The widget renders agent text with textContent (never HTML), so markdown the model emits
 * (**bold**, *italic*, `code`, ### headings, - bullets) must be flattened to plain text here.
 * Bullets become "• ", emphasis markers are dropped, headings lose their hashes.
 */
export function plainText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/^\s*(\d+)[.)]\s+/gm, '$1. ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Our own tool result, unwrapped from the JSON-string-in-a-JSON-string Retell carries. */
function parseResult(content) {
  let payload = content;
  for (let i = 0; i < 2 && typeof payload === 'string'; i += 1) {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  return payload && typeof payload === 'object' ? payload : null;
}

/** Ids/slugs referenced by a tool result we produced ourselves (best-effort). */
function idsFromResult(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.results;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => r?.id ?? r?.slug).filter(Boolean);
}

/**
 * @param {Array} messages           Retell completion messages
 * @param {object} opts
 * @param {{ find(ref):any, search(q):any[], all():any[] }} opts.inventory
 * @param {string} [opts.siteUrl]
 * @param {number} [opts.maxCards]   how many cards a bare search may surface (default 3)
 */
export function extractActions(messages, { inventory, siteUrl = 'https://bona.azoz.uk', maxCards = 3 } = {}) {
  const out = { messages: [], actions: [] };
  let leadCaptured = false;
  const seen = new Set();
  const pendingSearch = [];
  const invocations = new Map();
  // A search that came back `count: 0` is Dana telling the visitor nothing matches.
  // Guessing cards underneath that sentence would contradict her.
  let reportedEmpty = false;

  const pushCard = (listing) => {
    if (!listing || seen.has(listing.id)) return;
    seen.add(listing.id);
    out.actions.push({ type: 'show_listing', listing: toCard(listing, { siteUrl }) });
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = msg?.role;
    if (role === 'agent') {
      const { text, actions } = stripMarkers(msg.content, { inventory });
      for (const a of actions) {
        if (a.type === 'show_ref') pushCard(inventory?.find?.(a.ref));
        else out.actions.push(a);
      }
      if (text) out.messages.push({ role: 'agent', text });
    } else if (role === 'tool_call_invocation') {
      const name = String(msg.name ?? '');
      const args = parseArgs(msg.arguments);
      invocations.set(msg.tool_call_id, { name, args });
      if (name === 'show_property') {
        pushCard(inventory?.find?.(args.id ?? args.slug ?? args.property ?? args.listing_id));
      } else if (name === 'create_lead') {
        leadCaptured = true;
      } else if (name === 'search_properties') {
        pendingSearch.push(args);
      }
    } else if (role === 'tool_call_result') {
      const inv = invocations.get(msg.tool_call_id);
      if (inv?.name === 'search_properties') {
        const payload = parseResult(msg.content);
        if (payload?.count === 0) reportedEmpty = true;
        const ids = idsFromResult(payload);
        if (ids.length) {
          inv.resolved = true;
          for (const id of ids.slice(0, maxCards)) pushCard(inventory?.find?.(id));
        }
      }
      if (inv?.name === 'create_lead') leadCaptured = true;
    }
  }

  // A search that produced no usable ids (e.g. voice-side result trimmed): resolve locally
  // so the visitor still sees what Dana is describing.
  if (!seen.size && !reportedEmpty && pendingSearch.length && inventory?.search) {
    for (const args of pendingSearch) {
      for (const listing of inventory.search({ ...normaliseSearchArgs(args), limit: maxCards })) pushCard(listing);
      if (seen.size) break;
    }
  }

  // Order: cards first (the panel renders them under the message), then side effects.
  const rank = { show_listing: 0, whatsapp: 1, navigate: 2 };
  out.actions.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));

  if (leadCaptured) out.leadCaptured = true;
  return out;
}
