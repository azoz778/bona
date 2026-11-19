/**
 * WhatsApp note to the owner via the self-hosted Evolution API.
 *
 * Two numbers, kept apart since 2026-11-19 (design 2026-11-16 §11):
 *   - the OWNER (`BONA_OWNER_JID`): where lead notes and his login codes go, the owner account
 *     seeded on every start, the one login code that may pass the Sending switch;
 *   - the INSTANCE (`BONA_WA_INSTANCE`, its own number `BONA_WA_INSTANCE_JID`): what every read
 *     and send goes through. Bona's own WhatsApp Business since the move; before it, the
 *     owner's personal WhatsApp, when the two numbers were one.
 * `BONA_WA_INSTANCE_JID` unset or blank means "the owner's number", exactly as before the
 * split: removing the line is the rollback. We only ever send text here; we never set a
 * webhook, a websocket or a rabbitmq consumer on the instance.
 *
 * Failure is non-fatal: a lead is already on disk before this is attempted.
 */

export const DEFAULT_OWNER_JID = '966593296933@s.whatsapp.net';

export function waConfig(env = {}) {
  const ownerJid = env.BONA_OWNER_JID ?? DEFAULT_OWNER_JID;
  const ownJid = String(env.BONA_WA_INSTANCE_JID ?? '').trim();
  return {
    baseUrl: String(env.EVOLUTION_API_URL ?? '').replace(/\/+$/, ''),
    apiKey: env.EVOLUTION_API_KEY ?? '',
    instance: env.BONA_WA_INSTANCE ?? 'abdulaziz-personal',
    ownerJid,
    /** The instance's own number: the chat the poller never reads, the sender a sent record's alt names. */
    instanceJid: ownJid || ownerJid,
    /** Where that number came from, for /health and the start-up line (never the digits). */
    ownNumberFrom: ownJid ? 'instance' : 'owner',
    groupJid: env.BONA_WA_GROUP_JID ?? null,
    enabled: String(env.BONA_WA_NOTIFY ?? '1') !== '0',
  };
}

/** Evolution accepts a bare number or a full jid; strip the jid suffix for 1:1 chats. */
export function toNumber(jid) {
  const s = String(jid ?? '').trim();
  if (!s) return '';
  return s.endsWith('@g.us') ? s : s.replace(/@.*$/, '');
}

/**
 * Send one text message to the OWNER's own chat — and nowhere else.
 *
 * Every caller sends either a lead note (a visitor's name, phone and details) or a
 * dashboard login code. This used to fall back to the Bona group when the owner chat
 * timed out, which would have posted that PII or a live OTP into a group other people can
 * read (Codex review, 2026-09-08). The group is reachable only when a caller says so
 * explicitly with `allowGroupFallback: true`; nothing in the API does today.
 * @returns {Promise<{ ok: boolean, to?: string, status?: number, error?: string, skipped?: boolean }>}
 */
export async function sendText(text, { env = {}, fetchImpl = globalThis.fetch, timeoutMs = 8000, allowGroupFallback = false } = {}) {
  const cfg = waConfig(env);
  if (!cfg.enabled) return { ok: false, skipped: true, error: 'disabled' };
  if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, skipped: true, error: 'evolution-not-configured' };

  const targets = [cfg.ownerJid, allowGroupFallback ? cfg.groupJid : null].filter(Boolean);
  let lastError = 'no-target';
  for (const target of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${cfg.baseUrl}/message/sendText/${encodeURIComponent(cfg.instance)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: cfg.apiKey },
        body: JSON.stringify({ number: toNumber(target), text }),
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, to: target, status: res.status };
      lastError = `http_${res.status}`;
    } catch (err) {
      lastError = err?.name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}
