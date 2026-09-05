// One JSON object per line on stdout — journald keeps them, `journalctl -o cat -u bona-intake | jq`
// reads them. Never log a secret: `redact` scrubs anything that looks like a key or a base64 blob.
const SECRET_KEYS = /(key|token|secret|password|apikey|authorization|base64)/i;

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 200)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return depth > 4 ? `[${value.length}]` : value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    if (depth > 4) return '[object]';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

function emit(level, event, fields) {
  const line = { ts: new Date().toISOString(), level, event, ...redact(fields || {}) };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (event, fields) => (process.env.BONA_DEBUG ? emit('debug', event, fields) : undefined),
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};

/** Human line for the console-facing CLI (run-once) — kept separate from the JSON log. */
export function say(...parts) {
  process.stdout.write(`${parts.join(' ')}\n`);
}
