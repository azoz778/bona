/** Acknowledged form capture. Only the private enquiry API sees the entered fields.
 * Keep retries in this tab under the same event id; never persist a personal draft. */
export function createEnquirySubmitter({ api, fetchImpl = globalThis.fetch, eventId, timeoutMs = 8000 }) {
  let attempt = null;
  let pending = null;
  return async function submit(fields, context = {}) {
    const fingerprint = JSON.stringify(fields);
    if (pending) return { ok: false, reason: 'busy' };
    if (!attempt || attempt.fingerprint !== fingerprint) {
      attempt = { fingerprint, id: eventId(), accepted: null };
    }
    if (attempt.accepted) return { ...attempt.accepted, duplicate: true };
    const current = attempt;
    if (!api) return { ok: false, reason: 'unavailable', eventId: current.id };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    pending = current;
    try {
      const res = await fetchImpl(api.replace(/\/+$/, '') + '/v1/enquiry', {
        method: 'POST', keepalive: true, credentials: 'omit', signal: controller.signal,
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ ...fields, ...context, event_id: current.id }),
      });
      if (!res.ok) return { ok: false, reason: res.status === 429 ? 'rate_limited' : 'unconfirmed', eventId: current.id };
      const body = await res.json();
      if (typeof body?.lead_id !== 'string' || !/^LEAD-\d{8}-[a-f0-9]{8}$/.test(body.lead_id)) {
        return { ok: false, reason: 'unconfirmed', eventId: current.id };
      }
      current.accepted = { ok: true, leadId: body.lead_id, eventId: current.id };
      return current.accepted;
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unconfirmed', eventId: current.id };
    } finally { clearTimeout(timer); pending = null; }
  };
}
