/**
 * Messages from the owner's WhatsApp to anyone other than the owner (2026-09-27 design §4.5).
 *
 * Phase 1 sends only login codes to team members; Phase 2 adds client replies (with an
 * outbox and idempotency) and Phase 4 Dana. They all pass the same gate, because they all
 * spend the same thing — the standing of one personal number on WhatsApp:
 *
 *   - a 1:1 phone jid only (`…@s.whatsapp.net`, digits not starting with the local trunk
 *     `0`). A group, a broadcast, an `…@lid`, or a local-format number that never got
 *     turned into an international one, is refused: `lid` digits are an opaque id, not a
 *     phone number (see wa-poller.mjs).
 *   - a real `kind` ('code' is the only one Phase 1 ever sends) and a `text` that is a
 *     non-empty string of at most 4096 characters.
 *   - the owner's Sending switch (`settings.sending_enabled`). It is bypassed only when
 *     the recipient IS the owner's own jid (`cfg.ownerJid`) AND the message is a login
 *     `code` — `bypassSwitch` is a hint from the caller, never trusted on its own, because
 *     a caller that could bypass the switch for anyone else could use it to spam past the
 *     owner's own kill switch. Without this the owner could never get back in to switch
 *     sending back on.
 *   - 20 a minute and 500 a day across every sender, 6 a minute to any one recipient, all
 *     asked before any is charged (see lib/ratelimit.mjs `peek`). Messages to the owner's
 *     own jid skip the shared per-minute/per-day budget (still capped per-recipient), so a
 *     busy day of team-member codes cannot lock the owner out of logging in.
 *   - `BONA_WA_NOTIFY=0` (`cfg.enabled`) only stops the lead note this env var was built
 *     for (see services/README.md); a login `code` only needs Evolution to be configured
 *     (`baseUrl`/`apiKey`) — otherwise the owner could be locked out by an env var that was
 *     never about dashboard logins.
 *
 * A send is confirmed only when the response is 2xx AND its body carries a `key.id`
 * string — the WhatsApp message id. Anything else (a non-2xx status, a 2xx with no id, a
 * timeout reading the body, or any other thrown error) is a failure we come back with
 * honestly: `uncertain: true` whenever the message might still have gone out, so nothing
 * here silently double-sends a login code by retrying. Only a handful of pre-connection
 * errors (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`) are treated as definitely-not-sent.
 * Nothing here retries — that decision belongs to the caller.
 *
 * The owner's new-lead note to his own chat stays in lib/wa.mjs: that one is a message to
 * himself.
 */
import { createLimiter } from './ratelimit.mjs';
import { waConfig } from './wa.mjs';

export const SEND_PER_MIN = 20;
export const SEND_PER_DAY = 500;
export const PER_RECIPIENT_PER_MIN = 6;
export const MAX_TEXT_LEN = 4096;
/** The only kinds Phase 1 ever sends. Extend this, not the gate, when Phase 2/4 add more. */
const VALID_KINDS = new Set(['code']);
const PHONE_JID_RE = /^(\d{8,15})@s\.whatsapp\.net$/;
/** Failures we can be sure never reached the other side — no ambiguity, so not "uncertain". */
const DEFINITE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Strip a jid's device suffix (`966…:12@s.whatsapp.net` → `966…@s.whatsapp.net`) before comparing. */
const bareDigits = (jid) => String(jid ?? '').replace(/@.*$/, '').replace(/:.*$/, '');

/**
 * @param {{ env?: object, team: ReturnType<import('./team.mjs').createTeam>,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: Function, timeoutMs?: number }} o
 */
export function createSender({ env = {}, team, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 8000 } = {}) {
  if (!team) throw new TypeError('createSender needs the team store (for the sending switch)');
  const cfg = waConfig(env);
  const ownerDigits = bareDigits(cfg.ownerJid);
  const perMinute = createLimiter({ capacity: SEND_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: SEND_PER_DAY, perMs: 86_400_000, now });
  const perRecipient = createLimiter({ capacity: PER_RECIPIENT_PER_MIN, perMs: 60_000, now });

  /**
   * @param {{ jid: string, text: string, kind: 'code', bypassSwitch?: boolean }} o
   * @returns {Promise<{ ok: true, keyId: string, status: number } | { ok: false, error: string, uncertain?: true }>}
   */
  async function sendTo({ jid, text, kind, bypassSwitch = false } = {}) {
    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m || m[1].startsWith('0')) return { ok: false, error: 'bad_recipient' };
    if (!VALID_KINDS.has(kind)) return { ok: false, error: 'bad_kind' };
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_LEN) return { ok: false, error: 'bad_text' };

    const isOwner = m[1] === ownerDigits;
    // A caller's `bypassSwitch` is only ever honoured for the owner's own login code —
    // never trusted for anyone else, or it would be a way to spam past the kill switch.
    const bypassAllowed = bypassSwitch && kind === 'code' && isOwner;
    if (!bypassAllowed && !team.sendingEnabled()) return { ok: false, error: 'sending_disabled' };
    // BONA_WA_NOTIFY only ever promised to stop the lead note (services/README.md); a
    // login code does not need it, or the owner could be locked out by an unrelated switch.
    if (kind !== 'code' && !cfg.enabled) return { ok: false, error: 'disabled' };
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'evolution-not-configured' };

    const gates = isOwner
      ? [[perRecipient, `send:to:${m[1]}`]]
      : [[perMinute, 'send:minute'], [perDay, 'send:day'], [perRecipient, `send:to:${m[1]}`]];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'wa.send.rate_limited', kind });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
          body: JSON.stringify({ number: m[1], text }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          log({ level: 'warn', evt: 'wa.send.uncertain', kind, error: 'timeout' });
          return { ok: false, error: 'timeout', uncertain: true };
        }
        const definite = DEFINITE_NETWORK_CODES.has(err?.cause?.code);
        log({ level: 'warn', evt: definite ? 'wa.send.failed' : 'wa.send.uncertain', kind, error: 'network' });
        return definite ? { ok: false, error: 'network' } : { ok: false, error: 'network', uncertain: true };
      }

      if (!res.ok) {
        const uncertain = res.status === 502 || res.status === 504;
        log({ level: 'warn', evt: 'wa.send.failed', kind, status: res.status, uncertain: uncertain || undefined });
        return uncertain ? { ok: false, error: `http_${res.status}`, uncertain: true } : { ok: false, error: `http_${res.status}` };
      }

      let text2xx;
      try {
        text2xx = await res.text();
      } catch {
        // The send may well have gone through — we just could not read the ack.
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return { ok: false, error: 'no_ack', uncertain: true };
      }
      let keyId = null;
      try {
        const body = JSON.parse(text2xx);
        keyId = typeof body?.key?.id === 'string' ? body.key.id : null;
      } catch { keyId = null; }
      if (typeof keyId !== 'string') {
        log({ level: 'warn', evt: 'wa.send.no_key', kind });
        return { ok: false, error: 'no_ack', uncertain: true };
      }
      log({ evt: 'wa.send.ok', kind });
      return { ok: true, keyId, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }

  return { sendTo };
}
