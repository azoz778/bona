/** TikTok Events API 2.0. No posting API and no automatic advanced matching.
 * Credentials use Bona's existing server-only environment loader.
 * Reference: https://business-api.tiktok.com/portal/docs/report-app-web-offline-or-crm-events/v1.3
 */
const EVENTS = { whatsapp_click: 'Contact', form_submit: 'SubmitForm', lead_created: 'SubmitForm' };
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));

export function buildTiktok(event, { session, lead, cfg }) {
  // Only website conversions with a browser session. CRM stages are deliberately unmapped.
  if (!session || !Object.hasOwn(EVENTS, event.name)) return null;
  if (event.name === 'lead_created' && lead?.channel !== 'form') return null;
  let page;
  try {
    const url = new URL(cfg.siteUrl);
    if (url.protocol !== 'https:') return null;
    // Drop query strings/fragments; never forward an arbitrary URL or lead form text.
    url.pathname = typeof event.path === 'string' && event.path.startsWith('/')
      ? event.path.split(/[?#]/)[0] : '/';
    url.search = ''; url.hash = '';
    page = url.href;
  } catch { return null; }
  return {
    url: 'https://business-api.tiktok.com/open_api/v1.3/event/track/',
    headers: { 'Access-Token': cfg.tiktokEventsToken },
    body: compact({
      event_source: 'web',
      event_source_id: cfg.tiktokPixelId,
      test_event_code: cfg.tiktokTestEventCode || undefined,
      data: [{
        event: EVENTS[event.name],
        event_time: Math.floor(event.ts / 1000),
        event_id: event.event_id,
        user: compact({
          ip: session.ip, user_agent: session.ua, ttp: session.ttp,
          ttclid: event.src_last?.click_ids?.ttclid ?? session.last_touch?.click_ids?.ttclid
            ?? event.src_first?.click_ids?.ttclid ?? session.first_touch?.click_ids?.ttclid,
        }),
        page: { url: page },
      }],
    }),
  };
}

/** HTTP success alone is not acceptance. Persist codes only: responses can echo secrets/PII. */
export function tiktokResponse(res) {
  let body;
  try { body = JSON.parse(res.text); } catch { /* malformed success is a failure */ }
  const code = Number.isInteger(body?.code) ? body.code : null;
  return {
    ...res,
    ok: res.ok && code === 0,
    text: JSON.stringify({ code, result: !res.ok ? 'http_error' : code === 0 ? 'accepted' : code === null ? 'invalid_response' : 'api_error' }),
  };
}
