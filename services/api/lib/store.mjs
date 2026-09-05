/**
 * In-memory session + call-context store with a 2 hour TTL.
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

  function sweep() {
    const t = now();
    for (const [k, v] of sessions) if (expired(v, t)) { sessions.delete(k); byExternal.delete(v.chatId); }
    for (const [k, v] of calls) if (expired(v, t)) { calls.delete(k); byExternal.delete(k); }
    if (sessions.size > maxEntries) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
      for (const [k, v] of oldest.slice(0, sessions.size - maxEntries)) { sessions.delete(k); byExternal.delete(v.chatId); }
    }
  }

  function createSession({ chatId, locale = 'en', page = null, greeting = null }) {
    sweep();
    const t = now();
    const sessionId = randomId();
    const entry = { sessionId, chatId, locale, page, greeting, createdAt: t, touchedAt: t, cards: [], leadCaptured: false, turns: 0 };
    sessions.set(sessionId, entry);
    if (chatId) byExternal.set(chatId, sessionId);
    return entry;
  }

  function getSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    if (expired(entry, now())) { sessions.delete(sessionId); byExternal.delete(entry.chatId); return null; }
    entry.touchedAt = now();
    return entry;
  }

  function endSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    sessions.delete(sessionId);
    byExternal.delete(entry.chatId);
    return true;
  }

  function createCall({ callId, locale = 'en', page = null }) {
    sweep();
    const t = now();
    const entry = { callId, locale, page, createdAt: t, touchedAt: t, updatedAt: t, cards: [] };
    calls.set(callId, entry);
    byExternal.set(callId, callId);
    return entry;
  }

  function getCall(callId) {
    const entry = calls.get(callId);
    if (!entry) return null;
    if (expired(entry, now())) { calls.delete(callId); return null; }
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
    stats: () => ({ sessions: sessions.size, calls: calls.size }),
  };
}
