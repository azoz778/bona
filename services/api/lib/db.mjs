/**
 * The Bona store: one SQLite file (`${BONA_DATA}/bona.db`) behind `node:sqlite`.
 *
 * Everything the tracking stack shares lives here — visitor sessions and their
 * touch bundles, first-party events, leads with their touchpoints and pipeline
 * stage, the WhatsApp poller's cursor, ad spend, the ad-platform fan-out queue and
 * the dashboard's login state. The in-memory `store.mjs` stays what it is (live
 * chat/call context with a two-hour life); this file is the durable half.
 *
 * Every helper is synchronous, takes and returns plain objects with the column
 * names of the table, and (de)serialises the JSON columns at the boundary. Rows
 * never leave as null-prototype objects. Migrations are keyed by `PRAGMA
 * user_version` and are idempotent — opening the file twice is a no-op.
 *
 * The file holds personal data: it is created 0600 inside a 0700 directory, and
 * WAL/shm side files inherit that mode from SQLite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { randomId } from './store.mjs';

export const SCHEMA_VERSION = 1;

export const STAGES = ['new', 'contacted', 'qualified', 'viewing', 'offer', 'negotiation', 'won', 'lost'];
export const FANOUT_DESTS = ['meta', 'ga4', 'snap'];
export const FANOUT_STATUSES = ['pending', 'sent', 'failed', 'skipped'];

/** `${prefix}-${base36 time}-${4 hex}` — sortable, unique enough for one process. */
export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomId(2)}`;
}

const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, anon_id TEXT, ref TEXT UNIQUE, started INTEGER, last_seen INTEGER, pages INTEGER, locale TEXT,
        first_touch TEXT, last_touch TEXT, fbp TEXT, fbc TEXT, ga_client_id TEXT, ga_session_id TEXT, scid TEXT, ttp TEXT,
        ip TEXT, ua TEXT, country TEXT, consent_analytics INTEGER, consent_ads INTEGER
      );
      CREATE INDEX IF NOT EXISTS sessions_anon ON sessions(anon_id);
      CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen);

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, ts INTEGER, name TEXT, anon_id TEXT, session_id TEXT, lead_id TEXT, listing_id TEXT, path TEXT, props TEXT,
        src_first TEXT, src_last TEXT, ip TEXT, ua TEXT, country TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS events_listing_name ON events(listing_id, name);
      CREATE INDEX IF NOT EXISTS events_anon ON events(anon_id);
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id);

      CREATE TABLE IF NOT EXISTS leads (
        lead_id TEXT PRIMARY KEY, created INTEGER, updated INTEGER, phone_e164 TEXT UNIQUE, wa_jid TEXT, wa_lid TEXT, name TEXT, channel TEXT,
        source TEXT, medium TEXT, campaign TEXT, campaign_id TEXT, content TEXT, click_ids TEXT, ref TEXT, match_method TEXT,
        session_id TEXT, anon_id TEXT, listing_id TEXT, first_touch TEXT, last_touch TEXT,
        interest TEXT, budget TEXT, timeline TEXT, district TEXT, language TEXT, notes TEXT,
        stage TEXT, stage_ts INTEGER, value_sar REAL, first_inbound_ts INTEGER, first_reply_ts INTEGER, legacy_id TEXT,
        consent_ads INTEGER, consent_analytics INTEGER
      );
      CREATE INDEX IF NOT EXISTS leads_jid ON leads(wa_jid);
      CREATE INDEX IF NOT EXISTS leads_lid ON leads(wa_lid);
      CREATE INDEX IF NOT EXISTS leads_stage ON leads(stage);
      CREATE INDEX IF NOT EXISTS leads_created ON leads(created);
      CREATE INDEX IF NOT EXISTS leads_legacy ON leads(legacy_id);

      CREATE TABLE IF NOT EXISTS touchpoints (
        id TEXT PRIMARY KEY, lead_id TEXT, ts INTEGER, channel TEXT, event_type TEXT, source TEXT, medium TEXT, campaign TEXT, campaign_id TEXT,
        listing_id TEXT, meta TEXT
      );
      CREATE INDEX IF NOT EXISTS touchpoints_lead ON touchpoints(lead_id, ts);

      CREATE TABLE IF NOT EXISTS lead_stage_history (
        id TEXT PRIMARY KEY, lead_id TEXT, stage TEXT, ts INTEGER, actor TEXT, note TEXT
      );
      CREATE INDEX IF NOT EXISTS stage_history_lead ON lead_stage_history(lead_id, ts);

      CREATE TABLE IF NOT EXISTS wa_cursor (instance TEXT PRIMARY KEY, last_ts INTEGER, last_run INTEGER, unmatched INTEGER);
      CREATE TABLE IF NOT EXISTS wa_seen (key_id TEXT PRIMARY KEY, ts INTEGER);
      CREATE INDEX IF NOT EXISTS wa_seen_ts ON wa_seen(ts);

      CREATE TABLE IF NOT EXISTS ad_spend (
        day TEXT, platform TEXT, campaign_id TEXT, campaign_name TEXT, spend_sar REAL, clicks INTEGER, impressions INTEGER,
        PRIMARY KEY (day, platform, campaign_id)
      );

      CREATE TABLE IF NOT EXISTS fanout (
        event_id TEXT, dest TEXT, status TEXT, attempts INTEGER, next_at INTEGER, last_error TEXT, response TEXT, ts INTEGER,
        PRIMARY KEY (event_id, dest)
      );
      CREATE INDEX IF NOT EXISTS fanout_due ON fanout(status, next_at);

      CREATE TABLE IF NOT EXISTS auth_codes (code_hash TEXT PRIMARY KEY, created INTEGER, expires INTEGER, used INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, created INTEGER, expires INTEGER, ua TEXT);
    `,
  },
];

/** Columns of each table, in order — the single source for the insert/update helpers. */
const COLUMNS = {
  sessions: ['session_id', 'anon_id', 'ref', 'started', 'last_seen', 'pages', 'locale', 'first_touch', 'last_touch', 'fbp', 'fbc',
    'ga_client_id', 'ga_session_id', 'scid', 'ttp', 'ip', 'ua', 'country', 'consent_analytics', 'consent_ads'],
  events: ['event_id', 'ts', 'name', 'anon_id', 'session_id', 'lead_id', 'listing_id', 'path', 'props', 'src_first', 'src_last', 'ip', 'ua', 'country'],
  leads: ['lead_id', 'created', 'updated', 'phone_e164', 'wa_jid', 'wa_lid', 'name', 'channel', 'source', 'medium', 'campaign', 'campaign_id',
    'content', 'click_ids', 'ref', 'match_method', 'session_id', 'anon_id', 'listing_id', 'first_touch', 'last_touch', 'interest', 'budget',
    'timeline', 'district', 'language', 'notes', 'stage', 'stage_ts', 'value_sar', 'first_inbound_ts', 'first_reply_ts', 'legacy_id',
    'consent_ads', 'consent_analytics'],
  touchpoints: ['id', 'lead_id', 'ts', 'channel', 'event_type', 'source', 'medium', 'campaign', 'campaign_id', 'listing_id', 'meta'],
};

/** JSON columns per table: stringified on the way in, parsed on the way out. */
const JSON_COLUMNS = {
  sessions: ['first_touch', 'last_touch'],
  events: ['props', 'src_first', 'src_last'],
  leads: ['click_ids', 'first_touch', 'last_touch'],
  touchpoints: ['meta'],
};

/* ------------------------------------------------------------------ */
/* Value plumbing                                                      */
/* ------------------------------------------------------------------ */

const toJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const fromJson = (v) => { if (v === null || v === undefined) return null; try { return JSON.parse(v); } catch { return null; } };
const toInt = (v) => (v === undefined || v === null ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v)));

/** A bindable value: strings/numbers pass, booleans become 0/1, undefined becomes null. */
function bind(table, col, v) {
  if (JSON_COLUMNS[table]?.includes(col)) return toJson(v);
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return v;
}

function unwrap(table, row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLUMNS[table] ?? []) if (col in out) out[col] = fromJson(out[col]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Open                                                                */
/* ------------------------------------------------------------------ */

/**
 * Open (creating if needed) and migrate the store.
 * @param {string} file  path, or `':memory:'`
 * @returns the helpers below plus `db` (the DatabaseSync), `file`, `dataDir` and `close()`
 */
export function openDb(file = ':memory:') {
  const inMemory = file === ':memory:';
  if (!inMemory) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=3000');
  migrate(db);

  const stmts = new Map();
  /** Prepared-statement cache: the same SQL text is compiled once per open. */
  const prep = (sql) => {
    let s = stmts.get(sql);
    if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
    return s;
  };

  let txDepth = 0;
  /** Run `fn` inside a transaction. Re-entrant: an inner call joins the outer one. */
  function transaction(fn) {
    if (txDepth > 0) return fn();
    txDepth += 1;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    } finally {
      txDepth -= 1;
    }
  }

  function insertRow(table, row, { orIgnore = false } = {}) {
    const cols = COLUMNS[table].filter((c) => row[c] !== undefined);
    const sql = `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    return prep(sql).run(...cols.map((c) => bind(table, c, row[c])));
  }

  /* -------------------- sessions -------------------- */

  /**
   * Insert or update a session. First touch and `started` are kept from the first
   * call; `last_touch`, `last_seen`, consent and any id that is present are updated;
   * `pages` counts up by `s.pages ?? 0`. A `ref` that another session already holds is
   * not taken over — this session simply has none (`INSERT OR IGNORE` semantics on a
   * UNIQUE column, without losing the row).
   */
  function upsertSession(s) {
    if (!s?.session_id) throw new TypeError('session_id is required');
    return transaction(() => {
      let ref = s.ref ? String(s.ref).toUpperCase() : null;
      if (ref) {
        const owner = prep('SELECT session_id FROM sessions WHERE ref = ?').get(ref);
        if (owner && owner.session_id !== s.session_id) ref = null;
      }
      const existing = prep('SELECT session_id, ref FROM sessions WHERE session_id = ?').get(s.session_id);
      if (!existing) {
        insertRow('sessions', { ...s, ref, pages: toInt(s.pages ?? 0), consent_analytics: toInt(s.consent_analytics ?? 0), consent_ads: toInt(s.consent_ads ?? 0) });
        return { created: true };
      }
      const sets = ['last_seen = COALESCE(?, last_seen)', 'pages = pages + ?', 'first_touch = COALESCE(first_touch, ?)', 'last_touch = COALESCE(?, last_touch)', 'started = COALESCE(started, ?)'];
      const vals = [toInt(s.last_seen), toInt(s.pages ?? 0), toJson(s.first_touch), toJson(s.last_touch), toInt(s.started)];
      for (const col of ['anon_id', 'locale', 'fbp', 'fbc', 'ga_client_id', 'ga_session_id', 'scid', 'ttp', 'ip', 'ua', 'country']) {
        if (s[col] !== undefined && s[col] !== null && s[col] !== '') { sets.push(`${col} = ?`); vals.push(String(s[col])); }
      }
      for (const col of ['consent_analytics', 'consent_ads']) {
        if (s[col] !== undefined && s[col] !== null) { sets.push(`${col} = ?`); vals.push(toInt(s[col])); }
      }
      if (ref && !existing.ref) { sets.push('ref = ?'); vals.push(ref); }
      vals.push(s.session_id);
      prep(`UPDATE sessions SET ${sets.join(', ')} WHERE session_id = ?`).run(...vals);
      return { created: false };
    });
  }

  const getSession = (id) => unwrap('sessions', prep('SELECT * FROM sessions WHERE session_id = ?').get(String(id ?? '')));
  const getSessionByRef = (code) => unwrap('sessions', prep('SELECT * FROM sessions WHERE ref = ?').get(String(code ?? '').toUpperCase()));

  /* -------------------- events -------------------- */

  /** @returns {boolean} true when the row was new; a duplicate `event_id` is ignored */
  function insertEvent(e) {
    if (!e?.event_id) throw new TypeError('event_id is required');
    return insertRow('events', e, { orIgnore: true }).changes === 1;
  }

  const getEvent = (id) => unwrap('events', prep('SELECT * FROM events WHERE event_id = ?').get(String(id ?? '')));

  function eventsForSession(sessionId, { limit = 500 } = {}) {
    return prep('SELECT * FROM events WHERE session_id = ? ORDER BY ts ASC, rowid ASC LIMIT ?').all(String(sessionId ?? ''), limit).map((r) => unwrap('events', r));
  }

  /** Newest first. `name` may be a string or an array of names. */
  function recentEvents({ name = null, sinceTs = 0, untilTs = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
    const names = name == null ? null : (Array.isArray(name) ? name : [name]);
    const where = ['ts >= ?', 'ts <= ?'];
    const vals = [toInt(sinceTs), toInt(untilTs)];
    if (names?.length) { where.push(`name IN (${names.map(() => '?').join(',')})`); vals.push(...names); }
    vals.push(limit);
    return prep(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(...vals).map((r) => unwrap('events', r));
  }

  function setEventLead(eventId, leadId) {
    return prep('UPDATE events SET lead_id = ? WHERE event_id = ?').run(leadId, eventId).changes === 1;
  }

  /* -------------------- leads -------------------- */

  function insertLead(l) {
    if (!l?.lead_id) throw new TypeError('lead_id is required');
    insertRow('leads', l);
    return getLead(l.lead_id);
  }

  const getLead = (id) => unwrap('leads', prep('SELECT * FROM leads WHERE lead_id = ?').get(String(id ?? '')));
  const getLeadByPhone = (phone) => (phone ? unwrap('leads', prep('SELECT * FROM leads WHERE phone_e164 = ?').get(String(phone))) : null);
  const getLeadByJid = (jid) => (jid ? unwrap('leads', prep('SELECT * FROM leads WHERE wa_jid = ? OR wa_lid = ? ORDER BY created ASC LIMIT 1').get(String(jid), String(jid))) : null);
  const getLeadByLegacyId = (id) => (id ? unwrap('leads', prep('SELECT * FROM leads WHERE legacy_id = ?').get(String(id))) : null);

  /** Patch known columns only; unknown keys are dropped, `lead_id` cannot change. */
  function updateLead(leadId, patch = {}) {
    const cols = COLUMNS.leads.filter((c) => c !== 'lead_id' && patch[c] !== undefined);
    if (!cols.length) return false;
    const sql = `UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE lead_id = ?`;
    return prep(sql).run(...cols.map((c) => bind('leads', c, patch[c])), String(leadId)).changes === 1;
  }

  function listLeads({ stage = null, q = null, limit = 100, offset = 0 } = {}) {
    const where = [];
    const vals = [];
    if (stage) { where.push('stage = ?'); vals.push(String(stage)); }
    if (q && String(q).trim()) {
      const like = `%${String(q).trim().toLowerCase()}%`;
      where.push('(lower(name) LIKE ? OR phone_e164 LIKE ? OR lower(notes) LIKE ? OR lower(district) LIKE ? OR lower(interest) LIKE ? OR listing_id LIKE ? OR lead_id LIKE ?)');
      vals.push(like, like, like, like, like, like.toUpperCase(), like.toUpperCase());
    }
    vals.push(Math.max(1, Math.min(1000, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
    const sql = `SELECT * FROM leads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created DESC, rowid DESC LIMIT ? OFFSET ?`;
    return prep(sql).all(...vals).map((r) => unwrap('leads', r));
  }

  function countLeads({ stage = null } = {}) {
    return stage
      ? prep('SELECT COUNT(*) AS n FROM leads WHERE stage = ?').get(String(stage)).n
      : prep('SELECT COUNT(*) AS n FROM leads').get().n;
  }

  /* -------------------- touchpoints, stages -------------------- */

  function addTouchpoint(t) {
    const row = { ...t, id: t.id ?? newId('tp'), ts: toInt(t.ts ?? Date.now()) };
    insertRow('touchpoints', row);
    return unwrap('touchpoints', prep('SELECT * FROM touchpoints WHERE id = ?').get(row.id));
  }

  function touchpointsForLead(leadId, { limit = 500 } = {}) {
    return prep('SELECT * FROM touchpoints WHERE lead_id = ? ORDER BY ts ASC, rowid ASC LIMIT ?').all(String(leadId ?? ''), limit).map((r) => unwrap('touchpoints', r));
  }

  /**
   * Move a lead to a stage: one history row plus `stage`/`stage_ts` on the lead
   * (and `value_sar` when given). `actor` is `'owner'`, `'system'` or a name.
   */
  function setStage(leadId, stage, { actor = 'system', note = null, valueSar = undefined, now = Date.now() } = {}) {
    if (!STAGES.includes(stage)) throw new RangeError(`unknown stage ${stage}`);
    return transaction(() => {
      const lead = getLead(leadId);
      if (!lead) throw new RangeError(`unknown lead ${leadId}`);
      const patch = { stage, stage_ts: toInt(now), updated: toInt(now) };
      if (valueSar !== undefined && valueSar !== null) patch.value_sar = Number(valueSar);
      updateLead(leadId, patch);
      const row = { id: newId('st'), lead_id: String(leadId), stage, ts: toInt(now), actor: actor == null ? null : String(actor), note: note == null ? null : String(note) };
      prep('INSERT INTO lead_stage_history (id, lead_id, stage, ts, actor, note) VALUES (?,?,?,?,?,?)').run(row.id, row.lead_id, row.stage, row.ts, row.actor, row.note);
      return row;
    });
  }

  function stageHistory(leadId) {
    return prep('SELECT * FROM lead_stage_history WHERE lead_id = ? ORDER BY ts ASC, rowid ASC').all(String(leadId ?? '')).map((r) => ({ ...r }));
  }

  /* -------------------- fan-out queue -------------------- */

  /** @returns {number} rows actually queued (a destination already queued for this event is left alone) */
  function enqueueFanout(eventId, dests, { now = Date.now() } = {}) {
    let n = 0;
    for (const dest of dests) {
      if (!FANOUT_DESTS.includes(dest)) throw new RangeError(`unknown fan-out dest ${dest}`);
      n += prep('INSERT OR IGNORE INTO fanout (event_id, dest, status, attempts, next_at, last_error, response, ts) VALUES (?,?,\'pending\',0,?,NULL,NULL,?)')
        .run(String(eventId), dest, toInt(now), toInt(now)).changes;
    }
    return n;
  }

  function dueFanout(now = Date.now(), { limit = 100 } = {}) {
    return prep("SELECT * FROM fanout WHERE status = 'pending' AND next_at <= ? ORDER BY next_at ASC, rowid ASC LIMIT ?").all(toInt(now), limit).map((r) => ({ ...r }));
  }

  function markFanout(eventId, dest, { status, attempts = undefined, nextAt = undefined, lastError = undefined, response = undefined } = {}) {
    if (!FANOUT_STATUSES.includes(status)) throw new RangeError(`unknown fan-out status ${status}`);
    const sets = ['status = ?'];
    const vals = [status];
    if (attempts !== undefined) { sets.push('attempts = ?'); vals.push(toInt(attempts)); }
    if (nextAt !== undefined) { sets.push('next_at = ?'); vals.push(toInt(nextAt)); }
    if (lastError !== undefined) { sets.push('last_error = ?'); vals.push(lastError == null ? null : String(lastError).slice(0, 500)); }
    if (response !== undefined) { sets.push('response = ?'); vals.push(response == null ? null : String(response).slice(0, 2000)); }
    vals.push(String(eventId), dest);
    return prep(`UPDATE fanout SET ${sets.join(', ')} WHERE event_id = ? AND dest = ?`).run(...vals).changes === 1;
  }

  function fanoutCounts() {
    const out = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const r of prep('SELECT status, COUNT(*) AS n FROM fanout GROUP BY status').all()) if (r.status in out) out[r.status] = r.n;
    return out;
  }

  /* -------------------- dashboard auth -------------------- */

  function createAuthCode(code, { now = Date.now(), ttlMs = 10 * 60_000 } = {}) {
    prep('INSERT OR REPLACE INTO auth_codes (code_hash, created, expires, used, attempts) VALUES (?,?,?,0,0)').run(sha256(code), toInt(now), toInt(now + ttlMs));
    return { expires: now + ttlMs };
  }

  /**
   * Redeem a code. A wrong guess counts against every code still live, so five
   * misses burn the real one — a six-digit code is small enough to brute force
   * otherwise. Expired and used codes are swept as a side effect.
   * @returns {{ ok: boolean, reason?: 'unknown'|'expired'|'used'|'attempts' }}
   */
  function consumeAuthCode(code, { now = Date.now(), maxAttempts = 5 } = {}) {
    return transaction(() => {
      prep('DELETE FROM auth_codes WHERE expires < ?').run(toInt(now - 86_400_000));
      const row = prep('SELECT * FROM auth_codes WHERE code_hash = ?').get(sha256(code));
      if (!row) {
        prep('UPDATE auth_codes SET attempts = attempts + 1 WHERE used = 0 AND expires >= ?').run(toInt(now));
        return { ok: false, reason: 'unknown' };
      }
      if (row.used) return { ok: false, reason: 'used' };
      if (row.expires < now) return { ok: false, reason: 'expired' };
      if (row.attempts >= maxAttempts) return { ok: false, reason: 'attempts' };
      prep('UPDATE auth_codes SET used = 1 WHERE code_hash = ?').run(row.code_hash);
      return { ok: true };
    });
  }

  function createAuthSession(token, { now = Date.now(), ttlMs = 30 * 86_400_000, ua = null } = {}) {
    prep('INSERT OR REPLACE INTO auth_sessions (token_hash, created, expires, ua) VALUES (?,?,?,?)').run(sha256(token), toInt(now), toInt(now + ttlMs), ua == null ? null : String(ua).slice(0, 300));
    return { expires: now + ttlMs };
  }

  function checkAuthSession(token, { now = Date.now() } = {}) {
    if (!token) return null;
    const row = prep('SELECT * FROM auth_sessions WHERE token_hash = ?').get(sha256(token));
    if (!row) return null;
    if (row.expires < now) { prep('DELETE FROM auth_sessions WHERE token_hash = ?').run(row.token_hash); return null; }
    return { ...row };
  }

  const deleteAuthSession = (token) => prep('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token ?? '')).changes === 1;

  /* -------------------- WhatsApp poller state -------------------- */

  function waCursorGet(instance) {
    const row = prep('SELECT * FROM wa_cursor WHERE instance = ?').get(String(instance ?? ''));
    return row ? { ...row } : null;
  }

  function waCursorSet(instance, { lastTs = null, lastRun = null, unmatched = null } = {}) {
    prep(`INSERT INTO wa_cursor (instance, last_ts, last_run, unmatched) VALUES (?,?,?,?)
          ON CONFLICT(instance) DO UPDATE SET last_ts = COALESCE(excluded.last_ts, last_ts), last_run = COALESCE(excluded.last_run, last_run), unmatched = COALESCE(excluded.unmatched, unmatched)`)
      .run(String(instance), toInt(lastTs), toInt(lastRun), toInt(unmatched));
    return waCursorGet(instance);
  }

  const waSeenHas = (keyId) => Boolean(prep('SELECT 1 FROM wa_seen WHERE key_id = ?').get(String(keyId ?? '')));
  const waSeenAdd = (keyId, ts = Date.now()) => prep('INSERT OR IGNORE INTO wa_seen (key_id, ts) VALUES (?,?)').run(String(keyId), toInt(ts)).changes === 1;
  const pruneWaSeen = (beforeTs) => prep('DELETE FROM wa_seen WHERE ts < ?').run(toInt(beforeTs)).changes;

  /* -------------------- ad spend -------------------- */

  function upsertSpend({ day, platform, campaign_id = '', campaign_name = null, spend_sar = 0, clicks = null, impressions = null }) {
    prep(`INSERT INTO ad_spend (day, platform, campaign_id, campaign_name, spend_sar, clicks, impressions) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(day, platform, campaign_id) DO UPDATE SET campaign_name = excluded.campaign_name, spend_sar = excluded.spend_sar, clicks = excluded.clicks, impressions = excluded.impressions`)
      .run(String(day), String(platform), String(campaign_id ?? ''), campaign_name == null ? null : String(campaign_name), Number(spend_sar) || 0, toInt(clicks), toInt(impressions));
    return true;
  }

  function listSpend({ fromDay = null, toDay = null, platform = null } = {}) {
    const where = [];
    const vals = [];
    if (fromDay) { where.push('day >= ?'); vals.push(String(fromDay)); }
    if (toDay) { where.push('day <= ?'); vals.push(String(toDay)); }
    if (platform) { where.push('platform = ?'); vals.push(String(platform)); }
    return prep(`SELECT * FROM ad_spend ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY day ASC, platform ASC, campaign_id ASC`).all(...vals).map((r) => ({ ...r }));
  }

  /* -------------------- misc -------------------- */

  const ping = () => prep('SELECT 1 AS ok').get().ok === 1;

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    stmts.clear();
    try { db.close(); } catch { /* already closed */ }
  }

  return {
    db, file, dataDir: inMemory ? null : path.dirname(file), transaction, ping, close,
    upsertSession, getSession, getSessionByRef,
    insertEvent, getEvent, eventsForSession, recentEvents, setEventLead,
    insertLead, getLead, getLeadByPhone, getLeadByJid, getLeadByLegacyId, updateLead, listLeads, countLeads,
    addTouchpoint, touchpointsForLead, setStage, stageHistory,
    enqueueFanout, dueFanout, markFanout, fanoutCounts,
    createAuthCode, consumeAuthCode, createAuthSession, checkAuthSession, deleteAuthSession,
    waCursorGet, waCursorSet, waSeenHas, waSeenAdd, pruneWaSeen,
    upsertSpend, listSpend,
  };
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
