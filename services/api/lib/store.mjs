/**
 * In-memory session + call-context store with a 2 hour TTL and a hard entry cap.
 *
 * Chat sessions map our opaque `sessionId` to a Retell `chat_id`; call contexts
 * collect the Cards that `show_property` / `search_properties` produced during a
 * voice call so the widget can render "mentioned properties" live.
 *
 * Deliberately not persisted: transcripts and leads are the durable artefacts
 * (`~/bona-data/*.jsonl`); a restart simply starts fresh conversations.
 */

export const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CARDS = 12;

export function randomId(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function createStore({ ttlMs = TTL_MS, now = () => Date.now(), maxEntries = 5000 } = {}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, any>} */
  const calls = new Map();
  /** chat_id / call_id → sessionId, so a tool webhook can find its conversation. */
  const byExternal = new Map();

  function expired(entry, t) { return t - entry.touchedAt > ttlMs; }

  /* Every removal goes through these two, so no external key is ever orphaned. */
  function dropSession(sessionId, entry = sessions.get(sessionId)) {
    sessions.delete(sessionId);
    if (entry?.chatId) byExternal.delete(entry.chatId);
    byExternal.delete(sessionId);
  }

  function dropCall(callId) {
    calls.delete(callId);
    byExternal.delete(callId);
  }

  /** Evict the oldest entries of `map` until it is back under `maxEntries`. */
  function trim(map, drop) {
    if (map.size <= maxEntries) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [k, v] of oldest.slice(0, map.size - maxEntries)) drop(k, v);
  }

  function sweep() {
    const t = now();
    for (const [k, v] of sessions) if (expired(v, t)) dropSession(k, v);
    for (const [k, v] of calls) if (expired(v, t)) dropCall(k, v);
    trim(sessions, dropSession);
    trim(calls, dropCall);
    // Belt and braces: a `link()` for a conversation that never opened would otherwise
    // sit here for ever. Anything pointing at nothing goes.
    if (byExternal.size > maxEntries * 2) {
      for (const [k, v] of byExternal) {
        if (!sessions.has(v) && !calls.has(k)) byExternal.delete(k);
        if (byExternal.size <= maxEntries * 2) break;
      }
    }
  }

  function createSession({ chatId, locale = 'en', page = null, greeting = null }) {
    const t = now();
    const sessionId = randomId();
    const entry = { sessionId, chatId, locale, page, greeting, createdAt: t, touchedAt: t, cards: [], leadCaptured: false, turns: 0 };
    sessions.set(sessionId, entry);
    if (chatId) byExternal.set(chatId, sessionId);
    sweep(); // after the insert, so the cap is a cap and not a cap-plus-one
    return entry;
  }

  function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    if (expired(entry, now())) { dropSession(sessionId, entry); return null; }
    entry.touchedAt = now();
    return entry;
  }

  function endSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    dropSession(sessionId, entry);
    return true;
  }

  function createCall({ callId, locale = 'en', page = null }) {
    const t = now();
    const entry = { callId, locale, page, createdAt: t, touchedAt: t, updatedAt: t, cards: [] };
    calls.set(callId, entry);
    byExternal.set(callId, callId);
    sweep();
    return entry;
  }

  function getCall(callId) {
    const entry = calls.get(callId);
    if (!entry) return null;
    if (expired(entry, now())) { dropCall(callId); return null; }
    return entry;
  }

  /** Record a Card against a chat or call, newest first, de-duplicated by id. */
  function addCard(externalId, card) {
    if (!externalId || !card) return null;
    const t = now();
    let target = calls.get(externalId);
    if (!target) {
      const sessionId = byExternal.get(externalId) ?? externalId;
      target = sessions.get(sessionId);
    }
    if (!target) {
      target = createCall({ callId: externalId });
    }
    target.cards = [card, ...target.cards.filter((c) => c.id !== card.id)].slice(0, MAX_CARDS);
    target.touchedAt = t;
    target.updatedAt = t;
    return target;
  }

  function markLead(externalId) {
    const sessionId = byExternal.get(externalId) ?? externalId;
    const entry = sessions.get(sessionId) ?? calls.get(externalId);
    if (entry) { entry.leadCaptured = true; entry.touchedAt = now(); }
    return entry ?? null;
  }

  return {
    createSession, getSession, endSession,
    createCall, getCall, addCard, markLead, sweep,
    link: (externalId, sessionId) => byExternal.set(externalId, sessionId),
    stats: () => ({ sessions: sessions.size, calls: calls.size, external: byExternal.size }),
  };
}
