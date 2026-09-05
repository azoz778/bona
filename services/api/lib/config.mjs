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

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IDS_FILE = path.resolve(HERE, '../retell/ids.json');
export const PKG_FILE = path.resolve(HERE, '../../package.json');

export function readIds(file = IDS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function writeIds(ids, file = IDS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...ids, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return file;
}

export function version() {
  try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

const truthy = (v, fallback = false) => (v == null || v === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

export function loadConfig({ env = loadEnv(), ids = readIds(), home = os.homedir() } = {}) {
  const siteUrl = String(env.BONA_SITE ?? 'https://bona.azoz.uk').replace(/\/+$/, '');
  const publicApi = String(env.BONA_PUBLIC_API ?? 'https://api.bona.azoz.uk').replace(/\/+$/, '');
  return {
    port: Number(env.BONA_API_PORT ?? 4102),
    host: env.BONA_API_HOST ?? '127.0.0.1',
    siteUrl,
    publicApi,
    dataDir: env.BONA_DATA ?? path.join(home, 'bona-data'),
    inventoryFile: resolveInventoryFile(env),
    origins: parseOrigins(env.BONA_CORS_ORIGINS),
    toolToken: env.BONA_TOOL_TOKEN ?? '',
    retellApiKey: env.RETELL_API_KEY ?? '',
    retellMock: truthy(env.BONA_RETELL_MOCK, false),
    chatAgentId: env.BONA_RETELL_CHAT_AGENT_ID ?? ids.chatAgentId ?? ids.voiceAgentId ?? null,
    voiceAgentId: env.BONA_RETELL_VOICE_AGENT_ID ?? ids.voiceAgentId ?? null,
    waNumber: env.BONA_WHATSAPP ?? '966593296933',
    maxBodyBytes: Number(env.BONA_MAX_BODY_BYTES ?? 16 * 1024),
    chatRatePerMin: Number(env.BONA_RATE_CHAT ?? 30),
    tokenRatePerMin: Number(env.BONA_RATE_TOKEN ?? 6),
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
    hasToolToken: Boolean(cfg.toolToken), chatAgentId: cfg.chatAgentId,
    voiceAgentId: cfg.voiceAgentId, version: cfg.version,
  };
}
