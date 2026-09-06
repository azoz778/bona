// Config loading. Secrets live in ~/.secrets/*.env and are read HERE, inside Node —
// never through a shell (`cat`/`source` of a secret file is blocked by the auto-mode
// classifier, and shelling secrets out is how they end up in logs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Parse a dotenv-style file body. Supports `export K=v`, quotes and `#` comments. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(file) {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const HOME = os.homedir();
export const SECRET_FILES = {
  services: path.join(HOME, '.secrets', 'bona-services.env'),
  evolution: path.join(HOME, '.secrets', 'evolution-api.env'),
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

/**
 * Merge, in increasing precedence: defaults < ~/.secrets/evolution-api.env <
 * ~/.secrets/bona-services.env < process.env < overrides.
 * The systemd unit puts bona-services.env into process.env; reading the files here as
 * well means run-once.mjs works from a plain shell with no exports.
 */
export function loadConfig(overrides = {}) {
  const raw = {
    ...readEnvFile(SECRET_FILES.evolution),
    ...readEnvFile(SECRET_FILES.services),
  };
  for (const k of Object.keys({ ...raw, ...process.env })) {
    if (process.env[k] !== undefined && process.env[k] !== '') raw[k] = process.env[k];
  }
  const repo = overrides.repo || raw.BONA_REPO || path.join(HOME, 'bona-bot');
  const data = overrides.data || raw.BONA_DATA || path.join(HOME, 'bona-data');
  return {
    evolutionUrl: (raw.EVOLUTION_API_URL || '').replace(/\/+$/, ''),
    evolutionKey: raw.EVOLUTION_API_KEY || '',
    instance: raw.BONA_WA_INSTANCE || 'abdulaziz-personal',
    ownerJid: raw.BONA_OWNER_JID || '966593296933@s.whatsapp.net',
    groupMatch: raw.BONA_WA_GROUP_MATCH || 'bona',
    groupJids: String(raw.BONA_WA_GROUP_JIDS || '').split(/[,\s]+/).filter(Boolean),
    repo,
    data,
    intakeDir: path.join(data, 'intake'),
    statePath: path.join(data, 'intake-state.json'),
    lockPath: path.join(data, 'intake.lock'),
    pollMs: num(raw.BONA_POLL_MS, 20000),
    groupScanMs: num(raw.BONA_GROUP_SCAN_MS, 300000),
    claudeModel: raw.BONA_CLAUDE_MODEL || 'sonnet',
    claudeFallbackModel: raw.BONA_CLAUDE_FALLBACK_MODEL || 'opus',
    claudeBin: raw.BONA_CLAUDE_BIN || 'claude',
    claudeTimeoutMs: num(raw.BONA_CLAUDE_TIMEOUT_MS, 600000),
    // argv ARRAY, never a shell string: nothing here is ever handed to a shell.
    pyCmd: String(raw.BONA_PY_CMD || '').trim()
      ? String(raw.BONA_PY_CMD).trim().split(/\s+/)
      : ['uv', 'run', '--with', 'pymupdf', 'python'],
    // The brochure step needs more than the extractor does: segno draws the QR and
    // fontTools+brotli decompress public/fonts/*.woff2 into the TTFs PyMuPDF can embed.
    brochurePyCmd: String(raw.BONA_BROCHURE_PY_CMD || '').trim()
      ? String(raw.BONA_BROCHURE_PY_CMD).trim().split(/\s+/)
      : ['uv', 'run', '--with', 'pymupdf', '--with', 'segno', '--with', 'fonttools', '--with', 'brotli', 'python'],
    brochureTimeoutMs: num(raw.BONA_BROCHURE_TIMEOUT_MS, 600000),
    site: (raw.BONA_SITE || 'https://bona.azoz.uk').replace(/\/+$/, ''),
    maxPdfMb: num(raw.BONA_MAX_PDF_MB, 150), // real developer brochures are 50–80 MB (owner's files 2026-09-06)
    maxPdfPages: num(raw.BONA_MAX_PDF_PAGES, 120),
    // The cap on the BRANDED output, not on the developer's original: rebrand_pdf.py
    // downsamples until it fits and refuses to write anything larger.
    maxBrochureMb: num(raw.BONA_MAX_BROCHURE_MB, 25),
    minImages: num(raw.BONA_MIN_IMAGES, 4),
    maxImages: num(raw.BONA_MAX_IMAGES, 10),
    minImageSide: num(raw.BONA_MIN_IMAGE_SIDE, 700),
    gitRemote: raw.BONA_GIT_REMOTE || 'origin',
    gitBranch: raw.BONA_GIT_BRANCH || 'main',
    liveCheckMs: num(raw.BONA_LIVE_CHECK_MS, 600000),
    lockWaitMs: num(raw.BONA_LOCK_WAIT_MS, 900000),
    pageReadLongSide: num(raw.BONA_PAGE_READ_LONG_SIDE, 1600),
    sendReplies: bool(raw.BONA_SEND_REPLIES, true),
    ...overrides,
  };
}

/** Human-readable list of what is missing, so the daemon can refuse to start loudly. */
export function missingRequired(cfg) {
  const missing = [];
  if (!cfg.evolutionUrl) missing.push('EVOLUTION_API_URL');
  if (!cfg.evolutionKey) missing.push('EVOLUTION_API_KEY');
  return missing;
}
