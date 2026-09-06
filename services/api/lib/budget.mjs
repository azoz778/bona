/**
 * Daily spend ceilings.
 *
 * Retell bills per chat message and per voice minute against the owner's balance, and
 * the rate limiter alone cannot stop that: it is per IP, so a hundred visitors — or a
 * hundred addresses — still add up. These are the absolute stops for one day, counted
 * across everybody, and they reset at midnight in Jeddah rather than at midnight UTC
 * so "today" means what the owner means by it.
 *
 * Asia/Riyadh is UTC+3 all year (Saudi Arabia keeps no DST), so the day boundary is
 * plain arithmetic — no timezone database, no dependency.
 */

export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
export const MAX_CHATS_PER_DAY = 300;
export const MAX_CALLS_PER_DAY = 60;
export const MAX_TURNS_PER_SESSION = 40;

/** The Riyadh calendar day (`YYYY-MM-DD`) a UTC timestamp falls in. */
export function riyadhDay(ts) {
  return new Date(ts + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * @param {{ maxChats?: number, maxCalls?: number, now?: () => number, log?: Function }} opts
 * @returns {{ take(kind: string): boolean, takeChat(): boolean, takeCall(): boolean, refund(kind: string): void, counters(): object }}
 */
export function createBudget({ maxChats = MAX_CHATS_PER_DAY, maxCalls = MAX_CALLS_PER_DAY, now = () => Date.now(), log = () => {} } = {}) {
  let day = riyadhDay(now());
  const used = { chats: 0, calls: 0 };
  const tripped = { chats: false, calls: false };

  function roll() {
    const today = riyadhDay(now());
    if (today === day) return;
    day = today;
    used.chats = 0;
    used.calls = 0;
    tripped.chats = false;
    tripped.calls = false;
  }

  /** Spend one unit. False once the ceiling is reached; logged once per day, not per request. */
  function take(kind, max) {
    roll();
    if (used[kind] >= max) {
      if (!tripped[kind]) {
        tripped[kind] = true;
        log({ level: 'warn', evt: 'budget.exhausted', kind, max, day });
      }
      return false;
    }
    used[kind] += 1;
    return true;
  }

  /**
   * Give a unit back. A charged request that never reached Retell — or reached it and was
   * refused — cost the owner nothing, so it must not shorten the day for the next visitor.
   * Clamped at zero, and it clears the "exhausted" latch so the ceiling can be announced
   * again if the day really does run out later.
   *
   * A refund that arrives after midnight in Jeddah finds a fresh counter and is dropped
   * rather than pushed negative: yesterday's unit cannot be spent today either.
   */
  function refund(kind, max) {
    roll();
    if (used[kind] > 0) used[kind] -= 1;
    if (used[kind] < max) tripped[kind] = false;
  }

  const MAX = { chats: maxChats, calls: maxCalls };

  return {
    /** @param {'chats'|'calls'} kind */
    take: (kind) => take(kind, MAX[kind]),
    /** @param {'chats'|'calls'} kind */
    refund: (kind) => refund(kind, MAX[kind]),
    takeChat: () => take('chats', maxChats),
    takeCall: () => take('calls', maxCalls),
    counters() {
      roll();
      return { day, chats: used.chats, calls: used.calls, maxChats, maxCalls };
    },
  };
}
