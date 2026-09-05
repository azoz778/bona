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

/** Paths the widget is allowed to navigate to (same-origin, no protocol, no `..`). */
export function safePath(input) {
  if (!input) return null;
  let p = String(input).trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + (u.search || '');
    } catch { return null; }
  }
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('..')) return null;
  if (!/^[\w\-/.~%?=&+,:]*$/.test(p)) return null;
  return p;
}

/**
 * Extract markers from agent text.
 * @returns {{ text: string, actions: Array }}
 */
export function stripMarkers(text) {
  const actions = [];
  const cleaned = String(text ?? '').replace(MARKER_RE, (_m, inner) => {
    const raw = String(inner).trim();
    const sep = raw.indexOf(':');
    const kind = (sep === -1 ? raw : raw.slice(0, sep)).trim().toLowerCase();
    const value = sep === -1 ? '' : raw.slice(sep + 1).trim();
    if ((kind === 'navigate' || kind === 'go' || kind === 'open') && value) {
      const path = safePath(value);
      if (path) actions.push({ type: 'navigate', path });
    } else if ((kind === 'whatsapp' || kind === 'wa') && value !== undefined) {
      actions.push({ type: 'whatsapp', message: value.slice(0, 500) });
    } else if ((kind === 'show' || kind === 'listing' || kind === 'property') && value) {
      actions.push({ type: 'show_ref', ref: value });
    }
    return '';
  });
  return { text: cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), actions };
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** Ids/slugs referenced by a tool result we produced ourselves (best-effort). */
function idsFromResult(content) {
  if (!content) return [];
  let payload = content;
  for (let i = 0; i < 2 && typeof payload === 'string'; i += 1) {
    try { payload = JSON.parse(payload); } catch { break; }
  }
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

  const pushCard = (listing) => {
    if (!listing || seen.has(listing.id)) return;
    seen.add(listing.id);
    out.actions.push({ type: 'show_listing', listing: toCard(listing, { siteUrl }) });
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    const role = msg?.role;
    if (role === 'agent') {
      const { text, actions } = stripMarkers(msg.content);
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
        const ids = idsFromResult(msg.content);
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
  if (!seen.size && pendingSearch.length && inventory?.search) {
    for (const args of pendingSearch) {
      for (const listing of inventory.search({ ...args, limit: maxCards })) pushCard(listing);
      if (seen.size) break;
    }
  }

  // Order: cards first (the panel renders them under the message), then side effects.
  const rank = { show_listing: 0, whatsapp: 1, navigate: 2 };
  out.actions.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));

  if (leadCaptured) out.leadCaptured = true;
  return out;
}
