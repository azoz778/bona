/**
 * Messages from the owner's WhatsApp to anyone other than the owner (2026-09-27 design §4.5).
 *
 * Phase 1 sends only login codes to team members; Phase 2 adds client replies (with an
 * outbox and idempotency) and Phase 4 Dana. They all pass the same gate, because they all
 * spend the same thing — the standing of one personal number on WhatsApp:
 *
 *   - a 1:1 phone jid only (`…@s.whatsapp.net`). A group, a broadcast or an `…@lid` is
 *     refused: `lid` digits are an opaque id, not a phone number (see wa-poller.mjs).
 *   - the owner's Sending switch (`settings.sending_enabled`). Only a caller that says
 *     `bypassSwitch` passes it while it is off — the owner's own login code, or he could
 *     never get back in to switch it on.
 *   - 20 a minute and 500 a day across every sender, 6 a minute to any one recipient,
 *     all asked before any is charged (see lib/ratelimit.mjs `peek`).
 *
 * A timeout does not mean the message was not delivered, so it comes back `uncertain`
 * and nothing here retries it. The owner's new-lead note to his own chat stays in
 * lib/wa.mjs: that one is a message to himself.
 */
import { createLimiter } from './ratelimit.mjs';
import { waConfig } from './wa.mjs';

export const SEND_PER_MIN = 20;
export const SEND_PER_DAY = 500;
export const PER_RECIPIENT_PER_MIN = 6;
const PHONE_JID_RE = /^(\d{8,15})@s\.whatsapp\.net$/;

/**
 * @param {{ env?: object, team: ReturnType<import('./team.mjs').createTeam>,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: Function, timeoutMs?: number }} o
 */
export function createSender({ env = {}, team, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, timeoutMs = 8000 } = {}) {
  if (!team) throw new TypeError('createSender needs the team store (for the sending switch)');
  const cfg = waConfig(env);
  const perMinute = createLimiter({ capacity: SEND_PER_MIN, perMs: 60_000, now });
  const perDay = createLimiter({ capacity: SEND_PER_DAY, perMs: 86_400_000, now });
  const perRecipient = createLimiter({ capacity: PER_RECIPIENT_PER_MIN, perMs: 60_000, now });

  /**
   * @param {{ jid: string, text: string, kind: 'code', bypassSwitch?: boolean }} o
   * @returns {Promise<{ ok: true, keyId: string|null, status: number } | { ok: false, error: string, uncertain?: true }>}
   */
  async function sendTo({ jid, text, kind, bypassSwitch = false } = {}) {
    const m = PHONE_JID_RE.exec(String(jid ?? ''));
    if (!m) return { ok: false, error: 'bad_recipient' };
    if (!bypassSwitch && !team.sendingEnabled()) return { ok: false, error: 'sending_disabled' };
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'evolution-not-configured' };

    const gates = [[perMinute, 'send:minute'], [perDay, 'send:day'], [perRecipient, `send:to:${m[1]}`]];
    if (gates.some(([limiter, key]) => !limiter.peek(key).ok)) {
      log({ level: 'warn', evt: 'wa.send.rate_limited', kind });
      return { ok: false, error: 'rate_limited' };
    }
    for (const [limiter, key] of gates) limiter.take(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify({ number: m[1], text: String(text ?? '') }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log({ level: 'warn', evt: 'wa.send.failed', kind, status: res.status });
        return { ok: false, error: `http_${res.status}` };
      }
      let keyId = null;
      try {
        const body = JSON.parse(await res.text());
        keyId = typeof body?.key?.id === 'string' ? body.key.id : null;
      } catch { keyId = null; }
      log({ evt: 'wa.send.ok', kind });
      return { ok: true, keyId, status: res.status };
    } catch (err) {
      if (err?.name === 'AbortError') {
        log({ level: 'warn', evt: 'wa.send.uncertain', kind });
        return { ok: false, error: 'timeout', uncertain: true };
      }
      log({ level: 'warn', evt: 'wa.send.failed', kind, error: 'network' });
      return { ok: false, error: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { sendTo };
}
