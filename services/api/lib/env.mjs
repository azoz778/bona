/**
 * Environment loading for the Bona services.
 *
 * Secrets live in files outside the repo (mode 0600) and are read *inside Node* only:
 *   ~/.secrets/retell.env         RETELL_API_KEY, TOOLTOKEN, …
 *   ~/.secrets/evolution-api.env  EVOLUTION_API_URL, EVOLUTION_API_KEY, …
 *   ~/.secrets/bona-services.env  BONA_* configuration for the intake + concierge
 *   ~/.secrets/bona-marketing.env META_PIXEL_ID, META_CAPI_TOKEN, META_TEST_EVENT_CODE,
 *                                 GA4_MEASUREMENT_ID, GA4_API_SECRET, SNAP_PIXEL_ID, SNAP_CAPI_TOKEN
 *
 * Values are never logged. `process.env` always wins over a file so systemd
 * (`EnvironmentFile=`) and one-off overrides stay authoritative.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Parse a dotenv-style file body. Ignores blanks and `#` comments, strips `export `. */
export function parseEnvText(text) {
  const out = {};
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Read one env file. Missing or unreadable files yield `{}` — never throw, never log the content. */
export function loadEnvFile(file) {
  try {
    return parseEnvText(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function secretsDir(home = os.homedir()) {
  return path.join(home, '.secrets');
}

/** The four env files the services read, lowest precedence first. */
export function defaultEnvFiles(home = os.homedir()) {
  const dir = secretsDir(home);
  return [
    path.join(dir, 'retell.env'),
    path.join(dir, 'evolution-api.env'),
    path.join(dir, 'bona-services.env'),
    path.join(dir, 'bona-marketing.env'),
  ];
}

/**
 * Merge the env files with `process.env` (which wins).
 * @param {{ files?: string[], home?: string, base?: Record<string,string> }} [opts]
 */
export function loadEnv(opts = {}) {
  const home = opts.home ?? os.homedir();
  const files = opts.files ?? defaultEnvFiles(home);
  const merged = {};
  for (const f of files) Object.assign(merged, loadEnvFile(f));
  Object.assign(merged, opts.base ?? process.env);
  return merged;
}

/** 32 hex characters, cryptographically random. */
export function randomToken(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Rewrite keys in an env file **in place**, keeping every other line — comments,
 * ordering, unrelated keys — exactly as it found them. Used to rotate
 * `BONA_TOOL_TOKEN` without hand-editing a secrets file. Values are never printed;
 * the file keeps mode 0600.
 * @param {string} file
 * @param {Record<string,string>} updates
 * @returns {{ file: string, replaced: string[], appended: string[] }}
 */
export function setEnvValues(file, updates) {
  const keys = Object.keys(updates);
  if (!keys.length) return { file, replaced: [], appended: [] };
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const replaced = [];
  const lines = prev.split(/\r?\n/).map((line) => {
    const body = line.trim().startsWith('export ') ? line.trim().slice(7) : line.trim();
    const eq = body.indexOf('=');
    if (eq <= 0 || body.startsWith('#')) return line;
    const key = body.slice(0, eq).trim();
    if (!keys.includes(key) || replaced.includes(key)) return line;
    replaced.push(key);
    return `${key}=${updates[key]}`;
  });
  const appended = keys.filter((k) => !replaced.includes(k));
  let out = lines.join('\n');
  if (appended.length) {
    if (out && !out.endsWith('\n')) out += '\n';
    out += `${appended.map((k) => `${k}=${updates[k]}`).join('\n')}\n`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, out, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return { file, replaced, appended };
}

/**
 * Ensure `~/.secrets/bona-services.env` exists and holds every key in `defaults`.
 * Existing values are never changed and the file is never printed.
 * @returns {{ file: string, created: boolean, added: string[] }}
 */
export function ensureServicesEnv(defaults, opts = {}) {
  const home = opts.home ?? os.homedir();
  const dir = secretsDir(home);
  const file = opts.file ?? path.join(dir, 'bona-services.env');
  const exists = fs.existsSync(file);
  const current = exists ? loadEnvFile(file) : {};
  const added = Object.keys(defaults).filter((k) => !(k in current));
  if (!exists) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const header = '# Bona services — created automatically. Do not commit.\n';
    const body = Object.entries(defaults).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(file, `${header}${body}\n`, { mode: 0o600 });
    return { file, created: true, added };
  }
  if (added.length) {
    const body = added.map((k) => `${k}=${defaults[k]}`).join('\n');
    const prev = fs.readFileSync(file, 'utf8');
    const sep = prev.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(file, `${sep}# added ${new Date().toISOString().slice(0, 10)}\n${body}\n`);
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return { file, created: false, added };
}
