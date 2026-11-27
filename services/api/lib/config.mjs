/**
 * One place that turns environment + `retell/ids.json` into the running config.
 * Secrets are read here and never logged; only `redacted()` is ever printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { parseOrigins } from './cors.mjs';
import { resolveLegacyHosts } from './legacy.mjs';
import { resolveInventoryFile } from './inventory.mjs';
import { parseTrustedProxies } from './ratelimit.mjs';
import { MAX_CALLS_PER_DAY, MAX_CHATS_PER_DAY, MAX_TURNS_PER_SESSION } from './budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IDS_FILE = path.resolve(HERE, '../retell/ids.json');
/** The site's own config: the single source of truth for both domains (see `siteDefaults`). */
export const SITE_FILE = path.resolve(HERE, '../../../src/data/site.json');
export const PKG_FILE = path.resolve(HERE, '../../package.json');

export function readIds(file = IDS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Stable key order, so two records that say the same thing serialise the same way. */
const stable = (obj) => JSON.stringify(Object.keys(obj).sort().reduce((a, k) => { a[k] = obj[k]; return a; }, {}));

/**
 * Write `ids.json` — but only when an id actually changed. Provisioning is idempotent
 * and gets re-run often; bumping `updatedAt` on every run would leave a dirty worktree
 * saying nothing happened.
 * @returns {{ file: string, changed: boolean }}
 */
export function writeIds(ids, file = IDS_FILE) {
  const { updatedAt: _was, ...current } = readIds(file);
  if (stable(current) === stable(ids)) return { file, changed: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...ids, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return { file, changed: true };
}

/**
 * The two domains, read from `src/data/site.json` rather than written down here a second
 * time. The site moved once already (bona.azoz.uk → bona-real-estate.com) and will move
 * again; a literal in this file is a place the move can be forgotten, and a forgotten one
 * here is silent — it only shows up as a Retell tool pointing at a dead host, or an
 * absolutised image URL on the wrong domain. Environment still wins over both, and the
 * literals below survive only as a last resort for a service running without the repo.
 */
export function siteDefaults(file = SITE_FILE) {
  const url = (v) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v.replace(/\/+$/, '') : null);
  try {
    const site = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { siteUrl: url(site?.url), publicApi: url(site?.concierge?.apiBase) };
  } catch {
    return { siteUrl: null, publicApi: null };
  }
}

export function version() {
  try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

const truthy = (v, fallback = false) => (v == null || v === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

/**
 * An ISO 8601 instant that states its offset (`2026-11-26T05:25:00+03:00`, or `Z`), as ms;
 * anything else is null. Stricter than `Date.parse`, which reads a value with no offset as
 * local time and rolls `02-30` over into March: for the warm-up anchor a guess is worse
 * than none, because none means the strictest tier.
 */
export function parseIsoInstant(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '0', frac = '0', z, sign, oh, om] = m;
  const n = (v) => Number(v);
  if (n(mo) < 1 || n(mo) > 12 || n(h) > 23 || n(mi) > 59 || n(sec) > 59) return null;
  if (!z && (n(oh) > 14 || n(om) > 59 || (n(oh) === 14 && n(om) > 0))) return null;
  const local = Date.UTC(n(y), n(mo) - 1, n(d), n(h), n(mi), n(sec), n(frac.padEnd(3, '0')));
  const back = new Date(local);
  // A day that does not exist (02-30, 11-31) comes back as another date.
  if (back.getUTCFullYear() !== n(y) || back.getUTCMonth() !== n(mo) - 1 || back.getUTCDate() !== n(d)) return null;
  const offsetMs = z ? 0 : (sign === '-' ? -1 : 1) * (n(oh) * 60 + n(om)) * 60_000;
  return local - offsetMs;
}

/** A plain positive number (`20`, `32.5`): no sign, no exponent, no hex, no unit; else the fallback. */
const positiveAmount = (v, fallback) => {
  const s = String(v ?? '').trim();
  const num = /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : NaN;
  return Number.isFinite(num) && num > 0 ? num : fallback;
};
/** A plain positive whole number; else the fallback. */
const positiveCount = (v, fallback) => {
  const s = String(v ?? '').trim();
  const num = /^\d{1,9}$/.test(s) ? Number(s) : NaN;
  return Number.isSafeInteger(num) && num > 0 ? num : fallback;
};
/** A model id as the provider writes it (`gpt-5.6-sol`); anything else is the fallback, never sent. */
const modelId = (v, fallback) => {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(s) ? s : fallback;
};
/** A comma list, blanks dropped. */
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * The owner's personal WhatsApp instance, on the same Evolution server as Bona's (lib/wa.mjs
 * defaults to it). The identity guard (DESIGN §5.3) refuses it whatever the env says, so it
 * is always in the list; BONA_WA_PERSONAL_INSTANCES can only add names.
 */
export const PERSONAL_INSTANCE = 'abdulaziz-personal';
const instanceNames = (v) => [...new Set([PERSONAL_INSTANCE, ...list(v).filter((x) => /^[A-Za-z0-9._-]{1,64}$/.test(x))])];

/**
 * The AI service's knobs (brain/DESIGN-brain.md §2, DESIGN §5.2): code defaults, so every
 * one is optional in bona-vps.env. T26's eval may swap the two models; T18.0 writes a $50
 * month stop while the shared phone-line key is in use.
 */
export const BRAIN_DEFAULTS = Object.freeze({
  model: 'gpt-5.6-sol', backupModel: 'gpt-6.1-terra', classifyModel: 'gpt-6.1-terra', backupMode: 'answer',
  monthAlertUsd: 40, dayStopUsd: 20, monthStopUsd: 300,
});
/**
 * `answer` (the backup model answers) or `handover` (it is never called; the client gets the
 * hand-over line). Unset is the default; a value that is neither — a typo — fails safe to
 * `handover`, so a backup the owner meant to keep quiet never answers a client.
 */
const backupMode = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return BRAIN_DEFAULTS.backupMode;
  return s === 'answer' || s === 'handover' ? s : 'handover';
};

/**
 * Generic AI keys are never config: the AI key lives in ~/.secrets/bona-brain.env and only
 * lib/brain reads it (DESIGN §5.2). TK's production env holds OPENAI_API_KEY and
 * ANTHROPIC_API_KEY, so a shared process environment could hand them in; they are dropped
 * from `cfg.env`, which every tool handler sees, as well as never being read here.
 */
const AI_KEY_NAME = /^(?:BONA_)?(?:OPENAI|ANTHROPIC)_/i;
const withoutAiKeys = (env) => Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => !AI_KEY_NAME.test(k)));

export function loadConfig({ env = loadEnv(), ids = readIds(), home = os.homedir() } = {}) {
  const fromSite = siteDefaults();
  const siteUrl = String(env.BONA_SITE ?? fromSite.siteUrl ?? 'https://bona-real-estate.com').replace(/\/+$/, '');
  const publicApi = String(env.BONA_PUBLIC_API ?? fromSite.publicApi ?? 'https://api.bona-real-estate.com').replace(/\/+$/, '');
  const dataDir = env.BONA_DATA ?? path.join(home, 'bona-data');
  return {
    port: Number(env.BONA_API_PORT ?? 4102),
    host: env.BONA_API_HOST ?? '127.0.0.1',
    siteUrl,
    publicApi,
    dataDir,
    dbFile: env.BONA_DB_FILE ?? path.join(dataDir, 'bona.db'),
    inventoryFile: resolveInventoryFile(env),
    // The site's own origin is always allowed, whatever the allowlist says: browser routes
    // are now origin-checked fail-closed, so a domain move that outran BONA_CORS_ORIGINS
    // would 403 every event, every enquiry and the whole concierge.
    origins: [...new Set([...parseOrigins(env.BONA_CORS_ORIGINS), siteUrl])],
    legacyHosts: resolveLegacyHosts(env.BONA_LEGACY_HOSTS, siteUrl),
    toolToken: env.BONA_TOOL_TOKEN ?? '',
    allowQueryToken: truthy(env.BONA_ALLOW_QUERY_TOKEN, false),
    trustedProxies: parseTrustedProxies(env.BONA_TRUSTED_PROXY),
    retellApiKey: env.RETELL_API_KEY ?? '',
    retellMock: truthy(env.BONA_RETELL_MOCK, false),
    chatAgentId: env.BONA_RETELL_CHAT_AGENT_ID ?? ids.chatAgentId ?? ids.voiceAgentId ?? null,
    voiceAgentId: env.BONA_RETELL_VOICE_AGENT_ID ?? ids.voiceAgentId ?? null,
    // Dana on WhatsApp (Phase 4): her own chat agent, provisioned by `retell/provision.mjs
    // --whatsapp-only`. No fallback to the site's agent: the web prompt (cards, markers, the
    // recording sentence) must never answer a WhatsApp client. Missing → Dana is not configured.
    waChatAgentId: env.BONA_RETELL_WA_CHAT_AGENT_ID ?? ids.waChatAgentId ?? null,
    maxBodyBytes: Number(env.BONA_MAX_BODY_BYTES ?? 16 * 1024),
    chatRatePerMin: Number(env.BONA_RATE_CHAT ?? 30),
    tokenRatePerMin: Number(env.BONA_RATE_TOKEN ?? 6),
    toolRatePerMin: Number(env.BONA_RATE_TOOL ?? 600),
    toolAuthFailRatePerMin: Number(env.BONA_RATE_TOOL_AUTH_FAIL ?? 10),
    maxChatsPerDay: Number(env.BONA_MAX_CHATS_PER_DAY ?? MAX_CHATS_PER_DAY),
    maxCallsPerDay: Number(env.BONA_MAX_CALLS_PER_DAY ?? MAX_CALLS_PER_DAY),
    maxTurnsPerSession: Number(env.BONA_MAX_TURNS_PER_SESSION ?? MAX_TURNS_PER_SESSION),
    // Tracking stack (events, enquiry, WhatsApp poller, fan-out, dashboard).
    eventsRatePerMin: Number(env.BONA_RATE_EVENTS ?? 240),
    enquiryRatePerMin: Number(env.BONA_RATE_ENQUIRY ?? 6),
    waPoll: truthy(env.BONA_WA_POLL, true),
    // 20 s since the inbox (P2-11): a staff member waits at most one interval to see a
    // client's message. Each tick is one ~20 ms read on the VPS (measured 2026-09-28).
    waPollMs: Number(env.BONA_WA_POLL_MS ?? 20_000),
    fanoutMs: Number(env.BONA_FANOUT_MS ?? 20_000),
    // Ad-platform fan-out carries a lead's hashed phone to Meta / Snap, so by default it
    // waits for the visitor's ads consent (PDPL). Set to 0 only with a different legal basis.
    fanoutRequireConsent: truthy(env.BONA_FANOUT_REQUIRE_CONSENT, true),
    dashCookieDays: Number(env.BONA_DASH_COOKIE_DAYS ?? 30),
    // Phone alerts (Web Push, Phase 3): generated once on the VPS by bin/vapid-keys.mjs into
    // ~/.secrets/bona-services.env. Missing → no alerts, everything else unchanged. The
    // subject is the contact RFC 8292 asks for: the site's URL, so no address is published.
    vapidPublic: String(env.BONA_VAPID_PUBLIC ?? '').trim(),
    vapidPrivate: String(env.BONA_VAPID_PRIVATE ?? '').trim(),
    vapidSubject: String(env.BONA_VAPID_SUBJECT ?? '').trim() || siteUrl,
    // Ad-platform server-side APIs (~/.secrets/bona-marketing.env). All optional: a
    // missing key means that destination is skipped, never an error.
    metaPixelId: env.META_PIXEL_ID ?? '',
    metaCapiToken: env.META_CAPI_TOKEN ?? '',
    metaTestEventCode: env.META_TEST_EVENT_CODE ?? '',
    ga4MeasurementId: env.GA4_MEASUREMENT_ID ?? '',
    ga4ApiSecret: env.GA4_API_SECRET ?? '',
    snapPixelId: env.SNAP_PIXEL_ID ?? '',
    snapCapiToken: env.SNAP_CAPI_TOKEN ?? '',
    tiktokAccountsAppId: String(env.TIKTOK_ACCOUNTS_APP_ID ?? '').trim(),
    tiktokAccountsAppSecret: String(env.TIKTOK_ACCOUNTS_APP_SECRET ?? '').trim(),
    tiktokAccountsAuthUrl: String(env.TIKTOK_ACCOUNTS_AUTH_URL ?? '').trim(),
    tiktokPixelId: String(env.TIKTOK_PIXEL_ID ?? '').trim(),
    tiktokEventsToken: String(env.TIKTOK_EVENTS_ACCESS_TOKEN ?? '').trim(),
    tiktokTestEventCode: String(env.TIKTOK_TEST_EVENT_CODE ?? '').trim(),
    logLevel: env.BONA_LOG_LEVEL ?? 'info',
    // Full automation (2026-11-27 DESIGN §5.2): read here, used by the modules their tasks
    // build. Nothing reads them yet, so a deploy of this changes no behaviour.
    // The warm-up anchor: when Bona's own number was linked. null = the strictest pacing tier.
    waLinkedAt: parseIsoInstant(env.BONA_WA_LINKED_AT),
    // Never a Bona instance (DESIGN §5.3): the owner's personal WhatsApp is always in it.
    waPersonalInstances: instanceNames(env.BONA_WA_PERSONAL_INSTANCES),
    // A volume alert at 80% and 100% of this many Dana turns a month (no $ figure).
    danaTurnsMonthAlert: positiveCount(env.BONA_DANA_TURNS_MONTH_ALERT, 1500),
    // The viewing calendar (DESIGN §8): ids and the key file's path, env only (never the repo).
    gcalSaFile: String(env.BONA_GCAL_SA_FILE ?? '').trim(),
    gcalCalendarId: String(env.BONA_GCAL_CALENDAR_ID ?? '').trim(),
    gcalExtraBusyIds: list(env.BONA_GCAL_EXTRA_BUSY_IDS),
    // The Kuma push URL for the WhatsApp link probe; it carries a push token.
    kumaWaLinkPush: String(env.BONA_KUMA_WA_LINK_PUSH ?? '').trim(),
    brainModel: modelId(env.BONA_BRAIN_MODEL, BRAIN_DEFAULTS.model),
    brainBackupModel: modelId(env.BONA_BRAIN_BACKUP_MODEL, BRAIN_DEFAULTS.backupModel),
    brainClassifyModel: modelId(env.BONA_BRAIN_CLASSIFY_MODEL, BRAIN_DEFAULTS.classifyModel),
    brainBackupMode: backupMode(env.BONA_BRAIN_BACKUP_MODE),
    brainMonthAlertUsd: positiveAmount(env.BONA_BRAIN_MONTH_ALERT_USD, BRAIN_DEFAULTS.monthAlertUsd),
    brainDayStopUsd: positiveAmount(env.BONA_BRAIN_DAY_STOP_USD, BRAIN_DEFAULTS.dayStopUsd),
    brainMonthStopUsd: positiveAmount(env.BONA_BRAIN_MONTH_STOP_USD, BRAIN_DEFAULTS.monthStopUsd),
    env: withoutAiKeys(env),
    ids,
    version: version(),
  };
}

/** Safe to log: no keys, no tokens. */
export function redacted(cfg) {
  return {
    port: cfg.port, host: cfg.host, siteUrl: cfg.siteUrl, publicApi: cfg.publicApi,
    dataDir: cfg.dataDir, inventoryFile: cfg.inventoryFile, origins: cfg.origins,
    legacyHosts: cfg.legacyHosts,
    retellMock: cfg.retellMock, hasRetellKey: Boolean(cfg.retellApiKey),
    hasToolToken: Boolean(cfg.toolToken), allowQueryToken: cfg.allowQueryToken,
    trustedProxies: cfg.trustedProxies, chatAgentId: cfg.chatAgentId,
    voiceAgentId: cfg.voiceAgentId, waChatAgentId: cfg.waChatAgentId ?? null, version: cfg.version,
    maxChatsPerDay: cfg.maxChatsPerDay, maxCallsPerDay: cfg.maxCallsPerDay,
    maxTurnsPerSession: cfg.maxTurnsPerSession,
    dbFile: cfg.dbFile, eventsRatePerMin: cfg.eventsRatePerMin, enquiryRatePerMin: cfg.enquiryRatePerMin,
    waPoll: cfg.waPoll, waPollMs: cfg.waPollMs, fanoutMs: cfg.fanoutMs, fanoutRequireConsent: cfg.fanoutRequireConsent, dashCookieDays: cfg.dashCookieDays,
    hasVapid: Boolean(cfg.vapidPublic && cfg.vapidPrivate),
    // Pixel / measurement ids are printed on every page of the site; the tokens are not.
    metaPixelId: cfg.metaPixelId || null, ga4MeasurementId: cfg.ga4MeasurementId || null, snapPixelId: cfg.snapPixelId || null,
    hasTiktokAccountsAppId: Boolean(cfg.tiktokAccountsAppId), hasTiktokAccountsAppSecret: Boolean(cfg.tiktokAccountsAppSecret), hasTiktokAccountsAuthUrl: Boolean(cfg.tiktokAccountsAuthUrl),
    tiktokPixelId: cfg.tiktokPixelId || null, hasTiktokEventsToken: Boolean(cfg.tiktokEventsToken),
    hasMetaCapiToken: Boolean(cfg.metaCapiToken), hasGa4ApiSecret: Boolean(cfg.ga4ApiSecret), hasSnapCapiToken: Boolean(cfg.snapCapiToken),
    // Full automation: the knobs are not secrets; a calendar id, a key file's path and a
    // push URL are said only to exist.
    waLinkedAt: cfg.waLinkedAt ?? null, waPersonalInstances: cfg.waPersonalInstances, danaTurnsMonthAlert: cfg.danaTurnsMonthAlert,
    hasGcalSaFile: Boolean(cfg.gcalSaFile), hasGcalCalendarId: Boolean(cfg.gcalCalendarId),
    gcalExtraBusyCount: Array.isArray(cfg.gcalExtraBusyIds) ? cfg.gcalExtraBusyIds.length : 0,
    hasKumaWaLinkPush: Boolean(cfg.kumaWaLinkPush),
    brainModel: cfg.brainModel, brainBackupModel: cfg.brainBackupModel, brainClassifyModel: cfg.brainClassifyModel,
    brainBackupMode: cfg.brainBackupMode, brainMonthAlertUsd: cfg.brainMonthAlertUsd, brainDayStopUsd: cfg.brainDayStopUsd,
    brainMonthStopUsd: cfg.brainMonthStopUsd,
  };
}
