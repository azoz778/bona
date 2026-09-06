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
import { resolveInventoryFile } from './inventory.mjs';
import { parseTrustedProxies } from './ratelimit.mjs';
import { MAX_CALLS_PER_DAY, MAX_CHATS_PER_DAY, MAX_TURNS_PER_SESSION } from './budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IDS_FILE = path.resolve(HERE, '../retell/ids.json');
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

export function version() {
  try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

const truthy = (v, fallback = false) => (v == null || v === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

export function loadConfig({ env = loadEnv(), ids = readIds(), home = os.homedir() } = {}) {
  const siteUrl = String(env.BONA_SITE ?? 'https://bona.azoz.uk').replace(/\/+$/, '');
  const publicApi = String(env.BONA_PUBLIC_API ?? 'https://bona-api.azoz.uk').replace(/\/+$/, '');
  const dataDir = env.BONA_DATA ?? path.join(home, 'bona-data');
  return {
    port: Number(env.BONA_API_PORT ?? 4102),
    host: env.BONA_API_HOST ?? '127.0.0.1',
    siteUrl,
    publicApi,
    dataDir,
    dbFile: env.BONA_DB_FILE ?? path.join(dataDir, 'bona.db'),
    inventoryFile: resolveInventoryFile(env),
    origins: parseOrigins(env.BONA_CORS_ORIGINS),
    toolToken: env.BONA_TOOL_TOKEN ?? '',
    allowQueryToken: truthy(env.BONA_ALLOW_QUERY_TOKEN, false),
    trustedProxies: parseTrustedProxies(env.BONA_TRUSTED_PROXY),
    retellApiKey: env.RETELL_API_KEY ?? '',
    retellMock: truthy(env.BONA_RETELL_MOCK, false),
    chatAgentId: env.BONA_RETELL_CHAT_AGENT_ID ?? ids.chatAgentId ?? ids.voiceAgentId ?? null,
    voiceAgentId: env.BONA_RETELL_VOICE_AGENT_ID ?? ids.voiceAgentId ?? null,
    waNumber: env.BONA_WHATSAPP ?? '966593296933',
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
    waPollMs: Number(env.BONA_WA_POLL_MS ?? 45_000),
    fanoutMs: Number(env.BONA_FANOUT_MS ?? 20_000),
    dashCookieDays: Number(env.BONA_DASH_COOKIE_DAYS ?? 30),
    // Ad-platform server-side APIs (~/.secrets/bona-marketing.env). All optional: a
    // missing key means that destination is skipped, never an error.
    metaPixelId: env.META_PIXEL_ID ?? '',
    metaCapiToken: env.META_CAPI_TOKEN ?? '',
    metaTestEventCode: env.META_TEST_EVENT_CODE ?? '',
    ga4MeasurementId: env.GA4_MEASUREMENT_ID ?? '',
    ga4ApiSecret: env.GA4_API_SECRET ?? '',
    snapPixelId: env.SNAP_PIXEL_ID ?? '',
    snapCapiToken: env.SNAP_CAPI_TOKEN ?? '',
    logLevel: env.BONA_LOG_LEVEL ?? 'info',
    env,
    ids,
    version: version(),
  };
}

/** Safe to log: no keys, no tokens. */
export function redacted(cfg) {
  return {
    port: cfg.port, host: cfg.host, siteUrl: cfg.siteUrl, publicApi: cfg.publicApi,
    dataDir: cfg.dataDir, inventoryFile: cfg.inventoryFile, origins: cfg.origins,
    retellMock: cfg.retellMock, hasRetellKey: Boolean(cfg.retellApiKey),
    hasToolToken: Boolean(cfg.toolToken), allowQueryToken: cfg.allowQueryToken,
    trustedProxies: cfg.trustedProxies, chatAgentId: cfg.chatAgentId,
    voiceAgentId: cfg.voiceAgentId, version: cfg.version,
    maxChatsPerDay: cfg.maxChatsPerDay, maxCallsPerDay: cfg.maxCallsPerDay,
    maxTurnsPerSession: cfg.maxTurnsPerSession,
    dbFile: cfg.dbFile, eventsRatePerMin: cfg.eventsRatePerMin, enquiryRatePerMin: cfg.enquiryRatePerMin,
    waPoll: cfg.waPoll, waPollMs: cfg.waPollMs, fanoutMs: cfg.fanoutMs, dashCookieDays: cfg.dashCookieDays,
    // Pixel / measurement ids are printed on every page of the site; the tokens are not.
    metaPixelId: cfg.metaPixelId || null, ga4MeasurementId: cfg.ga4MeasurementId || null, snapPixelId: cfg.snapPixelId || null,
    hasMetaCapiToken: Boolean(cfg.metaCapiToken), hasGa4ApiSecret: Boolean(cfg.ga4ApiSecret), hasSnapCapiToken: Boolean(cfg.snapCapiToken),
  };
}
