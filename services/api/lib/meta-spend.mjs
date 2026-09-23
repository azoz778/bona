/** Read-only Meta Marketing API reporting import. No campaign mutations exist here. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const GRAPH_ORIGIN = 'https://graph.facebook.com';
const round2 = (n) => Math.round(n * 100) / 100;
const redact = (message, token) => {
  const str = String(message ?? '');
  return token ? str.split(token).join('***') : str;
};

export function validDay(value) {
  const day = String(value ?? '');
  if (!DAY_RE.test(day)) return false;
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

export function normaliseInsight(row, account, fxRates = {}, importedAt = Date.now()) {
  if (!row || !validDay(row.date_start) || row.date_start !== row.date_stop) return null;
  const campaignId = String(row.campaign_id ?? '').trim();
  if (!campaignId || campaignId.length > 64) return null;
  const currency = String(account?.currency ?? '').trim().toUpperCase();
  const rate = currency === 'SAR' ? 1 : Number(fxRates[currency]);
  if (!(rate > 0)) throw new Error(`SAR exchange rate required for ${currency || 'unknown currency'}`);
  const sourceSpend = Number(row.spend);
  if (row.spend === null || row.spend === undefined || row.spend === '') return null;
  if (!Number.isFinite(sourceSpend) || sourceSpend < 0) return null;
  const integer = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
  };
  return {
    day: row.date_start,
    platform: 'meta',
    campaign_id: campaignId,
    campaign_name: row.campaign_name == null ? null : String(row.campaign_name).slice(0, 200),
    source_spend: sourceSpend,
    source_currency: currency,
    spend_sar: round2(sourceSpend * rate),
    clicks: integer(row.clicks),
    impressions: integer(row.impressions),
    imported_at: importedAt,
  };
}

async function defaultRequest({ url, headers }) {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
  let json = null;
  try { json = await response.json(); } catch { /* response shape is reported, never echoed */ }
  return { status: response.status, json };
}

function safeNext(value) {
  if (!value) return null;
  const url = new URL(String(value));
  if (url.origin !== GRAPH_ORIGIN) throw new Error('Meta pagination returned an unexpected origin');
  url.searchParams.delete('access_token');
  return url.toString();
}

async function getJson(request, url, headers, retries, sleep, report) {
  let attempt = 0;
  while (true) {
    try {
      const response = await request({ url, headers });
      if (response?.status >= 200 && response.status < 300) return response.json ?? {};
      const transient = response?.status === 429 || response?.status >= 500;
      if (!transient || attempt >= retries) throw Object.assign(new Error(`Meta API HTTP ${response?.status ?? 'unknown'}`), { permanent: !transient });
    } catch (error) {
      if (error?.permanent || attempt >= retries) throw error;
    }
    attempt += 1;
    report.retries += 1;
    await sleep(Math.min(4000, 250 * (2 ** (attempt - 1))));
  }
}

export async function importMetaSpend({
  db, accountId, accessToken, from, to, dryRun = true, fxRates = {},
  request = defaultRequest, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), retries = 2,
  now = () => Date.now(), apiVersion = 'v23.0',
} = {}) {
  if (!db || !accountId || !accessToken) throw new TypeError('db, accountId and accessToken are required');
  if (!validDay(from) || !validDay(to) || from > to) throw new RangeError('valid --from and --to dates are required');
  const report = { ok: true, dry_run: Boolean(dryRun), from, to, pages: 0, retries: 0, rows_seen: 0, rows_valid: 0, rows_written: 0, errors: [], partial: false };
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const base = `${GRAPH_ORIGIN}/${encodeURIComponent(apiVersion)}`;
  const account = await getJson(request, `${base}/${encodeURIComponent(accountId)}?fields=currency,timezone_name`, headers, retries, sleep, report);
  report.account = { currency: account.currency ?? null, timezone: account.timezone_name ?? null };
  const params = new URLSearchParams({
    fields: 'campaign_id,campaign_name,spend,clicks,impressions,date_start,date_stop',
    level: 'campaign', time_increment: '1', limit: '500',
    time_range: JSON.stringify({ since: from, until: to }),
  });
  let url = `${base}/${encodeURIComponent(accountId)}/insights?${params}`;
  while (url) {
    let payload;
    try {
      payload = await getJson(request, url, headers, retries, sleep, report);
    } catch (error) {
      report.ok = false;
      report.partial = report.rows_valid > 0;
      report.errors.push({ page: report.pages + 1, code: 'meta_api_error', message: redact(String(error?.message ?? error).slice(0, 200), accessToken) });
      break;
    }
    report.pages += 1;
    for (const raw of Array.isArray(payload.data) ? payload.data : []) {
      report.rows_seen += 1;
      try {
        const insight = normaliseInsight(raw, account, fxRates, now());
        if (!insight) continue;
        report.rows_valid += 1;
        if (!dryRun) {
          db.upsertSpend(insight);
          report.rows_written += 1;
        }
      } catch (error) {
        report.ok = false;
        report.errors.push({ page: report.pages, code: 'invalid_insight', message: redact(String(error?.message ?? error).slice(0, 200), accessToken) });
      }
    }
    try { url = safeNext(payload.paging?.next); }
    catch (error) {
      report.ok = false;
      report.partial = report.rows_valid > 0;
      report.errors.push({ page: report.pages, code: 'unsafe_pagination', message: redact(error.message, accessToken) });
      break;
    }
  }
  return report;
}
