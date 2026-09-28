import { esc, layout, dateTime } from './render.mjs';
export const ACCOUNT_MESSAGES = {
  not_configured: 'App approval, server credentials and the portal authorization URL are still required.',
  invalid_state: 'This authorization attempt expired or belongs to a different browser session. Start again here.',
  invalid_code: 'TikTok did not return one unambiguous authorization code. Start again.',
  denied: 'Authorization was declined. No new grant was saved.',
  provider_failed: 'TikTok could not complete this request. The existing grant was preserved. Start a new authorization if needed.',
  invalid_response: 'TikTok returned an incomplete grant. No new grant was saved.',
  different_account: 'This grant belongs to a different account. Revoke the existing connection before changing accounts.',
  different_app: 'The stored grant belongs to a different app configuration. Restore its configuration before revoking or renewing.',
  storage_unavailable: 'Secure grant storage is unavailable. Ask the operator to check its permissions.',
  busy: 'Another connection request is running. Try again shortly.',
  no_grant: 'No account grant has been stored.', reauthorize: 'The refresh grant expired. Authorize the account again.',
};
const button = (action, label, disabled = false) => `<form method="post" action="/v1/admin/tiktok/${action}"><input type="hidden" name="_dash" value="1"><button type="submit"${disabled ? ' disabled' : ''}>${label}</button></form>`;
export function validateTiktokDraft(fields, siteUrl, now = Date.now()) {
  const caption = typeof fields.caption === 'string' ? fields.caption.trim() : '';
  const media = typeof fields.media === 'string' ? fields.media.trim() : '';
  const schedule = typeof fields.schedule === 'string' ? fields.schedule.trim() : '';
  const issues = [];
  if (!caption || caption.length > 2200) issues.push('Write a caption of 1–2,200 characters.');
  try { const u = new URL(media); if (u.protocol !== 'https:' || u.origin !== new URL(siteUrl).origin || u.username || u.password || u.hash) throw new Error(); }
  catch { issues.push('Use an HTTPS media URL on the Bona website. URL ownership and media eligibility still need provider verification.'); }
  // Explicit timezone avoids silently interpreting an operator's schedule as UTC.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(schedule) || !Number.isFinite(Date.parse(schedule)) || Date.parse(schedule) <= now) issues.push('Use a future ISO date/time with timezone, such as your intended Riyadh time with +03:00.');
  return { caption: caption.slice(0, 2200), media: media.slice(0, 2048), schedule: schedule.slice(0, 80), issues };
}
export function tiktokAccountsPage({ me, state, error, ok, draft = null }) {
  const message = ACCOUNT_MESSAGES[error];
  const success = { forgotten: 'Local grant removed. This did not revoke access at TikTok. Revoke the app in your TikTok account settings.', connected: 'Authorization grant saved securely. Verify the account and scopes before implementing publishing.', refreshed: 'Grant renewed and expiry updated.', revoked: 'TikTok confirmed revocation; the local grant was removed.' }[ok];
  const grant = state.grantStored ? `<p><b>Grant stored</b> · ${state.expired ? 'Access token expired' : 'Access token within its reported lifetime'}</p><p>Account identifier: <code>${esc(state.openId)}</code></p><p>Granted scopes: ${esc(state.scopes.join(', '))}</p><p>Access expiry: ${esc(dateTime(state.expiresAt))}<br>Refresh expiry: ${esc(dateTime(state.refreshExpiresAt))}</p><p>Account identity, media approval and publishing are not yet verified.</p>` : '<p>No TikTok account authorization grant is stored.</p>';
  const preview = draft ? `<section class="card"><h2>Draft preflight</h2><p>${draft.issues.length ? 'Needs changes' : 'Local fields valid'} — preview only; not saved, scheduled or published.</p>${draft.issues.map(s => `<p class="err">${esc(s)}</p>`).join('')}<p>${esc(draft.caption)}</p><p>Media: ${esc(draft.media)}</p><p>Requested time: ${esc(draft.schedule)}</p><p>Still required: authorized account, verified media ownership/format, TikTok-specific content approval and a working publisher.</p><button disabled>Publish unavailable</button></section>` : '';
  return layout({ title: 'TikTok account setup', active: '/dashboard/integrations', me, body: `
<p class="sub">Bona’s own-account authorization and publishing preflight. This is an integration prototype; it does not post or schedule content. Website Events API measurement is a separate connection.</p>
${message ? `<div class="err">${esc(message)}</div>` : ''}${success ? `<div class="ok">${esc(success)}</div>` : ''}
<section class="card"><h2>1. App and account authorization</h2><p>${state.configured ? 'Server app configuration is ready for owner authorization.' : 'Waiting for TikTok app approval, server credentials and the portal-generated account authorization URL.'}</p><p>Account-holder redirect URL: <code>${esc(state.callbackUrl || 'Canonical HTTPS API address is not configured')}</code></p><p>Start here in this signed-in owner browser. A direct portal authorization link without a fresh session-bound state is rejected.</p>${state.storageError ? '<p class="err">Secure storage needs operator attention.</p>' : ''}${grant}
<div class="grid">${button('connect', state.grantStored ? 'Authorize again' : 'Connect owned TikTok account', !state.configured || state.busy || state.storageError)}${button('refresh', 'Renew grant', !state.configured || !state.grantStored || state.refreshExpired || !state.sameApp || state.busy)}${button('revoke', 'Revoke connection', !state.configured || !state.grantStored || !state.sameApp || state.busy)}</div>
<details><summary>Recovery: remove local grant only</summary><p>If revocation fails or credentials are unavailable, you can remove the server's local grant. This does not revoke TikTok access. You must also revoke the app in your TikTok account settings.</p><form method="post" action="/v1/admin/tiktok/forget"><input type="hidden" name="_dash" value="1"><label><input type="checkbox" name="confirm" value="remove-local-grant" required>I understand that TikTok access is not revoked.</label><button type="submit"${state.busy ? ' disabled' : ''}>Remove local grant only</button></form></details>
<p>No credentials are displayed. Tokens remain on the server. Renewal is owner-triggered here; no unattended publisher or renewal job is enabled.</p></section>
<section class="card"><h2>2. Prepare approved original content</h2><p>Use Bona’s existing content-review process. Instagram/Facebook approval does not automatically approve a TikTok post. Validate a draft below without sending it to TikTok.</p><form method="post" action="/v1/admin/tiktok/preview" class="stack"><input type="hidden" name="_dash" value="1"><label>Caption<textarea name="caption" maxlength="2200" required>${esc(draft?.caption || '')}</textarea></label><label>Approved Bona media URL<input name="media" type="url" maxlength="2048" required value="${esc(draft?.media || '')}"></label><label>Requested publish time (ISO format with timezone)<input name="schedule" maxlength="80" required value="${esc(draft?.schedule || '')}"></label><button type="submit">Validate draft</button></form></section>${preview}
<section class="card"><h2>3. Publishing readiness</h2><p>Publishing is disabled. App review, account identity/scope verification, approved media and a tested publisher are outstanding. No TikTok post or scheduled job is created by this page.</p><p><a href="/dashboard/integrations">Back to integrations</a></p></section>` });
}

export function tiktokContinuePage({ me, authorizationUrl }) {
  return layout({ title: 'Continue to TikTok', active: '/dashboard/integrations', me,
    body: `<h1>Authorize Bona’s owned account</h1><p>The authorization attempt expires in 10 minutes and is bound to this owner browser session. TikTok will show the permissions before you decide.</p><p><a href="${esc(authorizationUrl)}" rel="noreferrer">Continue to TikTok</a></p><p><a href="/dashboard/tiktok">Cancel and return to setup</a></p>` });
}
