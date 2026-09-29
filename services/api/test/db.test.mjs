import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, newId, STAGES, FANOUT_DESTS, SCHEMA_VERSION, migrate } from '../lib/db.mjs';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-db-'));
  const file = path.join(dir, 'data', 'bona.db');
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const touch = (over = {}) => ({
  ts: 1757140000000, landing: '/properties/bona-w003/', referrer: 'https://l.instagram.com/',
  utm_source: 'meta', utm_medium: 'paid', utm_campaign: 'villas_sep', utm_content: 'reels', utm_term: null, utm_id: '1203',
  click_ids: { fbclid: 'IwAR1' }, ...over,
});

/* ---------------- opening, files, migrations ---------------- */

test('openDb creates an owner-only file inside an owner-only directory and migrates once', function (t) {
  const { file, cleanup } = tmp();
  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(a.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the database holds personal data');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  a.close();
  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'a second open is a no-op');
  const tables = b.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const name of ['sessions', 'events', 'leads', 'touchpoints', 'lead_stage_history', 'wa_cursor', 'wa_seen', 'ad_spend', 'fanout', 'auth_codes', 'auth_sessions', 'users', 'auth_challenges', 'audit_log', 'never_list', 'settings', 'wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps', 'inbox_candidates']) {
    assert.ok(tables.includes(name), name);
  }
  assert.equal(b.ping(), true);
  b.close();
  cleanup();
});

test('a v2-era file db upgrades to the current schema, an existing session survives with a null user_id, and reopening is a no-op', () => {
  // `migrate(db, { upTo })` runs the real migration chain only as far as asked, so the
  // file below is a genuine v2 database — every table v1 and v2 made, from the same SQL
  // start-up runs — not a hand-built imitation that could drift from it. (v4 alters
  // `leads` and reads `touchpoints`, so a file holding only `auth_sessions` would no
  // longer open at all.) `openDb` then applies the rest of the chain exactly as start-up
  // on the VPS does, including v3's bare `ALTER TABLE auth_sessions ADD COLUMN user_id`.
  const { file, cleanup } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = new DatabaseSync(file);
  migrate(seed, { upTo: 2 });
  assert.equal(seed.prepare('PRAGMA user_version').get().user_version, 2);
  seed.prepare('INSERT INTO auth_sessions (token_hash, created, expires, ua) VALUES (?,?,?,?)').run('deadbeef', 1000, 99_999_999_999, 'UA');
  seed.close();

  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'v3 onwards is applied on top of the v2 file');
  const row = a.db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get('deadbeef');
  assert.ok(row, 'the pre-existing session row survives the migration');
  assert.equal(row.user_id, null, 'a session opened before user accounts existed has no user');
  a.close();

  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'reopening an up-to-date file is a no-op');
  b.close();
  cleanup();
});

test('schema v4 gives leads their inbox columns and adds the transcript, outbox, read-mark, gap and candidate tables', () => {
  const s = openDb(':memory:');
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(s.db.prepare('PRAGMA user_version').get().user_version, 4);
  const info = (table) => s.db.prepare(`PRAGMA table_info(${table})`).all();
  const names = (table) => info(table).map((c) => c.name);
  const leadCols = info('leads');
  assert.deepEqual(leadCols.slice(-5).map((c) => c.name), ['inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human']);
  const needsHuman = leadCols.find((c) => c.name === 'needs_human');
  assert.equal(needsHuman.notnull, 1);
  assert.equal(needsHuman.dflt_value, '0');
  assert.deepEqual(names('wa_messages'), ['key_id', 'lead_id', 'jid', 'direction', 'sender_kind', 'sender_user_id', 'text', 'media_type', 'ts', 'status']);
  assert.deepEqual(names('wa_outbox'), ['send_id', 'lead_id', 'jid', 'text', 'user_id', 'sender_kind', 'status', 'key_id', 'created', 'updated', 'error']);
  assert.deepEqual(names('inbox_reads'), ['user_id', 'lead_id', 'last_read_ts']);
  assert.deepEqual(names('wa_gaps'), ['key_id', 'lead_id', 'jid', 'ts', 'reason']);
  assert.deepEqual(names('inbox_candidates'), ['cand_id', 'jid', 'lid', 'phone_e164', 'name', 'first_ts', 'last_ts', 'hits', 'words', 'last_dir', 'state', 'updated']);
  assert.ok(!names('inbox_candidates').some((c) => /text|snippet|body/.test(c)), 'a candidate never holds what was written');
  const indexes = new Set(s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  for (const name of ['leads_inbox', 'wa_messages_lead', 'wa_outbox_key', 'wa_outbox_lead', 'wa_outbox_created', 'wa_gaps_lead', 'inbox_candidates_state']) assert.ok(indexes.has(name), name);
  s.close();
});

test('the v4 CHECKs refuse an inbox state, direction, sender, outbox status or missing key the inbox never writes, a sender on the wrong side, and a login code\'s text', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1 });
  assert.equal(s.getLead('L1').inbox_state, null, 'undecided until a rule or the owner decides');
  assert.equal(s.getLead('L1').needs_human, 0, 'nobody has asked for a human yet');
  for (const state of ['in', 'unsure', 'out']) assert.equal(s.updateLead('L1', { inbox_state: state }), true, state);
  assert.throws(() => s.updateLead('L1', { inbox_state: 'maybe' }), /CHECK/);
  assert.throws(() => s.updateLead('L1', { needs_human: 2 }), /CHECK/);
  assert.throws(() => s.updateLead('L1', { needs_human: null }), /NOT NULL/);

  const msg = s.db.prepare('INSERT INTO wa_messages (key_id, lead_id, direction, sender_kind, ts) VALUES (?,?,?,?,?)');
  msg.run('K-client', 'L1', 'in', 'client', 10);
  for (const kind of ['staff', 'dana', 'owner_number']) msg.run(`K-${kind}`, 'L1', 'out', kind, 11);
  assert.throws(() => msg.run('K-2', 'L1', 'sideways', 'client', 12), /CHECK/);
  assert.throws(() => msg.run('K-3', 'L1', 'out', 'owner', 12), /CHECK/);
  assert.throws(() => msg.run('K-4', 'L1', 'in', 'client', null), /NOT NULL/, 'a message always has a time');
  assert.throws(() => msg.run('K-client', 'L1', 'in', 'client', 13), /UNIQUE/, 'one row per WhatsApp message id');
  // A TEXT PRIMARY KEY on a rowid table takes NULL — several at once — unless NOT NULL says otherwise.
  assert.throws(() => msg.run(null, 'L1', 'in', 'client', 14), /NOT NULL/, 'a message always has its WhatsApp id');
  // Only the client writes in; only the owner's side (a team member, Dana, the owner's phone) writes out.
  for (const [dir, kind] of [['in', 'staff'], ['in', 'dana'], ['in', 'owner_number'], ['out', 'client']]) {
    assert.throws(() => msg.run(`K-${dir}-${kind}`, 'L1', dir, kind, 15), /CHECK/, `${dir} from ${kind}`);
  }
  assert.throws(() => s.db.prepare("UPDATE wa_messages SET sender_kind = 'staff' WHERE key_id = 'K-client'").run(), /CHECK/, 'a stored message cannot change sides');

  const out = s.db.prepare('INSERT INTO wa_outbox (send_id, jid, sender_kind, status, created, updated) VALUES (?,?,?,?,?,?)');
  for (const kind of ['staff', 'dana', 'code', 'note']) out.run(`S-${kind}`, '966500000001@s.whatsapp.net', kind, 'pending', 1, 1);
  for (const status of ['accepted', 'failed', 'uncertain']) out.run(`S-${status}`, '966500000001@s.whatsapp.net', 'staff', status, 1, 1);
  assert.throws(() => out.run('S-x', '966500000001@s.whatsapp.net', 'client', 'pending', 1, 1), /CHECK/);
  assert.throws(() => out.run('S-y', '966500000001@s.whatsapp.net', 'staff', 'sent', 1, 1), /CHECK/);
  assert.throws(() => out.run('S-z', null, 'staff', 'pending', 1, 1), /NOT NULL/, 'a send always names its recipient');
  assert.throws(() => out.run(null, '966500000001@s.whatsapp.net', 'staff', 'pending', 1, 1), /NOT NULL/, 'a send always has its id');
  // A login code is only ever hashed (auth_challenges.code_hash): its outbox row can never
  // hold the text, whether it is written with it or given it later.
  const outText = s.db.prepare('INSERT INTO wa_outbox (send_id, jid, text, sender_kind, status, created, updated) VALUES (?,?,?,?,?,?,?)');
  outText.run('S-code-blank', '966500000001@s.whatsapp.net', null, 'code', 'pending', 1, 1);
  for (const kind of ['staff', 'dana', 'note']) outText.run(`S-${kind}-text`, '966500000001@s.whatsapp.net', 'hello', kind, 'pending', 1, 1);
  assert.throws(() => outText.run('S-code-text', '966500000001@s.whatsapp.net', '123456', 'code', 'pending', 1, 1), /CHECK/);
  assert.throws(() => s.db.prepare("UPDATE wa_outbox SET text = '123456' WHERE send_id = 'S-code-blank'").run(), /CHECK/);
  assert.throws(() => s.db.prepare("UPDATE wa_outbox SET sender_kind = 'code' WHERE send_id = 'S-staff-text'").run(), /CHECK/);

  const gap = s.db.prepare('INSERT INTO wa_gaps (key_id, lead_id, ts, reason) VALUES (?,?,?,?)');
  gap.run('G-1', 'L1', 1, 'failed');
  assert.throws(() => gap.run(null, 'L1', 2, 'failed'), /NOT NULL/, 'a gap always names the message it stands for');

  const read = s.db.prepare('INSERT INTO inbox_reads (user_id, lead_id, last_read_ts) VALUES (?,?,?)');
  read.run('USR-1', 'L1', 5);
  read.run('USR-2', 'L1', 6);
  assert.throws(() => read.run('USR-1', 'L1', 7), /UNIQUE/, 'one read mark per person per chat');

  const cand = s.db.prepare('INSERT INTO inbox_candidates (cand_id, jid, lid, phone_e164, first_ts, last_ts, last_dir, state, updated) VALUES (?,?,?,?,?,?,?,?,?)');
  cand.run('CND-1', '966500000001@s.whatsapp.net', null, '966500000001', 1, 1, 'in', 'open', 1);
  cand.run('CND-2', null, '111@lid', null, 1, 1, 'out', 'dismissed', 1);
  cand.run('CND-3', null, null, '966500000003', 1, 1, null, 'open', 1);
  cand.run('CND-4', null, null, null, 1, 1, null, 'open', 1);
  cand.run('CND-5', null, null, null, 1, 1, null, 'open', 1);
  assert.equal(s.db.prepare("SELECT hits FROM inbox_candidates WHERE cand_id = 'CND-1'").get().hits, 1, 'a new row is one message');
  assert.throws(() => cand.run('CND-6', null, null, '966500000001', 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per number');
  assert.throws(() => cand.run('CND-7', '966500000001@s.whatsapp.net', null, null, 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per jid');
  assert.throws(() => cand.run('CND-8', null, '111@lid', null, 1, 1, 'in', 'open', 1), /UNIQUE/, 'one row per lid');
  assert.throws(() => cand.run('CND-9', null, null, null, 1, 1, 'sideways', 'open', 1), /CHECK/);
  assert.throws(() => cand.run('CND-10', null, null, null, 1, 1, 'in', 'maybe', 1), /CHECK/);
  assert.throws(() => cand.run(null, null, null, null, 1, 1, 'in', 'open', 1), /NOT NULL/, 'a candidate always has its id');
  assert.throws(() => cand.run('CND-11', null, null, null, null, 1, 'in', 'open', 1), /NOT NULL/);
  assert.throws(() => cand.run('CND-12', null, null, null, 1, 1, 'in', 'open', null), /NOT NULL/);
  s.close();
});

test('a v3 file db moves to v4: each existing lead is placed by what is certain about it, nothing else changes, and reopening is a no-op', () => {
  const { file, cleanup } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = new DatabaseSync(file);
  migrate(seed, { upTo: 3 });
  assert.equal(seed.prepare('PRAGMA user_version').get().user_version, 3);
  assert.ok(!seed.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'inbox_state'), 'a genuine v3 file: no inbox columns yet');

  // One lead per P2-13 rule. Each gets the lead_created touchpoint lib/leads.mjs writes,
  // with `snippet` as its first message; `meta` replaces that JSON (a legacy import's),
  // `rawMeta` replaces the stored text outright (a broken row, or NULL), `later` adds a
  // second, non-creation touchpoint whose snippet must not count, `noTouchpoint` leaves
  // the lead without its lead_created touchpoint. Only a snippet that is a string counts:
  // json_extract hands back an object or array as its JSON text, which a GLOB would match.
  const cases = [
    { id: 'L-ref', channel: 'whatsapp', method: 'ref', snippet: 'Hello\nRef K7Q2XR', want: 'in' },
    { id: 'L-ad', channel: 'whatsapp', method: 'ad_meta', snippet: 'Hi', want: 'in' },
    { id: 'L-form', channel: 'form', method: 'form', want: 'in' },
    { id: 'L-chat', channel: 'concierge_chat', method: 'concierge', want: 'in' },
    { id: 'L-voice', channel: 'concierge_voice', method: 'concierge', want: 'in' },
    { id: 'L-old-form', channel: 'form', method: 'form', legacy: 'lead-2025-017', meta: { legacy_id: 'lead-2025-017', conversation_id: null, page: null }, want: 'unsure' },
    { id: 'L-old-chat', channel: 'concierge_chat', method: 'concierge', legacy: 'lead-2025-018', meta: { legacy_id: 'lead-2025-018', conversation_id: null, page: null }, want: 'unsure' },
    { id: 'L-kw-id', channel: 'whatsapp', method: 'keyword', snippet: 'Is BONA-W003 still available?', want: 'in' },
    { id: 'L-kw-id-ar', channel: 'whatsapp', method: 'keyword', snippet: 'السلام عليكم، أبغى تفاصيل bona-012', want: 'in' },
    { id: 'L-kw-word', channel: 'whatsapp', method: 'keyword', snippet: 'I saw Bona on Instagram', later: 'and BONA-W009?', want: 'unsure' },
    { id: 'L-tw', channel: 'whatsapp', method: 'time_window', snippet: 'Hello', want: 'unsure' },
    { id: 'L-tw-id', channel: 'whatsapp', method: 'time_window', snippet: 'Hello, BONA-W021 please', want: 'in' },
    { id: 'L-bad-json', channel: 'whatsapp', method: 'keyword', rawMeta: '{"snippet": "BONA-W003"', want: 'unsure' },
    { id: 'L-null-meta', channel: 'whatsapp', method: 'keyword', rawMeta: null, want: 'unsure' },
    { id: 'L-obj-snippet', channel: 'whatsapp', method: 'keyword', meta: { snippet: { text: 'BONA-W003' } }, want: 'unsure' },
    { id: 'L-arr-snippet', channel: 'whatsapp', method: 'time_window', meta: { snippet: ['BONA-012'] }, want: 'unsure' },
    { id: 'L-no-tp', channel: 'whatsapp', method: 'keyword', noTouchpoint: true, want: 'unsure' },
    { id: 'L-manual', channel: 'manual', method: 'phone', snippet: 'Called about the villas', want: 'unsure' },
    { id: 'L-ref-legacy', channel: 'whatsapp', method: 'ref', legacy: 'lead-2025-019', snippet: 'Ref K7Q2XR', want: 'in' },
  ];
  const T0 = 1_757_140_000_000;
  const createdOf = (i) => T0 + i * 1000;
  const insLead = seed.prepare('INSERT INTO leads (lead_id, created, updated, channel, match_method, legacy_id, stage, first_reply_ts) VALUES (?,?,?,?,?,?,?,?)');
  const insTp = seed.prepare('INSERT INTO touchpoints (id, lead_id, ts, channel, event_type, meta) VALUES (?,?,?,?,?,?)');
  cases.forEach((c, i) => {
    insLead.run(c.id, createdOf(i), createdOf(i) + 1, c.channel, c.method, c.legacy ?? null, 'new', i % 2 ? createdOf(i) + 60_000 : null);
    const meta = 'rawMeta' in c ? c.rawMeta
      : JSON.stringify(c.meta ?? { match_method: c.method, ref: null, session_id: null, event_id: null, ad_meta: null, snippet: c.snippet ?? null });
    if (!c.noTouchpoint) insTp.run(`tp-${c.id}`, c.id, createdOf(i), c.channel, 'lead_created', meta);
    if (c.later) insTp.run(`tp-${c.id}-2`, c.id, createdOf(i) + 5000, c.channel, 'inbound_message', JSON.stringify({ snippet: c.later }));
  });
  const snapshot = (db) => db.prepare('SELECT * FROM leads ORDER BY lead_id').all().map((r) => ({ ...r }));
  const countOf = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const before = snapshot(seed);
  const touchpointsBefore = countOf(seed, 'touchpoints');
  seed.close();

  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const added = ['inbox_state', 'inbox_since', 'handler_user_id', 'last_msg_ts', 'needs_human'];
  const after = snapshot(a.db);
  assert.equal(after.length, before.length, 'no lead is added or lost');
  assert.equal(countOf(a.db, 'touchpoints'), touchpointsBefore);
  assert.deepEqual(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !added.includes(k)))), before, 'every v3 column is untouched');
  cases.forEach((c, i) => {
    const row = a.getLead(c.id);
    assert.equal(row.inbox_state, c.want, c.id);
    assert.equal(row.inbox_since, c.want === 'in' ? createdOf(i) : null, `${c.id}: in since the lead was created, and only if in`);
    assert.equal(row.needs_human, 0, c.id);
    assert.equal(row.handler_user_id, null, c.id);
    assert.equal(row.last_msg_ts, null, c.id);
  });
  for (const table of ['wa_messages', 'wa_outbox', 'inbox_reads', 'wa_gaps', 'inbox_candidates']) assert.equal(countOf(a.db, table), 0, table);

  // The owner moves one guess in and rules one certain lead out. Reopening must not run
  // the v4 placement again and undo either.
  a.updateLead('L-kw-word', { inbox_state: 'in', inbox_since: T0 + 99_000 });
  a.updateLead('L-ref', { inbox_state: 'out', inbox_since: null });
  a.close();
  const b = openDb(file);
  assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'reopening an up-to-date file is a no-op');
  assert.equal(b.getLead('L-kw-word').inbox_state, 'in');
  assert.equal(b.getLead('L-kw-word').inbox_since, T0 + 99_000);
  assert.equal(b.getLead('L-ref').inbox_state, 'out');
  assert.equal(b.getLead('L-ref').inbox_since, null);
  b.close();
  cleanup();
});

test('a v4 step that fails part-way leaves a clean v3 file, and a retry upgrades it', () => {
  // v4 is several statements (ALTERs, CREATEs, then two UPDATEs over existing leads). If
  // the last of them fails, the ALTERs and CREATEs before it must go too — a half-migrated
  // file at user_version 3 would crash the retry on "duplicate column". The trigger makes
  // the placement UPDATE fail after every ALTER and CREATE has already run.
  const { file, cleanup } = tmp();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const seed = new DatabaseSync(file);
  migrate(seed, { upTo: 3 });
  const insLead = seed.prepare('INSERT INTO leads (lead_id, created, updated, channel, match_method) VALUES (?,?,?,?,?)');
  const insTp = seed.prepare('INSERT INTO touchpoints (id, lead_id, ts, channel, event_type, meta) VALUES (?,?,?,?,?,?)');
  insLead.run('L-ref', 1000, 1001, 'whatsapp', 'ref');
  insTp.run('tp-ref', 'L-ref', 1000, 'whatsapp', 'lead_created', JSON.stringify({ snippet: 'Hello\nRef K7Q2XR' }));
  insLead.run('L-kw', 2000, 2001, 'whatsapp', 'keyword');
  insTp.run('tp-kw', 'L-kw', 2000, 'whatsapp', 'lead_created', JSON.stringify({ snippet: 'I saw Bona on Instagram' }));
  seed.exec("CREATE TRIGGER t BEFORE UPDATE ON leads BEGIN SELECT RAISE(ABORT,'x'); END");
  seed.close();

  assert.throws(() => openDb(file), { message: 'x' }, 'the v4 placement UPDATE hits the trigger');
  // SQLite deletes the WAL file when the last connection to the file closes, so a WAL
  // file left behind means the failed open kept its handle.
  assert.equal(fs.existsSync(`${file}-wal`), false, 'a failed open closes the connection it opened');

  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3, 'still v3');
  assert.ok(!check.prepare('PRAGMA table_info(leads)').all().some((c) => c.name === 'inbox_state'), 'the ALTERs were rolled back');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'wa_messages'").get().n, 0, 'the CREATEs were rolled back');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'inbox_candidates'").get().n, 0, 'the candidates table too');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 2, 'no lead lost');
  check.exec('DROP TRIGGER t');
  check.close();

  const a = openDb(file);
  assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, 'the retry upgrades the file');
  assert.equal(a.getLead('L-ref').inbox_state, 'in');
  assert.equal(a.getLead('L-ref').inbox_since, 1000);
  assert.equal(a.getLead('L-kw').inbox_state, 'unsure');
  assert.equal(a.getLead('L-kw').inbox_since, null);
  a.close();
  cleanup();
});

test('insertLead and updateLead carry the inbox columns', () => {
  const s = openDb(':memory:');
  const l = s.insertLead({
    lead_id: 'L1', created: 1, updated: 1, wa_jid: '966500000001@s.whatsapp.net',
    inbox_state: 'in', inbox_since: 1, handler_user_id: 'USR-1', last_msg_ts: 7, needs_human: true,
  });
  assert.deepEqual([l.inbox_state, l.inbox_since, l.handler_user_id, l.last_msg_ts, l.needs_human], ['in', 1, 'USR-1', 7, 1]);
  assert.equal(s.updateLead('L1', { inbox_state: 'out', inbox_since: null, handler_user_id: null, last_msg_ts: null, needs_human: false }), true);
  const after = s.getLead('L1');
  assert.deepEqual([after.inbox_state, after.inbox_since, after.handler_user_id, after.last_msg_ts, after.needs_human], ['out', null, null, null, 0]);
  s.close();
});

test('newId is prefix, base-36 time and four hex characters', () => {
  const id = newId('ev');
  assert.match(id, /^ev-[0-9a-z]{6,10}-[0-9a-f]{4}$/);
  assert.notEqual(id, newId('ev'));
  assert.deepEqual(STAGES, ['new', 'contacted', 'qualified', 'viewing', 'offer', 'negotiation', 'won', 'lost']);
  assert.deepEqual(FANOUT_DESTS, ['meta', 'ga4', 'snap', 'tiktok']);
});

/* ---------------- sessions ---------------- */

test('a session keeps its first touch and moves its last touch, count and consent', () => {
  const s = openDb(':memory:');
  const first = touch();
  s.upsertSession({
    session_id: 'mf3k2a-7b1c', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: 1000, last_seen: 1000, pages: 1, locale: 'en',
    first_touch: first, last_touch: first, fbp: 'fb.1.1', fbc: 'fb.1.2', ga_client_id: '1.2', ga_session_id: '3',
    ip: '1.2.3.4', ua: 'UA', country: 'SA', consent_analytics: false, consent_ads: false,
  });
  const later = touch({ ts: 2000, utm_campaign: 'villas_oct', referrer: 'https://www.google.com/' });
  s.upsertSession({ session_id: 'mf3k2a-7b1c', anon_id: 'a'.repeat(32), started: 2000, last_seen: 2000, pages: 1, last_touch: later, consent_analytics: true, consent_ads: true, ua: 'UA2' });
  const row = s.getSession('mf3k2a-7b1c');
  assert.equal(row.started, 1000, 'the start never moves');
  assert.equal(row.last_seen, 2000);
  assert.equal(row.pages, 2, 'pages count up');
  assert.deepEqual(row.first_touch, first, 'first touch is never overwritten');
  assert.deepEqual(row.last_touch, later);
  assert.equal(row.consent_analytics, 1);
  assert.equal(row.consent_ads, 1);
  assert.equal(row.ref, 'K7Q2XR');
  assert.equal(row.fbp, 'fb.1.1', 'ids the second call did not send are kept');
  assert.equal(row.ua, 'UA2', 'ids the second call did send are updated');
  assert.equal(s.getSessionByRef('k7q2xr').session_id, 'mf3k2a-7b1c', 'ref lookup is case-blind');
  assert.equal(s.getSession('nope'), null);
  assert.equal(s.getSessionByRef('ZZZZZZ'), null);
  s.close();
});

test('a ref that another session already owns is not stolen — the newer session simply has none', () => {
  const s = openDb(':memory:');
  s.upsertSession({ session_id: 'first0', anon_id: 'a'.repeat(32), ref: 'K7Q2XR', started: 1, last_seen: 1 });
  s.upsertSession({ session_id: 'second', anon_id: 'b'.repeat(32), ref: 'K7Q2XR', started: 2, last_seen: 2 });
  assert.equal(s.getSession('second').ref, null);
  assert.equal(s.getSessionByRef('K7Q2XR').session_id, 'first0');
  // …and a session that had no ref picks one up on a later call.
  s.upsertSession({ session_id: 'second', anon_id: 'b'.repeat(32), ref: 'ABCDEF', started: 3, last_seen: 3 });
  assert.equal(s.getSession('second').ref, 'ABCDEF');
  s.close();
});

/* ---------------- events ---------------- */

test('events insert once per event_id and can be read back by session, by name and by time', () => {
  const s = openDb(':memory:');
  const base = { anon_id: 'a'.repeat(32), session_id: 'sess-1', listing_id: 'BONA-W003', path: '/p/', props: { cta: 'x' }, src_first: touch(), src_last: touch(), ip: '1.1.1.1', ua: 'UA', country: 'SA' };
  assert.equal(s.insertEvent({ event_id: 'ev-1', ts: 100, name: 'page_view', ...base }), true);
  assert.equal(s.insertEvent({ event_id: 'ev-1', ts: 100, name: 'page_view', ...base }), false, 'a retry is ignored');
  assert.equal(s.insertEvent({ event_id: 'ev-2', ts: 200, name: 'whatsapp_click', ...base }), true);
  assert.equal(s.insertEvent({ event_id: 'ev-3', ts: 300, name: 'whatsapp_click', ...base, session_id: 'sess-2' }), true);
  const forSession = s.eventsForSession('sess-1');
  assert.deepEqual(forSession.map((e) => e.event_id), ['ev-1', 'ev-2']);
  assert.deepEqual(forSession[0].props, { cta: 'x' });
  assert.equal(forSession[0].src_last.utm_campaign, 'villas_sep');
  assert.deepEqual(s.recentEvents({ name: 'whatsapp_click', sinceTs: 150, untilTs: 250 }).map((e) => e.event_id), ['ev-2']);
  assert.deepEqual(s.recentEvents({ name: 'whatsapp_click', sinceTs: 0 }).map((e) => e.event_id), ['ev-3', 'ev-2'], 'newest first');
  assert.equal(s.getEvent('ev-2').name, 'whatsapp_click');
  assert.equal(s.getEvent('nope'), null);
  s.close();
});

/* ---------------- leads ---------------- */

test('leads round-trip, are found by phone or jid, and update without losing fields', () => {
  const s = openDb(':memory:');
  const lead = s.insertLead({
    lead_id: 'LEAD-20260906-abcd1234', created: 1, updated: 1, phone_e164: '966593296933', wa_jid: '966593296933@s.whatsapp.net', wa_lid: '1234@lid',
    name: 'Sara', channel: 'whatsapp', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', content: 'reels',
    click_ids: { fbclid: 'x' }, ref: 'K7Q2XR', match_method: 'ref', session_id: 'sess-1', anon_id: 'a'.repeat(32), listing_id: 'BONA-W003',
    first_touch: touch(), last_touch: touch(), interest: 'villa', budget: '8m', timeline: 'soon', district: 'Al Shati', language: 'ar', notes: 'evenings',
    stage: 'new', stage_ts: 1, consent_ads: true, consent_analytics: true,
  });
  assert.equal(lead.lead_id, 'LEAD-20260906-abcd1234');
  assert.deepEqual(s.getLead('LEAD-20260906-abcd1234').click_ids, { fbclid: 'x' });
  assert.equal(s.getLeadByPhone('966593296933').name, 'Sara');
  assert.equal(s.getLeadByPhone('0593296933'), null, 'callers normalise before they ask');
  assert.equal(s.getLeadByJid('966593296933@s.whatsapp.net').name, 'Sara');
  assert.equal(s.getLeadByJid('1234@lid').name, 'Sara', 'the lid alias finds the same person');
  assert.equal(s.getLeadByJid('nope@lid'), null);
  s.updateLead('LEAD-20260906-abcd1234', { budget: '9m', updated: 5, not_a_column: 'x' });
  const after = s.getLead('LEAD-20260906-abcd1234');
  assert.equal(after.budget, '9m');
  assert.equal(after.name, 'Sara');
  assert.equal(after.updated, 5);
  assert.throws(() => s.insertLead({ lead_id: 'LEAD-2', phone_e164: '966593296933', created: 2, updated: 2 }), /UNIQUE/, 'one phone, one lead');
  s.close();
});

test('listLeads filters by stage and by a search term', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1, phone_e164: '966500000001', name: 'Sara Ahmed', stage: 'new', stage_ts: 1 });
  s.insertLead({ lead_id: 'L2', created: 2, updated: 2, phone_e164: '966500000002', name: 'Omar', stage: 'viewing', stage_ts: 2, notes: 'wants Al Shati' });
  s.insertLead({ lead_id: 'L3', created: 3, updated: 3, wa_jid: 'x@lid', name: 'Nobody', stage: 'lost', stage_ts: 3 });
  assert.deepEqual(s.listLeads().map((l) => l.lead_id), ['L3', 'L2', 'L1'], 'newest first');
  assert.deepEqual(s.listLeads({ stage: 'viewing' }).map((l) => l.lead_id), ['L2']);
  assert.deepEqual(s.listLeads({ q: 'shati' }).map((l) => l.lead_id), ['L2']);
  assert.deepEqual(s.listLeads({ q: '0000001' }).map((l) => l.lead_id), ['L1']);
  assert.deepEqual(s.listLeads({ limit: 1 }).map((l) => l.lead_id), ['L3']);
  s.close();
});

test('touchpoints and stage history accumulate on a lead', () => {
  const s = openDb(':memory:');
  s.insertLead({ lead_id: 'L1', created: 1, updated: 1, phone_e164: '966500000001', stage: 'new', stage_ts: 1 });
  const tp = s.addTouchpoint({ lead_id: 'L1', ts: 10, channel: 'whatsapp', event_type: 'lead_created', source: 'meta', medium: 'paid', campaign: 'villas_sep', campaign_id: '1203', listing_id: 'BONA-W003', meta: { ref: 'K7Q2XR' } });
  assert.match(tp.id, /^tp-/);
  s.addTouchpoint({ id: 'tp-custom', lead_id: 'L1', ts: 20, channel: 'whatsapp', event_type: 'inbound_message' });
  const tps = s.touchpointsForLead('L1');
  assert.deepEqual(tps.map((t) => t.event_type), ['lead_created', 'inbound_message']);
  assert.deepEqual(tps[0].meta, { ref: 'K7Q2XR' });

  const h = s.setStage('L1', 'viewing', { actor: 'owner', note: 'Sat 4pm', now: 30 });
  assert.equal(h.stage, 'viewing');
  s.setStage('L1', 'won', { actor: 'owner', valueSar: 6700000, now: 40 });
  const lead = s.getLead('L1');
  assert.equal(lead.stage, 'won');
  assert.equal(lead.stage_ts, 40);
  assert.equal(lead.value_sar, 6700000);
  assert.equal(lead.updated, 40);
  assert.deepEqual(s.stageHistory('L1').map((r) => [r.stage, r.actor, r.note]), [['viewing', 'owner', 'Sat 4pm'], ['won', 'owner', null]]);
  assert.throws(() => s.setStage('L1', 'closed', {}), /stage/);
  assert.throws(() => s.setStage('nope', 'won', {}), /lead/);
  s.close();
});

/* ---------------- fan-out ---------------- */

test('fan-out rows are queued once per destination, come due in order, and record their outcome', () => {
  const s = openDb(':memory:');
  assert.equal(s.enqueueFanout('ev-1', ['meta', 'ga4', 'snap'], { now: 100 }), 3);
  assert.equal(s.enqueueFanout('ev-1', ['meta'], { now: 100 }), 0, 'already queued');
  assert.throws(() => s.enqueueFanout('ev-2', ['pinterest']), /dest/);
  assert.equal(s.dueFanout(99).length, 0, 'nothing is due before it was queued');
  assert.deepEqual(s.dueFanout(100).map((r) => r.dest), ['meta', 'ga4', 'snap']);
  s.markFanout('ev-1', 'meta', { status: 'sent', attempts: 1, response: '{"events_received":1}' });
  s.markFanout('ev-1', 'ga4', { status: 'pending', attempts: 1, nextAt: 5000, lastError: 'http_500' });
  s.markFanout('ev-1', 'snap', { status: 'skipped', attempts: 0, lastError: 'no_consent' });
  assert.deepEqual(s.dueFanout(100), []);
  const retry = s.dueFanout(5000);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].dest, 'ga4');
  assert.equal(retry[0].attempts, 1);
  assert.equal(retry[0].last_error, 'http_500');
  assert.deepEqual(s.fanoutCounts(), { pending: 1, sent: 1, failed: 0, skipped: 1 });
  assert.throws(() => s.markFanout('ev-1', 'ga4', { status: 'lost' }), /status/);
  s.close();
});

/* ---------------- dashboard auth ---------------- */

test('a dashboard session is checked by token hash and can be deleted or expire', () => {
  const s = openDb(':memory:');
  s.createAuthSession('tok_secret', { now: 1000, ttlMs: 30 * 86_400_000, ua: 'UA', userId: 'USR-1' });
  assert.equal(s.checkAuthSession('tok_secret', { now: 2000 }).ua, 'UA');
  assert.equal(s.checkAuthSession('tok_other', { now: 2000 }), null);
  assert.equal(s.checkAuthSession('tok_secret', { now: 1000 + 31 * 86_400_000 }), null, 'expired');
  s.createAuthSession('tok_two', { now: 1000, ttlMs: 1000, userId: 'USR-1' });
  assert.throws(() => s.createAuthSession('tok_three', { now: 1000, ttlMs: 1000 }), /userId/, 'a session always names its person');
  assert.equal(s.deleteAuthSession('tok_two'), true);
  assert.equal(s.deleteAuthSession('tok_two'), false);
  assert.ok(!s.db.prepare('SELECT token_hash FROM auth_sessions').all().some((r) => r.token_hash.includes('tok_')), 'tokens are stored hashed');
  s.close();
});

/* ---------------- WhatsApp poller state, spend ---------------- */

test('the poller cursor and the seen-set persist, and old keys are pruned', () => {
  const s = openDb(':memory:');
  assert.equal(s.waCursorGet('abdulaziz-personal'), null);
  s.waCursorSet('abdulaziz-personal', { lastTs: 100, lastRun: 110, unmatched: 3 });
  s.waCursorSet('abdulaziz-personal', { lastTs: 200, lastRun: 210, unmatched: 4 });
  assert.deepEqual(s.waCursorGet('abdulaziz-personal'), { instance: 'abdulaziz-personal', last_ts: 200, last_run: 210, unmatched: 4 });
  assert.equal(s.waSeenHas('k1'), false);
  assert.equal(s.waSeenAdd('k1', 100), true);
  assert.equal(s.waSeenAdd('k1', 100), false);
  s.waSeenAdd('k2', 500);
  assert.equal(s.waSeenHas('k1'), true);
  assert.equal(s.pruneWaSeen(300), 1);
  assert.equal(s.waSeenHas('k1'), false);
  assert.equal(s.waSeenHas('k2'), true);
  s.close();
});

test('ad spend upserts per day, platform and campaign', () => {
  const s = openDb(':memory:');
  s.upsertSpend({ day: '2026-09-01', platform: 'meta', campaign_id: '1203', campaign_name: 'villas_sep', spend_sar: 100, clicks: 10, impressions: 1000 });
  s.upsertSpend({ day: '2026-09-01', platform: 'meta', campaign_id: '1203', campaign_name: 'villas_sep', spend_sar: 120, clicks: 12, impressions: 1200 });
  s.upsertSpend({ day: '2026-09-02', platform: 'snap', campaign_id: 's1', campaign_name: 'snap_sep', spend_sar: 50, clicks: 5, impressions: 500 });
  const all = s.listSpend();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.platform === 'meta').spend_sar, 120, 'the later entry replaces the earlier one');
  assert.deepEqual(s.listSpend({ fromDay: '2026-09-02' }).map((r) => r.platform), ['snap']);
  assert.deepEqual(s.listSpend({ platform: 'meta' }).map((r) => r.day), ['2026-09-01']);
  s.close();
});
