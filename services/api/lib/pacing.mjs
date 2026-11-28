/**
 * Dana's human timing and her caps by warm-up tier (DESIGN §6.2-6.3; PLAN T12, PR-B3). It replaces
 * the PR-F2b stub. Injected into lib/dana-wa.mjs (index.mjs builds it with `{ cfg, now }`), so tests
 * pin every number with a fake clock, a scripted random and a fake sleep.
 *
 *   batchMs()          a random 4-7 s batch window (it replaces dana-wa's fixed BATCH_MS);
 *   batchDelay({ firstAt, at })  that window restarted on each new message, never past 15 s after the
 *                      first wake of the batch;
 *   typingFloorMs({ chars, newestTs })  how long a send must still wait: no earlier than the newest client
 *                      message + clamp(2 s + 40 ms a character + U(0,3) s, 8 s, 25 s). Measured from the
 *                      CLIENT's message, so it has usually passed while the model answered;
 *   fifo(fn)           the one global queue for Dana's sends (`fn(release)`: a callback that sends nothing after all calls
 *                      release() and gives its slot back): a random 4-8 s gap between two sends, at most
 *                      8 a minute and FIFO_PER_HOUR an hour (40 on days 0-21, then 60). One send at a time,
 *                      in order; a send that throws never jams it. In memory: a restart starts it empty
 *                      (wa-send's day cap is read from the outbox, so a restart never hands out a fresh day);
 *   tier(ts)           the caps in force at `ts`, by days since BONA_WA_LINKED_AT (`cfg.waLinkedAt`, ms):
 *                      days 0-7, 8-21, 22+; unset → the strictest. A fresh copy each call.
 *
 * Nothing here sends, logs or reads a message. lib/wa-send.mjs reads the same tiers (TIERS, tierIndex) for
 * its SEND_PER_MIN and SEND_PER_DAY.
 */

export const BATCH_MIN_MS = 4000;
export const BATCH_MAX_MS = 7000;
/** A batch fires at most this long after its first wake (DESIGN §6.2). */
export const BATCH_CAP_MS = 15_000;
export const TYPING_MIN_MS = 8000;
export const TYPING_MAX_MS = 25_000;
export const FIFO_GAP_MIN_MS = 4000;
export const FIFO_GAP_MAX_MS = 8000;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The caps per warm-up tier (DESIGN §6.3). PER_DAY counts TURNS over every chat (store.countDanaTurns);
 * the per-chat caps count one chat's turns; DOCS_PER_DAY is the overall brochure cap (days 0-21 only:
 * null after); SEND_PER_MIN / SEND_PER_DAY are the sender's (lib/wa-send.mjs).
 */
export const TIERS = Object.freeze([
  Object.freeze({ PER_DAY: 60, PER_CHAT_PER_10MIN: 10, PER_CHAT_PER_HOUR: 20, PER_CHAT_PER_DAY: 40, MAX_LINKS: 2, DOCS_PER_CHAT_PER_DAY: 1, DOCS_PER_DAY: 15, FIFO_PER_MIN: 8, FIFO_PER_HOUR: 40, SEND_PER_MIN: 8, SEND_PER_DAY: 100 }),
  Object.freeze({ PER_DAY: 120, PER_CHAT_PER_10MIN: 10, PER_CHAT_PER_HOUR: 20, PER_CHAT_PER_DAY: 40, MAX_LINKS: 2, DOCS_PER_CHAT_PER_DAY: 1, DOCS_PER_DAY: 15, FIFO_PER_MIN: 8, FIFO_PER_HOUR: 40, SEND_PER_MIN: 8, SEND_PER_DAY: 180 }),
  Object.freeze({ PER_DAY: 200, PER_CHAT_PER_10MIN: 10, PER_CHAT_PER_HOUR: 20, PER_CHAT_PER_DAY: 40, MAX_LINKS: 2, DOCS_PER_CHAT_PER_DAY: 1, DOCS_PER_DAY: null, FIFO_PER_MIN: 8, FIFO_PER_HOUR: 60, SEND_PER_MIN: 8, SEND_PER_DAY: 300 }),
]);

/** 0, 1 or 2: days 0-7, 8-21, 22+ since `linkedAt` (ms). No anchor, or a time before it, is the strictest. */
export function tierIndex(ts, linkedAt) {
  if (!Number.isFinite(linkedAt) || !Number.isFinite(ts) || ts < linkedAt) return 0;
  const day = Math.floor((ts - linkedAt) / DAY_MS);
  return day <= 7 ? 0 : day <= 21 ? 1 : 2;
}

const realSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

/**
 * @param {{ cfg?: { waLinkedAt?: number|null }, now?: () => number, random?: () => number, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export function createPacing({ cfg = {}, now = () => Date.now(), random = Math.random, sleep = realSleep } = {}) {
  const linkedAt = Number.isFinite(cfg?.waLinkedAt) ? cfg.waLinkedAt : null;
  const rand = () => {
    const r = Number(random());
    return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.5;
  };
  const between = (lo, hi) => Math.floor(lo + rand() * (hi - lo));

  const tier = (ts = now()) => ({ ...TIERS[tierIndex(Number(ts), linkedAt)] });
  /** When the read receipt goes after the batch fires: 1-3 s (DESIGN §6.2). */
  const readDelayMs = () => between(1000, 3000);
  const batchMs = () => between(BATCH_MIN_MS, BATCH_MAX_MS);
  function batchDelay({ firstAt, at = now() } = {}) {
    const wait = batchMs();
    if (!Number.isFinite(firstAt)) return wait;
    return Math.max(0, Math.min(wait, firstAt + BATCH_CAP_MS - at));
  }
  function typingFloorMs({ chars = 0, newestTs = null } = {}) {
    if (!Number.isFinite(newestTs)) return 0;
    const n = Math.max(0, Number(chars) || 0);
    const floor = Math.min(TYPING_MAX_MS, Math.max(TYPING_MIN_MS, Math.floor(2000 + 40 * n + rand() * 3000)));
    return Math.max(0, newestTs + floor - now());
  }

  /* ---------------- the global send queue ---------------- */
  let tail = Promise.resolve();
  const sent = []; // start times of the sends of the last hour, oldest first
  let last = null; // the newest send's start and the gap the next one keeps
  async function slot() {
    for (;;) {
      const t = now();
      while (sent.length && t - sent[0] >= HOUR_MS) sent.shift();
      const caps = tier(t);
      let at = t;
      if (last !== null) at = Math.max(at, last.at + last.gap);
      const inMinute = sent.filter((s) => t - s < MINUTE_MS);
      if (inMinute.length >= caps.FIFO_PER_MIN) at = Math.max(at, inMinute[inMinute.length - caps.FIFO_PER_MIN] + MINUTE_MS);
      if (sent.length >= caps.FIFO_PER_HOUR) at = Math.max(at, sent[sent.length - caps.FIFO_PER_HOUR] + HOUR_MS);
      if (at <= t) return;
      await sleep(at - t);
    }
  }
  function fifo(fn) {
    const run = tail.then(async () => {
      await slot();
      const t = now();
      const before = last;
      last = { at: t, gap: between(FIFO_GAP_MIN_MS, FIFO_GAP_MAX_MS) };
      sent.push(t);
      // `release()`: the caller sent nothing after all (its send-time gate dropped it). The slot is given back
      // and no gap is kept after it, so dropped callbacks never push a real send into the next minute or hour.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const k = sent.lastIndexOf(t);
        if (k >= 0) sent.splice(k, 1);
        if (last?.at === t) last = before;
      };
      return fn(release);
    });
    // The next send waits for this one to settle, whatever it answered.
    tail = run.then(() => {}, () => {});
    return run;
  }

  return { batchMs, batchDelay, typingFloorMs, fifo, tier, readDelayMs };
}
