import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, redacted, siteDefaults, SITE_FILE } from '../lib/config.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';

/** A throwaway site.json with whatever shape the test needs. */
function siteFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-site-'));
  const file = path.join(dir, 'site.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('both domains are read out of src/data/site.json, not written down a second time', () => {
  const { file, cleanup } = siteFile({ url: 'https://example.test/', concierge: { apiBase: 'https://api.example.test/' } });
  assert.deepEqual(siteDefaults(file), { siteUrl: 'https://example.test', publicApi: 'https://api.example.test' });
  cleanup();
});

test('the repo\'s own site.json is readable and carries both — this is the live default', () => {
  const live = siteDefaults();
  assert.equal(live.siteUrl, JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')).url.replace(/\/+$/, ''));
  assert.match(live.siteUrl, /^https:\/\//);
  assert.match(live.publicApi, /^https:\/\//);
});

test('anything that is not an http(s) URL is not a domain, and falls through', () => {
  for (const bad of [{}, { url: 42 }, { url: 'bona-real-estate.com' }, { url: 'javascript:alert(1)' }, 'not json at all']) {
    const { file, cleanup } = siteFile(bad);
    assert.deepEqual(siteDefaults(file), { siteUrl: null, publicApi: null }, JSON.stringify(bad));
    cleanup();
  }
  assert.deepEqual(siteDefaults('/nonexistent/site.json'), { siteUrl: null, publicApi: null });
});

test('the environment still wins over site.json, and a literal is only the last resort', () => {
  const env = { BONA_SITE: 'https://staging.example.test/', BONA_PUBLIC_API: 'https://api.staging.example.test' };
  const cfg = loadConfig({ env, ids: {} });
  assert.equal(cfg.siteUrl, 'https://staging.example.test');
  assert.equal(cfg.publicApi, 'https://api.staging.example.test');
});

test('the site\'s own origin is always allowed, whatever the allowlist says', () => {
  // Browser routes are origin-checked fail-closed, so a domain move that outran
  // BONA_CORS_ORIGINS would 403 every event, every enquiry and the whole concierge.
  const cfg = loadConfig({ env: { BONA_SITE: 'https://brand-new.test', BONA_CORS_ORIGINS: 'https://somewhere.else' }, ids: {} });
  assert.deepEqual(cfg.origins, ['https://somewhere.else', 'https://brand-new.test']);

  const dflt = loadConfig({ env: {}, ids: {} });
  for (const o of DEFAULT_ORIGINS) assert.ok(dflt.origins.includes(o), o);
  assert.ok(dflt.origins.includes(siteDefaults().siteUrl));
  assert.equal(new Set(dflt.origins).size, dflt.origins.length, 'no duplicate origins');
});

test('the WhatsApp poller reads every 20 s by default, and the environment still wins', () => {
  // The inbox (2026-09-27 design §4.3, P2-11): a staff member waits at most one interval
  // to see a client's message. The VPS env file pins its own value, which still wins.
  assert.equal(loadConfig({ env: {}, ids: {} }).waPollMs, 20_000);
  assert.equal(loadConfig({ env: { BONA_WA_POLL_MS: '45000' }, ids: {} }).waPollMs, 45_000);
});

test('VAPID keys come from the env; the subject defaults to the site; redacted() says only whether keys exist', () => {
  const cfg = loadConfig({ env: { BONA_VAPID_PUBLIC: ' PUB ', BONA_VAPID_PRIVATE: 'PRIV' }, ids: {} });
  assert.equal(cfg.vapidPublic, 'PUB');
  assert.equal(cfg.vapidPrivate, 'PRIV');
  assert.equal(cfg.vapidSubject, cfg.siteUrl);
  assert.equal(loadConfig({ env: { BONA_VAPID_SUBJECT: 'mailto:ops@example.com' }, ids: {} }).vapidSubject, 'mailto:ops@example.com');
  const r = redacted(cfg);
  assert.equal(r.hasVapid, true);
  assert.doesNotMatch(JSON.stringify(r), /PUB|PRIV/);
  assert.equal(redacted(loadConfig({ env: {}, ids: {} })).hasVapid, false);
  assert.doesNotMatch(JSON.stringify(redacted(loadConfig({ env: { BONA_VAPID_PUBLIC: 'P', BONA_VAPID_PRIVATE: 'K', BONA_VAPID_SUBJECT: 'mailto:ops@example.com' }, ids: {} }))), /ops@example/);
  assert.equal(redacted(loadConfig({ env: { BONA_VAPID_PUBLIC: 'P' }, ids: {} })).hasVapid, false);
});

test('the WhatsApp chat agent id comes from the env, else ids.json, and never falls back to the site agent', () => {
  const base = { env: { BONA_RETELL_CHAT_AGENT_ID: 'agent_site_env' }, ids: { chatAgentId: 'agent_site', voiceAgentId: 'agent_voice' } };
  assert.equal(loadConfig(base).waChatAgentId, null, 'the web prompt must never answer WhatsApp');
  assert.equal(loadConfig({ ...base, ids: { ...base.ids, waChatAgentId: 'agent_wa' } }).waChatAgentId, 'agent_wa');
  assert.equal(loadConfig({ env: { BONA_RETELL_WA_CHAT_AGENT_ID: 'agent_env' }, ids: { waChatAgentId: 'agent_wa' } }).waChatAgentId, 'agent_env');
  const cfg = loadConfig({ env: { RETELL_API_KEY: 'secret' }, ids: { waChatAgentId: 'agent_wa' } });
  assert.equal(redacted(cfg).waChatAgentId, 'agent_wa');
  assert.doesNotMatch(JSON.stringify(redacted(cfg)), /secret/);
});

/* ---------------- the automation knobs (PLAN T04, DESIGN §5.2; brain/DESIGN-brain.md §2) ---------------- */

const cfgOf = (env) => loadConfig({ env, ids: {} });

test('BONA_WA_LINKED_AT parses an ISO instant with an offset; anything else is null (the strictest warm-up tier)', () => {
  assert.equal(cfgOf({ BONA_WA_LINKED_AT: '2026-11-26T05:25:00+03:00' }).waLinkedAt, Date.UTC(2026, 10, 26, 2, 25));
  assert.equal(cfgOf({ BONA_WA_LINKED_AT: '2026-11-26T02:25:00Z' }).waLinkedAt, Date.UTC(2026, 10, 26, 2, 25));
  assert.equal(cfgOf({ BONA_WA_LINKED_AT: '2026-11-26T05:25+03:00' }).waLinkedAt, Date.UTC(2026, 10, 26, 2, 25));
  assert.equal(cfgOf({ BONA_WA_LINKED_AT: '2026-11-26T05:25:00.250-01:30' }).waLinkedAt, Date.UTC(2026, 10, 26, 6, 55, 0, 250));
  assert.equal(cfgOf({ BONA_WA_LINKED_AT: ' 2026-11-26T05:25:00+03:00 ' }).waLinkedAt, Date.UTC(2026, 10, 26, 2, 25), 'surrounding blanks are trimmed');
  assert.equal(cfgOf({}).waLinkedAt, null, 'unset');
  for (const bad of [
    '', 'yes', '1795659900000', '2026-11-26', '2026-11-26T05:25:00', // no offset: local time would be a guess
    '2026-02-30T05:25:00+03:00', '2026-11-31T05:25:00+03:00', '2026-13-01T05:25:00+03:00', // no such day
    '2026-11-26T24:00:00+03:00', '2026-11-26T05:60:00+03:00', '2026-11-26T05:25:60+03:00',
    '2026-11-26T05:25:00+15:00', '2026-11-26T05:25:00+03:60', '2026-11-26 05:25:00+03:00', '2026-11-26T05:25:00+0300',
  ]) {
    assert.equal(cfgOf({ BONA_WA_LINKED_AT: bad }).waLinkedAt, null, JSON.stringify(bad));
  }
});

test('BONA_DANA_TURNS_MONTH_ALERT defaults to 1500 and takes only a positive whole number', () => {
  assert.equal(cfgOf({}).danaTurnsMonthAlert, 1500);
  assert.equal(cfgOf({ BONA_DANA_TURNS_MONTH_ALERT: '2000' }).danaTurnsMonthAlert, 2000);
  for (const bad of ['', 'lots', '0', '-5', '1.5', '1e3', '0x10', ' ']) {
    assert.equal(cfgOf({ BONA_DANA_TURNS_MONTH_ALERT: bad }).danaTurnsMonthAlert, 1500, JSON.stringify(bad));
  }
});

test('BONA_WA_PERSONAL_INSTANCES defaults to abdulaziz-personal, which stays in the list whatever the env names', () => {
  assert.deepEqual(cfgOf({}).waPersonalInstances, ['abdulaziz-personal']);
  assert.deepEqual(cfgOf({ BONA_WA_PERSONAL_INSTANCES: '' }).waPersonalInstances, ['abdulaziz-personal']);
  assert.deepEqual(cfgOf({ BONA_WA_PERSONAL_INSTANCES: 'abdulaziz-personal' }).waPersonalInstances, ['abdulaziz-personal']);
  assert.deepEqual(cfgOf({ BONA_WA_PERSONAL_INSTANCES: ' other-one , second_2 ' }).waPersonalInstances, ['abdulaziz-personal', 'other-one', 'second_2']);
  assert.deepEqual(cfgOf({ BONA_WA_PERSONAL_INSTANCES: 'ok,bad name,also/bad,,' }).waPersonalInstances, ['abdulaziz-personal', 'ok'], 'a name that is not an instance name is dropped');
});

test('the calendar and Kuma keys come from the env only; redacted() says only whether they are set', () => {
  const empty = cfgOf({});
  assert.equal(empty.gcalSaFile, '');
  assert.equal(empty.gcalCalendarId, '');
  assert.deepEqual(empty.gcalExtraBusyIds, []);
  assert.equal(empty.kumaWaLinkPush, '');
  const env = {
    BONA_GCAL_SA_FILE: ' /home/tester/.secrets/sa.json ',
    BONA_GCAL_CALENDAR_ID: 'owner-calendar@example.com',
    BONA_GCAL_EXTRA_BUSY_IDS: 'family@example.com, ,other@example.com',
    BONA_KUMA_WA_LINK_PUSH: 'https://kuma.example.com/api/push/SECRETPUSH',
  };
  const cfg = cfgOf(env);
  assert.equal(cfg.gcalSaFile, '/home/tester/.secrets/sa.json');
  assert.equal(cfg.gcalCalendarId, 'owner-calendar@example.com');
  assert.deepEqual(cfg.gcalExtraBusyIds, ['family@example.com', 'other@example.com']);
  assert.equal(cfg.kumaWaLinkPush, 'https://kuma.example.com/api/push/SECRETPUSH');
  const r = redacted(cfg);
  assert.equal(r.hasGcalSaFile, true);
  assert.equal(r.hasGcalCalendarId, true);
  assert.equal(r.gcalExtraBusyCount, 2);
  assert.equal(r.hasKumaWaLinkPush, true);
  const printed = JSON.stringify(r);
  for (const v of ['sa.json', 'owner-calendar', 'family@', 'other@', 'SECRETPUSH', 'kuma.example']) assert.doesNotMatch(printed, new RegExp(v), v);
  const off = redacted(empty);
  assert.equal(off.hasGcalSaFile, false);
  assert.equal(off.hasGcalCalendarId, false);
  assert.equal(off.gcalExtraBusyCount, 0);
  assert.equal(off.hasKumaWaLinkPush, false);
});

test('the brain knobs default to gpt-5.6-sol / gpt-6.1-terra / gpt-6.1-terra / answer / 40 / 20 / 300', () => {
  const cfg = cfgOf({});
  assert.equal(cfg.brainModel, 'gpt-5.6-sol');
  assert.equal(cfg.brainBackupModel, 'gpt-6.1-terra');
  assert.equal(cfg.brainClassifyModel, 'gpt-6.1-terra');
  assert.equal(cfg.brainBackupMode, 'answer');
  assert.equal(cfg.brainMonthAlertUsd, 40);
  assert.equal(cfg.brainDayStopUsd, 20);
  assert.equal(cfg.brainMonthStopUsd, 300);
});

test('the brain knobs follow the env (bona-vps.env), so T26 can swap the models and T18.0 can set the $50 month stop', () => {
  const cfg = cfgOf({
    BONA_BRAIN_MODEL: 'gpt-6.1-terra', BONA_BRAIN_BACKUP_MODEL: 'gpt-5.6-sol', BONA_BRAIN_CLASSIFY_MODEL: 'gpt-5.6-sol',
    BONA_BRAIN_BACKUP_MODE: 'handover', BONA_BRAIN_MONTH_ALERT_USD: '32.5', BONA_BRAIN_DAY_STOP_USD: '10', BONA_BRAIN_MONTH_STOP_USD: '50',
  });
  assert.equal(cfg.brainModel, 'gpt-6.1-terra');
  assert.equal(cfg.brainBackupModel, 'gpt-5.6-sol');
  assert.equal(cfg.brainClassifyModel, 'gpt-5.6-sol');
  assert.equal(cfg.brainBackupMode, 'handover');
  assert.equal(cfg.brainMonthAlertUsd, 32.5);
  assert.equal(cfg.brainDayStopUsd, 10);
  assert.equal(cfg.brainMonthStopUsd, 50);
  assert.equal(cfgOf({ BONA_BRAIN_BACKUP_MODE: ' Answer ' }).brainBackupMode, 'answer', 'case and blanks do not matter');
});

test('a brain $ knob that is not a plain positive number falls back to its default', () => {
  for (const bad of ['', ' ', 'twenty', '20usd', '$20', '-5', '0', '1e3', '0x10', 'NaN', 'Infinity', '20,5']) {
    const cfg = cfgOf({ BONA_BRAIN_MONTH_ALERT_USD: bad, BONA_BRAIN_DAY_STOP_USD: bad, BONA_BRAIN_MONTH_STOP_USD: bad });
    assert.equal(cfg.brainMonthAlertUsd, 40, `alert ${JSON.stringify(bad)}`);
    assert.equal(cfg.brainDayStopUsd, 20, `day ${JSON.stringify(bad)}`);
    assert.equal(cfg.brainMonthStopUsd, 300, `month ${JSON.stringify(bad)}`);
  }
});

test('a brain model name that is not a plain model id falls back to its default; an unknown backup mode fails safe to handover', () => {
  for (const bad of ['', ' ', 'gpt 5', 'gpt-5.6-sol;rm', '../x', 'x'.repeat(65)]) {
    const cfg = cfgOf({ BONA_BRAIN_MODEL: bad, BONA_BRAIN_BACKUP_MODEL: bad, BONA_BRAIN_CLASSIFY_MODEL: bad });
    assert.equal(cfg.brainModel, 'gpt-5.6-sol', JSON.stringify(bad));
    assert.equal(cfg.brainBackupModel, 'gpt-6.1-terra', JSON.stringify(bad));
    assert.equal(cfg.brainClassifyModel, 'gpt-6.1-terra', JSON.stringify(bad));
  }
  assert.equal(cfgOf({ BONA_BRAIN_BACKUP_MODE: '' }).brainBackupMode, 'answer', 'blank is unset: the default');
  for (const bad of ['handvoer', 'yes', '1', 'answer please']) {
    assert.equal(cfgOf({ BONA_BRAIN_BACKUP_MODE: bad }).brainBackupMode, 'handover', `${bad}: the backup never answers on a typo`);
  }
});

test('no config key reads OPENAI_API_KEY, ANTHROPIC_API_KEY or BONA_OPENAI_API_KEY, and cfg.env does not carry them either', () => {
  const env = {
    OPENAI_API_KEY: 'sk-generic-openai-VALUE1',
    ANTHROPIC_API_KEY: 'sk-ant-generic-VALUE2',
    BONA_OPENAI_API_KEY: 'sk-bona-brain-VALUE3',
    BONA_ANTHROPIC_API_KEY: 'sk-ant-bona-VALUE4',
    OPENAI_ORG_ID: 'org-VALUE5',
    EVOLUTION_API_URL: 'https://evo.example.com',
  };
  const cfg = cfgOf(env);
  const all = JSON.stringify(cfg);
  for (const v of ['VALUE1', 'VALUE2', 'VALUE3', 'VALUE4', 'VALUE5']) assert.doesNotMatch(all, new RegExp(v), v);
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BONA_OPENAI_API_KEY', 'BONA_ANTHROPIC_API_KEY', 'OPENAI_ORG_ID']) {
    assert.equal(Object.hasOwn(cfg.env, k), false, `cfg.env.${k}`);
  }
  assert.equal(cfg.env.EVOLUTION_API_URL, 'https://evo.example.com', 'every other key still reaches the modules that read cfg.env');
  assert.ok(Object.hasOwn(env, 'OPENAI_API_KEY'), 'the env object handed in is not mutated');
  assert.doesNotMatch(JSON.stringify(redacted(cfg)), /VALUE\d/);
});

test('redacted() prints the brain knobs and the warm-up anchor, which are not secrets', () => {
  const r = redacted(cfgOf({ BONA_WA_LINKED_AT: '2026-11-26T05:25:00+03:00' }));
  assert.equal(r.brainModel, 'gpt-5.6-sol');
  assert.equal(r.brainBackupModel, 'gpt-6.1-terra');
  assert.equal(r.brainClassifyModel, 'gpt-6.1-terra');
  assert.equal(r.brainBackupMode, 'answer');
  assert.equal(r.brainMonthAlertUsd, 40);
  assert.equal(r.brainDayStopUsd, 20);
  assert.equal(r.brainMonthStopUsd, 300);
  assert.equal(r.waLinkedAt, Date.UTC(2026, 10, 26, 2, 25));
  assert.equal(r.danaTurnsMonthAlert, 1500);
  assert.deepEqual(r.waPersonalInstances, ['abdulaziz-personal']);
});
