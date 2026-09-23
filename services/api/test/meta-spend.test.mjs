import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { importMetaSpend, normaliseInsight } from '../lib/meta-spend.mjs';

const FROM = '2026-09-01';
const TO = '2026-09-02';
const ACCOUNT = { currency: 'USD', timezone_name: 'Asia/Riyadh' };
const row = (over = {}) => ({
  date_start: FROM, date_stop: FROM, campaign_id: '1203', campaign_name: 'Villas',
  spend: '10.50', clicks: '4', impressions: '100', ...over,
});

function responder(steps) {
  const calls = [];
  return {
    calls,
    request: async (request) => {
      calls.push(request);
      const next = steps.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('normaliseInsight converts account currency to SAR without changing the account-local day', () => {
  assert.deepEqual(normaliseInsight(row(), ACCOUNT, { USD: 3.75 }, 123), {
    day: FROM, platform: 'meta', campaign_id: '1203', campaign_name: 'Villas',
    source_spend: 10.5, source_currency: 'USD', spend_sar: 39.38,
    clicks: 4, impressions: 100, imported_at: 123,
  });
  assert.equal(normaliseInsight(row({ date_start: '2026-09-02', date_stop: '2026-09-03' }), ACCOUNT, { USD: 3.75 }, 123), null, 'non-daily rows are refused');
  assert.equal(normaliseInsight(row({ spend: null }), ACCOUNT, { USD: 3.75 }, 123), null, 'missing spend is not fabricated as zero');
  assert.equal(normaliseInsight(row({ spend: '' }), ACCOUNT, { USD: 3.75 }, 123), null, 'empty spend is not fabricated as zero');
  assert.throws(() => normaliseInsight(row(), { ...ACCOUNT, currency: 'EUR' }, {}, 123), /exchange rate/i);
});

test('the importer paginates, retries bounded transient errors, and never puts the token in a URL', async () => {
  const db = openDb(':memory:');
  const mock = responder([
    { status: 200, json: ACCOUNT },
    { status: 500, json: { error: { message: 'temporary' } } },
    { status: 200, json: { data: [row()], paging: { next: 'https://graph.facebook.com/v23.0/next?after=abc&access_token=SHOULD_NOT_SURVIVE' } } },
    { status: 200, json: { data: [row({ date_start: TO, date_stop: TO, spend: '5' })] } },
  ]);
  const report = await importMetaSpend({
    db, accountId: 'act_123', accessToken: 'secret-token', from: FROM, to: TO,
    dryRun: false, fxRates: { USD: 3.75 }, request: mock.request, sleep: async () => {}, now: () => 999,
  });
  assert.equal(report.ok, true);
  assert.equal(report.pages, 2);
  assert.equal(report.retries, 1);
  assert.equal(report.rows_valid, 2);
  assert.equal(report.rows_written, 2);
  assert.equal(mock.calls.every((c) => !c.url.includes('secret-token') && !c.url.includes('SHOULD_NOT_SURVIVE')), true);
  assert.equal(mock.calls.every((c) => c.headers.Authorization === 'Bearer secret-token'), true);
  assert.deepEqual(db.listSpend().map((r) => [r.day, r.spend_sar]), [[FROM, 39.38], [TO, 18.75]]);
  db.close();
});

test('dry-run performs no writes and an idempotent apply replaces the same natural key', async () => {
  const db = openDb(':memory:');
  const run = async (spend, dryRun) => {
    const mock = responder([
      { status: 200, json: { currency: 'SAR', timezone_name: 'Asia/Riyadh' } },
      { status: 200, json: { data: [row({ spend: String(spend) })] } },
    ]);
    return importMetaSpend({ db, accountId: 'act_123', accessToken: 'token', from: FROM, to: FROM, dryRun, request: mock.request, now: () => 500 });
  };
  const dry = await run(10, true);
  assert.equal(dry.rows_written, 0);
  assert.equal(db.listSpend().length, 0);
  await run(10, false);
  await run(12, false);
  assert.equal(db.listSpend().length, 1);
  assert.equal(db.listSpend()[0].spend_sar, 12);
  db.close();
});

test('request failures are redacted before the report can be printed', async () => {
  const db = openDb(':memory:');
  const token = 'top-secret-marketing-token';
  const mock = responder([
    { status: 200, json: { currency: 'SAR', timezone_name: 'Asia/Riyadh' } },
    new Error(`request failed with Authorization: Bearer ${token}`),
  ]);
  const report = await importMetaSpend({
    db, accountId: 'act_123', accessToken: token, from: FROM, to: FROM,
    dryRun: true, request: mock.request, retries: 0,
  });
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes(token), false);
  assert.match(report.errors[0].message, /\*\*\*/);
  db.close();
});

test('a later page failure reports partial success and does not erase rows already stored', async () => {
  const db = openDb(':memory:');
  db.upsertSpend({ day: '2026-08-31', platform: 'meta', campaign_id: 'old', spend_sar: 7 });
  const mock = responder([
    { status: 200, json: { currency: 'SAR', timezone_name: 'Asia/Riyadh' } },
    { status: 200, json: { data: [row()], paging: { next: 'https://graph.facebook.com/v23.0/next?after=abc' } } },
    { status: 400, json: { error: { message: 'bad page' } } },
  ]);
  const report = await importMetaSpend({
    db, accountId: 'act_123', accessToken: 'token', from: FROM, to: TO, dryRun: false,
    request: mock.request, retries: 0, now: () => 700,
  });
  assert.equal(report.ok, false);
  assert.equal(report.partial, true);
  assert.equal(report.rows_written, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(db.listSpend().some((r) => r.campaign_id === 'old'), true);
  db.close();
});
