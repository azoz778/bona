/**
 * PR-A2 (PLAN T07; DESIGN §2, §3.2; DESIGN-brain §10): the owner's test switch, the per-lead
 * auto mode, the `#dana …` owner commands and the test switch's lifecycle. Real store, real
 * team, real inbox store and audit log; the identity guard, the notes, the viewing module and
 * the brain are fakes, and the clock is injected. Nothing leaves the process.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, learnTeamLid } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { waConfig } from '../lib/wa.mjs';
import {
  createOwnerTest, parseCommand, COMMANDS, COMMAND_MAX_AGE_MS, COMMAND_HEADER, DANA_COMMAND_RE, isDanaCommandText,
} from '../lib/owner-test.mjs';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const MIN = 60_000;
/** The owner (BONA_OWNER_JID), Bona's own number (BONA_WA_INSTANCE_JID), a colleague, a client: test numbers only. */
const OWNER = '966500000010';
const OWNER_JID = `${OWNER}@s.whatsapp.net`;
const OWNER_LID = '100000000000010@lid';
const INSTANCE = '966500000020';
const INSTANCE_JID = `${INSTANCE}@s.whatsapp.net`;
const COLLEAGUE = '966500000030';
const CLIENT = '966500000040';
const CLIENT_JID = `${CLIENT}@s.whatsapp.net`;
const CLIENT_LID = '100000000000040@lid';
const OWNER_LEAD = 'LEAD-20261127-0000owner';

const ENV = { BONA_OWNER_JID: OWNER_JID, BONA_WA_INSTANCE: 'bona2', BONA_WA_INSTANCE_JID: INSTANCE_JID };

/** Every number, lid and name these tests use. None may reach a log line. */
const PERSONAL = [OWNER, INSTANCE, COLLEAGUE, CLIENT, '100000000000010', '100000000000040', 'Owner Example', 'Colleague Example'];
function assertClean(logs) {
  const out = JSON.stringify(logs);
  for (const needle of PERSONAL) assert.equal(out.includes(needle), false, 'a log line carries personal data');
  assert.equal(/#dana/i.test(out), false, 'a log line carries the command text');
}

/**
 * The module as PR-INT wires it: the store, the inbox, the audit from the store, and the notes,
 * viewing and brain handed in as functions (they are built after it in index.mjs).
 */
function harness({ env = ENV, identity = true, wired = true, brainHealth = { configured: true, ok: true, backup: false }, withSummary = true } = {}) {
  const s = openDb(':memory:');
  let clock = NOW;
  const now = () => clock;
  let ot = null;
  const team = createTeam(s, { now, ownerTest: () => ot });
  const owner = team.ensureOwner({ phone: OWNER, name: 'Owner Example' });
  const colleague = team.addUser({ name: 'Colleague Example', phone: COLLEAGUE, role: 'staff' });
  learnTeamLid(s, OWNER, OWNER_LID);
  const inbox = createInboxStore(s, { now });
  const logs = [];
  const notes = {
    commands: [], summaries: [],
    command(recId, text) { this.commands.push({ recId, text }); return { queued: true }; },
    ...(withSummary ? { summary(o) { this.summaries.push(o); return { queued: true }; } } : {}),
  };
  const viewing = { cancelled: [], cancelForLead(id) { this.cancelled.push(id); return 0; } };
  const link = { identity, identityOk() { return this.identity; }, linkOk: () => true };
  const brain = { health: () => brainHealth };
  ot = createOwnerTest({
    cfg: { env }, team, wa: waConfig(env), link, log: (e) => logs.push(e), now,
    ...(wired ? { db: s, inbox, notes: () => notes, viewing: () => viewing, brain: () => brain } : {}),
  });
  let n = 0;
  /** A command the owner sends from his phone, a little after the last one (the clock moves on 10 s). */
  const send = (text, over = {}) => {
    clock += 10_000;
    n += 1;
    return ot.command({ id: `CMD-${n}`, jid: OWNER_JID, jidAlt: null, fromMe: false, ts: clock - 2000, text, ...over });
  };
  const setting = (key) => s.db.prepare('SELECT value, updated, updated_by FROM settings WHERE key = ?').get(key) ?? null;
  const audits = () => s.db.prepare("SELECT * FROM audit_log WHERE action = 'setting' ORDER BY rowid").all()
    .map((r) => ({ user_id: r.user_id, target: r.target, meta: JSON.parse(r.meta) }));
  return {
    s, team, ot, owner, colleague, inbox, notes, viewing, link, logs, send, setting, audits,
    now, at: (t) => { clock = t; }, tick: (ms) => { clock += ms; },
  };
}

/* ---------------- 1. active() ---------------- */

test('active(): the setting AND the identity check AND the owner differing from the instance; nothing else turns it on', () => {
  for (const setting of ['0', '1']) {
    for (const identity of [false, true]) {
      for (const split of [true, false]) {
        const env = split ? ENV : { ...ENV, BONA_WA_INSTANCE_JID: OWNER_JID };
        const h = harness({ env, identity });
        h.team.setSetting('owner_as_client', setting);
        const want = setting === '1' && identity && split;
        assert.equal(h.ot.active(), want, `setting ${setting}, identity ${identity}, split ${split}`);
        // ownNumberOk is the instance's own number plus the identity guard's answer (the guard
        // itself refuses an instance number equal to the owner's: lib/wa-link.mjs, condition 3).
        assert.equal(h.ot.ownNumberOk(), identity, `ownNumberOk ${setting}/${identity}/${split}`);
        assert.deepEqual(h.ot.health(), { rule: 'shared', ownerAsClient: want });
        h.s.close();
      }
    }
  }
  // Bona's number unset (the owner's, as before the split) or not a phone jid: never own, never active.
  for (const jid of ['', 'bona@g.us']) {
    const h = harness({ env: { ...ENV, BONA_WA_INSTANCE_JID: jid } });
    h.team.setSetting('owner_as_client', '1');
    assert.equal(h.ot.ownNumberOk(), false, `ownNumberFrom for '${jid}'`);
    assert.equal(h.ot.active(), false);
    h.s.close();
  }
  // Only an exact '1' is on, and an identity guard that throws is "not checked".
  const h = harness();
  h.s.db.prepare("INSERT INTO settings (key, value, updated) VALUES ('owner_as_client', ' 1', 1)").run();
  assert.equal(h.ot.active(), false, "' 1' is not on");
  h.team.setSetting('owner_as_client', '1');
  assert.equal(h.ot.active(), true);
  h.link.identityOk = () => { throw new Error('probe state lost'); };
  assert.equal(h.ot.ownNumberOk(), false);
  assert.equal(h.ot.active(), false);
  h.s.close();
});

test('the module with no deps answers what the stub answered: no test, no own rule, no auto mode, no command', () => {
  const t = createOwnerTest();
  assert.equal(t.active(), false);
  assert.equal(t.ownNumberOk(), false);
  assert.equal(t.autoMode({ lead_id: 'L-1', inbox_via: 'owner_test' }), false);
  assert.equal(t.autoMode(null), false);
  assert.equal(t.ownRuleFor({ jid: CLIENT_JID }), false);
  assert.equal(t.ownerLid(), null);
  assert.equal(t.ownerDigits(), null);
  assert.equal(t.command({ id: 'R-1', text: '#dana test on', fromMe: false, jid: OWNER_JID, ts: NOW }), false);
  assert.equal(t.onSettingChanged('owner_as_client', '1'), undefined);
  assert.deepEqual(t.health(), { rule: 'shared', ownerAsClient: false });
});

/* ---------------- 2. autoMode, ownRuleFor, ownerLid ---------------- */

test('autoMode: inbox_via owner_test / own_number / NULL x own_inbox x test x identity, as DESIGN §2 writes it', () => {
  for (const via of ['owner_test', 'own_number', null]) {
    for (const ownInbox of ['0', '1']) {
      for (const testOn of ['0', '1']) {
        for (const identity of [false, true]) {
          const h = harness({ identity });
          h.team.setSetting('own_inbox', ownInbox);
          h.team.setSetting('owner_as_client', testOn);
          const lead = { lead_id: 'L-1', inbox_via: via, inbox_state: 'in' };
          let want = false;
          if (identity) want = via === 'owner_test' ? testOn === '1' : via === 'own_number' ? true : ownInbox === '1';
          assert.equal(h.ot.autoMode(lead), want, `${via} / own_inbox ${ownInbox} / test ${testOn} / identity ${identity}`);
          h.s.close();
        }
      }
    }
  }
  const h = harness();
  h.team.setSetting('own_inbox', '1');
  assert.equal(h.ot.autoMode(null), false);
  assert.equal(h.ot.autoMode('LEAD-1'), false, 'a lead row, not an id');
  h.s.close();
});

test("ownRuleFor: every chat while own_inbox is on; with it off, only the owner's own jids, and only while the test is active", () => {
  const h = harness();
  const owners = [{ phone: OWNER, waJid: OWNER_JID, waLid: null }, { phone: null, waJid: null, waLid: OWNER_LID }, { jid: OWNER_JID }];
  const clients = [{ phone: CLIENT, waJid: CLIENT_JID, waLid: CLIENT_LID }, { phone: null, waJid: null, waLid: CLIENT_LID }, { jid: CLIENT_JID }];
  for (const j of [...owners, ...clients]) assert.equal(h.ot.ownRuleFor(j), false, 'both off');
  h.team.setSetting('owner_as_client', '1');
  for (const j of owners) assert.equal(h.ot.ownRuleFor(j), true, "the owner's jids, test active");
  for (const j of clients) assert.equal(h.ot.ownRuleFor(j), false, 'a client is not the test');
  // The owner's lid with a client's number is not him.
  assert.equal(h.ot.ownRuleFor({ phone: CLIENT, waJid: CLIENT_JID, waLid: OWNER_LID }), false);
  h.team.setSetting('own_inbox', '1');
  for (const j of [...owners, ...clients]) assert.equal(h.ot.ownRuleFor(j), true, 'own_inbox on: every chat');
  assert.deepEqual(h.ot.health(), { rule: 'own', ownerAsClient: true });
  h.link.identity = false;
  for (const j of [...owners, ...clients]) assert.equal(h.ot.ownRuleFor(j), false, 'no identity: nothing joins under the own rule');
  assert.deepEqual(h.ot.health(), { rule: 'shared', ownerAsClient: false });
  h.s.close();
});

test("ownerLid: the owner's users-row lid while the test is active, else null (never a colleague's, never role-based)", () => {
  const h = harness();
  assert.equal(h.ot.ownerLid(), null, 'test off');
  h.team.setSetting('owner_as_client', '1');
  assert.equal(h.ot.ownerLid(), OWNER_LID);
  assert.equal(h.ot.ownerDigits(), OWNER);
  // A second owner-role account is not BONA_OWNER_JID: its lid is never the exception.
  const other = h.team.addUser({ name: 'Colleague Example', phone: '966500000050', role: 'owner' });
  learnTeamLid(h.s, '966500000050', '100000000000050@lid');
  assert.equal(h.ot.ownerLid(), OWNER_LID);
  assert.ok(other.user_id);
  h.link.identity = false;
  assert.equal(h.ot.ownerLid(), null, 'identity lapsed: the test is not in force');
  h.s.close();
});

/* ---------------- 4. the commands ---------------- */

test('parseCommand: the exact command texts, any case and any whitespace; anything else is no command', () => {
  const want = {
    '#dana test on': ['owner_as_client', '1'], '#dana test off': ['owner_as_client', '0'],
    '#dana on': ['dana_enabled', '1'], '#dana off': ['dana_enabled', '0'],
    '#dana live on': ['own_inbox', '1'], '#dana live off': ['own_inbox', '0'],
    '#dana booking on': ['calendar_booking', '1'], '#dana booking off': ['calendar_booking', '0'],
    '#dana email on': ['email_replies', '1'], '#dana email off': ['email_replies', '0'],
    '#dana brain on': ['dana_brain', '1'], '#dana brain off': ['dana_brain', '0'],
  };
  for (const [text, [key, value]] of Object.entries(want)) {
    assert.deepEqual([parseCommand(text)?.key, parseCommand(text)?.value], [key, value], text);
    assert.deepEqual(parseCommand(`  ${text.toUpperCase().replace(/ /g, '   ')}\n`), parseCommand(text), `${text}: case and whitespace`);
  }
  assert.equal(parseCommand('#dana status').code, 'status');
  assert.equal(parseCommand('#Dana Summary').code, 'summary');
  assert.equal(parseCommand('\u200F#dana off'), COMMANDS.off, 'an invisible mark the keyboard added');
  for (const text of ['#dana', '#dana foo', '#danaoff', '#dana test', '#dana test on please', 'dana off', '# dana off', '#dana email verified', '', null, 42]) {
    assert.equal(parseCommand(text), null, String(text));
  }
  assert.equal(Object.keys(COMMANDS).length, 14);
  assert.ok(DANA_COMMAND_RE.test(' #DANA test on') && DANA_COMMAND_RE.test('#dana foo') && !DANA_COMMAND_RE.test('#danaX') && !DANA_COMMAND_RE.test('hi #dana'));
  // ingest's refusal (isDanaCommandText) drops the same invisible marks parseCommand does, so every text it takes is refused there too.
  for (const text of ['#dana off', ' #DANA test on', '#dana foo', '\u200F#dana status', '\u200E#dana off', '\u200B #dana off', '\u2067#dana live on\u2069', '#\u200Fdana off']) {
    assert.equal(isDanaCommandText(text), true, JSON.stringify(text));
  }
  assert.equal(parseCommand('#\u200Fdana off'), COMMANDS.off, 'a mark inside the word is dropped by both');
  for (const text of ['#danaX', 'hi #dana', '\u200Fhi #dana', '', null, 42, undefined]) assert.equal(isDanaCommandText(text), false, String(text));
});

test('every switch command sets its own setting, by the owner\'s phone or his lid, and only received ones from him count', () => {
  const h = harness();
  const cases = [
    ['#dana test on', 'owner_as_client', '1'], ['#dana test off', 'owner_as_client', '0'],
    ['#dana live on', 'own_inbox', '1'], ['#dana live off', 'own_inbox', '0'],
    ['#dana booking on', 'calendar_booking', '1'], ['#dana booking off', 'calendar_booking', '0'],
    ['#dana email on', 'email_replies', '1'], ['#dana email off', 'email_replies', '0'],
    ['#dana brain on', 'dana_brain', '1'], ['#dana brain off', 'dana_brain', '0'],
    ['#dana on', 'dana_enabled', '1'], ['#dana off', 'dana_enabled', '0'],
  ];
  for (const [text, key, value] of cases) {
    assert.equal(h.send(`  ${text.toUpperCase()} `), true, text);
    assert.equal(h.team.getSetting(key), value, text);
  }
  // By his lid alone (a privacy-mode chat), and by the lid with his number as the alt.
  assert.equal(h.send('#dana on', { jid: OWNER_LID }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '1');
  assert.equal(h.send('#dana off', { jid: OWNER_LID, jidAlt: OWNER_JID }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '0');
  // Not his: a fromMe record (typed on Bona's phone), a client, a colleague, a group, a lid that is not his, two numbers.
  for (const over of [
    { fromMe: true }, { jid: CLIENT_JID }, { jid: `${COLLEAGUE}@s.whatsapp.net` }, { jid: '120363000000000000@g.us' },
    { jid: CLIENT_LID, jidAlt: null }, { jid: CLIENT_LID, jidAlt: CLIENT_JID }, { jid: OWNER_JID, jidAlt: CLIENT_JID },
    { jid: null, jidAlt: null },
  ]) {
    assert.equal(h.send('#dana on', over), false, JSON.stringify(over));
    assert.equal(h.team.getSetting('dana_enabled'), '0', JSON.stringify(over));
  }
  assert.equal(h.send('#dana foo'), false, 'no command, not consumed');
  assertClean(h.logs);
  h.s.close();
});

test('#dana on turns the assistant back on after the breaker; #dana live off never touches dana_enabled', () => {
  const h = harness();
  h.team.setSetting('dana_enabled', '1');
  h.team.setSetting('own_inbox', '1');
  h.tick(MIN);
  // The breaker (PR-B3) writes dana_enabled '0' as 'system'.
  h.team.setSetting('dana_enabled', '0', { by: 'system' });
  assert.equal(h.send('#dana on'), true);
  assert.equal(h.team.getSetting('dana_enabled'), '1');
  assert.equal(h.setting('dana_enabled').updated_by, h.owner.user_id);
  assert.equal(h.send('#dana live off'), true);
  assert.equal(h.team.getSetting('own_inbox'), '0');
  assert.equal(h.team.getSetting('dana_enabled'), '1', 'live off is new chats only: the assistant stays on');
  h.s.close();
});

test('#dana status: every switch and an "AI: …" line from brain.health(); #dana summary asks for a TEST summary', () => {
  const lines = [
    [{ configured: true, ok: true, backup: false }, 'AI: OpenAI ✓ (main model)'],
    [{ configured: true, ok: true, backup: true }, 'AI: OpenAI on backup'],
    [{ configured: true, ok: false, backup: false }, 'AI: OpenAI down'],
    [{ configured: false, ok: false, backup: false }, 'AI: OpenAI down (not set up)'],
  ];
  for (const [brainHealth, line] of lines) {
    const h = harness({ brainHealth });
    h.team.setSetting('owner_as_client', '1');
    h.team.setSetting('dana_enabled', '1');
    assert.equal(h.send('#dana status'), true);
    const [reply] = h.notes.commands;
    assert.equal(reply.recId, 'CMD-1');
    assert.ok(reply.text.startsWith(`${COMMAND_HEADER} ON`), reply.text);
    assert.ok(reply.text.includes('AI assistant: ON'));
    assert.ok(reply.text.includes('Live (new chats on Bona\'s number): OFF'));
    assert.ok(reply.text.includes('Booking: OFF') && reply.text.includes('Email replies: OFF') && reply.text.includes('OpenAI for every chat: OFF'));
    assert.ok(reply.text.includes("Bona's number: checked ✓"));
    assert.ok(reply.text.split('\n').includes(line), `${line} in ${reply.text}`);
    assert.equal(/Dana/.test(reply.text), false, 'owner-facing text is nameless');
    assert.equal(/\d{8,}/.test(reply.text), false, 'no number in a reply');
    // A status changes no setting and writes no audit row.
    assert.deepEqual(h.audits(), []);
    assert.equal(h.s.waSeenHas('CMD-1'), true);
    h.s.close();
  }
  const h = harness();
  assert.equal(h.send('#dana summary'), true);
  assert.deepEqual(h.notes.summaries, [{ test: true, ts: h.now() - 2000 }]);
  assert.deepEqual(h.notes.commands, [], 'the summary is the reply');
  h.notes.summary = () => ({ queued: false, reason: 'off' });
  assert.equal(h.send('#dana summary'), true);
  assert.ok(h.notes.commands[0].text.includes('Summary: not sent'), 'a summary that cannot go says so');
  h.s.close();
  const bare = harness({ withSummary: false });
  assert.equal(bare.send('#dana summary'), true);
  assert.ok(bare.notes.commands[0].text.includes('Summary: not available yet'));
  bare.s.close();
});

test('in shared mode #dana test on changes nothing and says the test switch needs Bona\'s own number', () => {
  for (const env of [{ ...ENV, BONA_WA_INSTANCE_JID: '' }, { ...ENV, BONA_WA_INSTANCE_JID: OWNER_JID }]) {
    const h = harness({ env });
    assert.equal(h.send('#dana test on'), true, 'consumed');
    assert.equal(h.team.getSetting('owner_as_client'), '0');
    assert.equal(h.setting('owner_as_client'), null, 'not written');
    assert.deepEqual(h.audits(), []);
    assert.equal(h.notes.commands.length, 1);
    assert.ok(h.notes.commands[0].text.includes("The test switch needs Bona's own number."));
    // Other commands still work there.
    assert.equal(h.send('#dana on'), true);
    assert.equal(h.team.getSetting('dana_enabled'), '1');
    h.s.close();
  }
});

test('a test switch set ON while Bona\'s number is not checked yet says it is not in force', () => {
  const h = harness({ identity: false });
  assert.equal(h.send('#dana test on'), true);
  assert.equal(h.team.getSetting('owner_as_client'), '1');
  assert.equal(h.ot.active(), false);
  assert.ok(h.notes.commands[0].text.startsWith(`${COMMAND_HEADER} ON (not in force yet`), h.notes.commands[0].text);
  h.s.close();
});

/* ---------------- 5. the replay guard ---------------- */

test('replay guard: older than 10 min, older than the setting\'s updated stamp, or an id already seen → ignored (consumed, nothing applied)', () => {
  const h = harness();
  const base = { jid: OWNER_JID, jidAlt: null, fromMe: false };
  // Older than 10 minutes (an outage replay): consumed, not applied, no reply, no audit.
  assert.equal(h.ot.command({ ...base, id: 'OLD', ts: h.now() - COMMAND_MAX_AGE_MS - 1, text: '#dana off' }), true);
  // A clock 11 min ahead is just as untrusted.
  assert.equal(h.ot.command({ ...base, id: 'AHEAD', ts: h.now() + COMMAND_MAX_AGE_MS + 1, text: '#dana off' }), true);
  // No time at all.
  assert.equal(h.ot.command({ ...base, id: 'NOTS', text: '#dana off' }), true);
  assert.equal(h.setting('dana_enabled'), null);
  // Exactly 10 minutes old is still in.
  h.team.setSetting('dana_enabled', '1');
  h.tick(COMMAND_MAX_AGE_MS + 5000);
  assert.equal(h.ot.command({ ...base, id: 'EDGE', ts: h.now() - COMMAND_MAX_AGE_MS, text: '#dana off' }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '0');
  // Older than the setting's own updated stamp: the Team page changed it after the message was sent.
  h.tick(5000);
  const sentAt = h.now() - 1000;
  h.team.setSetting('dana_enabled', '0', { by: h.owner.user_id });
  assert.equal(h.ot.command({ ...base, id: 'BEHIND', ts: sentAt, text: '#dana on' }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '0', 'a later change is never undone');
  // The same stamp is not newer either.
  assert.equal(h.ot.command({ ...base, id: 'SAME', ts: h.setting('dana_enabled').updated, text: '#dana on' }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '0');
  // Another setting's stamp does not count against it.
  h.tick(5000);
  assert.equal(h.ot.command({ ...base, id: 'OTHER', ts: h.now() - 1000, text: '#dana booking on' }), true);
  assert.equal(h.team.getSetting('calendar_booking'), '1');
  // An id already in waSeen.
  h.tick(5000);
  h.s.waSeenAdd('SEEN', h.now());
  assert.equal(h.ot.command({ ...base, id: 'SEEN', ts: h.now() - 1000, text: '#dana on' }), true);
  assert.equal(h.team.getSetting('dana_enabled'), '0');
  // The status and the summary keep the time and seen rules too.
  assert.equal(h.ot.command({ ...base, id: 'OLDSTATUS', ts: h.now() - COMMAND_MAX_AGE_MS - 1, text: '#dana status' }), true);
  assert.equal(h.ot.command({ ...base, id: 'SEEN', ts: h.now() - 1000, text: '#dana summary' }), true);
  assert.deepEqual(h.notes.summaries, []);
  // Only the two applied ones replied and were audited.
  assert.deepEqual(h.notes.commands.map((c) => c.recId), ['EDGE', 'OTHER']);
  assert.deepEqual(h.audits().map((a) => a.target), ['dana_enabled', 'calendar_booking']);
  assert.equal(h.s.waSeenHas('OLD'), false, 'an ignored record is not marked here (the poller marks what it consumed)');
  assertClean(h.logs);
  h.s.close();
});

test('replay guard: two commands on one switch read in one poll (oldest first) both apply, and the later one is what stays', () => {
  const pairs = [
    ['#dana live on', '#dana live off', 'own_inbox', '0'],
    ['#dana on', '#dana off', 'dana_enabled', '0'],
    ['#dana off', '#dana on', 'dana_enabled', '1'],
    ['#dana test on', '#dana test off', 'owner_as_client', '0'],
  ];
  for (const [first, second, key, want] of pairs) {
    const h = harness();
    h.team.setSetting('dana_enabled', '1');
    const t0 = h.now() + MIN;
    const base = { jid: OWNER_JID, jidAlt: null, fromMe: false };
    // Sent 4 s apart; the poller hands both over in one tick, 9 s after the first was sent.
    h.at(t0 + 9000);
    assert.equal(h.ot.command({ ...base, id: 'A', ts: t0, text: first }), true, first);
    assert.equal(h.ot.command({ ...base, id: 'B', ts: t0 + 4000, text: second }), true, second);
    assert.equal(h.team.getSetting(key), want, `${first} then ${second}: the owner's last word stands`);
    assert.deepEqual(h.notes.commands.map((c) => c.recId), ['A', 'B'], 'both were applied and answered');
    // The switch carries the time of the command that set it, so the first one replayed (a new id) is older.
    assert.equal(h.setting(key).updated, t0 + 4000);
    assert.equal(h.ot.command({ ...base, id: 'A-again', ts: t0 + 1000, text: first }), true);
    assert.equal(h.team.getSetting(key), want, 'an older command read later never undoes it');
    // A change on the Team page after both is still newer than either of them.
    h.tick(1000);
    h.team.setSetting(key, want === '1' ? '0' : '1', { by: h.owner.user_id });
    assert.equal(h.ot.command({ ...base, id: 'C', ts: t0 + 8000, text: second }), true);
    assert.notEqual(h.team.getSetting(key), want, 'the Team page change stands');
    assertClean(h.logs);
    h.s.close();
  }
});

/* ---------------- 6. the effect ---------------- */

test("the command's effect: setSetting by the owner's user_id, an audit row {via:'whatsapp'}, waSeen, and the reply as a command note", () => {
  const h = harness();
  assert.equal(h.send('#dana live on'), true);
  const row = h.setting('own_inbox');
  assert.deepEqual({ value: row.value, updated_by: row.updated_by }, { value: '1', updated_by: h.owner.user_id });
  assert.equal(row.updated, h.now() - 2000, "the switch carries the command's own time (send() sends it 2 s before now)");
  assert.deepEqual(h.audits(), [{ user_id: h.owner.user_id, target: 'own_inbox', meta: { value: '1', via: 'whatsapp' } }]);
  assert.equal(h.s.waSeenHas('CMD-1'), true);
  assert.equal(h.notes.commands.length, 1);
  assert.equal(h.notes.commands[0].recId, 'CMD-1');
  assert.ok(h.notes.commands[0].text.startsWith(`${COMMAND_HEADER}\nLive: ON`), h.notes.commands[0].text);
  // The reply to every command starts with the header the poller's own-note check knows.
  for (const text of ['#dana test on', '#dana test off', '#dana off', '#dana on', '#dana booking on', '#dana email on', '#dana brain on', '#dana status', '#dana live off']) {
    h.send(text);
  }
  for (const c of h.notes.commands) {
    assert.ok(c.text.startsWith(COMMAND_HEADER), c.text);
    assert.equal(/Dana/.test(c.text), false, 'nameless');
  }
  // A notes module that throws never fails the command.
  h.notes.command = () => { throw new Error('ledger down'); };
  assert.equal(h.send('#dana booking off'), true);
  assert.equal(h.team.getSetting('calendar_booking'), '0');
  assertClean(h.logs);
  h.s.close();
});

test('unwired (before PR-INT hands in the store), a command is not taken: nothing set, the record goes on as today', () => {
  const h = harness({ wired: false });
  assert.equal(h.send('#dana test on'), false);
  assert.equal(h.send('#dana off'), false);
  assert.equal(h.setting('owner_as_client'), null);
  assert.equal(h.setting('dana_enabled'), null);
  assert.equal(h.ot.onSettingChanged('owner_as_client', '1'), undefined);
  h.s.close();
});

/* ---------------- 7-8. the lifecycle ---------------- */

/** The owner's lead as an earlier test left it: out, held, handed over, with a stale Retell chat. */
function ownerLead(h, over = {}) {
  h.s.insertLead({
    lead_id: OWNER_LEAD, created: NOW - 86_400_000, updated: NOW - 86_400_000, phone_e164: OWNER, wa_jid: OWNER_JID, wa_lid: OWNER_LID,
    channel: 'whatsapp', stage: 'new', match_method: 'owner_test', inbox_via: 'owner_test',
    inbox_state: 'out', inbox_since: null, history_from: NOW - 2 * 86_400_000, needs_human: 1, dana_off: 1,
    dana_hold_until: NOW + 3_600_000, dana_hold_reason: 'cap_chat', last_human_out_ts: NOW - 3_600_000,
    dana_chat_id: 'chat_old', dana_chat_ts: NOW - 3_600_000, ...over,
  });
}

test('test on: the owner\'s lead is reopened (state and floor NULL, holds, hand-over, the human clock and the old chat cleared)', () => {
  const h = harness();
  ownerLead(h);
  assert.equal(h.send('#dana test on'), true);
  const l = h.s.getLead(OWNER_LEAD);
  assert.deepEqual(
    [l.inbox_state, l.history_from, l.needs_human, l.dana_off, l.dana_hold_until, l.dana_hold_reason, l.last_human_out_ts, l.dana_chat_id],
    [null, null, 0, 0, null, null, null, null],
  );
  assert.equal(l.inbox_via, 'owner_test', 'inbox_via is stamped at the join and never rewritten');
  assert.equal(h.ot.active(), true);
  // The Team page's switch runs the same lifecycle (routes.mjs calls onSettingChanged once per real change).
  h.s.updateLead(OWNER_LEAD, { inbox_state: 'out', dana_off: 1 });
  h.ot.onSettingChanged('owner_as_client', '1');
  assert.deepEqual([h.s.getLead(OWNER_LEAD).inbox_state, h.s.getLead(OWNER_LEAD).dana_off], [null, 0]);
  // A repeat of the same value is no real change: no lifecycle.
  h.s.updateLead(OWNER_LEAD, { dana_off: 1 });
  assert.equal(h.send('#dana test on'), true);
  assert.equal(h.s.getLead(OWNER_LEAD).dana_off, 1);
  assertClean(h.logs);
  h.s.close();
});

test('test on with no lead for the owner yet does nothing; it never touches another lead', () => {
  const h = harness();
  h.s.insertLead({ lead_id: 'LEAD-client', created: NOW, updated: NOW, phone_e164: CLIENT, wa_jid: CLIENT_JID, channel: 'whatsapp', stage: 'new', inbox_state: 'out', dana_off: 1 });
  assert.equal(h.send('#dana test on'), true);
  const c = h.s.getLead('LEAD-client');
  assert.deepEqual([c.inbox_state, c.dana_off], ['out', 1]);
  h.s.close();
});

test("test off: leaveInbox at once (out, transcript gone, dana_test reset) and viewing.cancelForLead", () => {
  const h = harness();
  ownerLead(h, { inbox_state: 'in', inbox_since: NOW - MIN, history_from: NOW - MIN, needs_human: 0, dana_off: 0, dana_test: 1 });
  h.team.setSetting('owner_as_client', '1');
  h.inbox.upsertMessage({ key_id: 'K-1', lead_id: OWNER_LEAD, jid: OWNER_JID, direction: 'in', sender_kind: 'client', text: 'test villa', ts: NOW - 1000 });
  assert.equal(h.send('#dana test off'), true);
  const l = h.s.getLead(OWNER_LEAD);
  assert.deepEqual([l.inbox_state, l.dana_test, h.inbox.countMessages(OWNER_LEAD)], ['out', 0, 0]);
  assert.deepEqual(h.viewing.cancelled, [OWNER_LEAD]);
  assert.equal(h.team.getSetting('owner_as_client'), '0');
  assert.ok(h.notes.commands.at(-1).text.startsWith(`${COMMAND_HEADER} OFF`));
  // From the Team page too.
  h.team.setSetting('owner_as_client', '1');
  h.inbox.setInboxState(OWNER_LEAD, 'in');
  h.ot.onSettingChanged('owner_as_client', '0');
  assert.equal(h.s.getLead(OWNER_LEAD).inbox_state, 'out');
  assert.deepEqual(h.viewing.cancelled, [OWNER_LEAD, OWNER_LEAD]);
  // A viewing module that throws never stops the leave.
  h.inbox.setInboxState(OWNER_LEAD, 'in');
  h.viewing.cancelForLead = () => { throw new Error('calendar down'); };
  h.ot.onSettingChanged('owner_as_client', '0');
  assert.equal(h.s.getLead(OWNER_LEAD).inbox_state, 'out');
  // Another setting has no lifecycle.
  h.inbox.setInboxState(OWNER_LEAD, 'in');
  h.ot.onSettingChanged('own_inbox', '0');
  assert.equal(h.s.getLead(OWNER_LEAD).inbox_state, 'in');
  assertClean(h.logs);
  h.s.close();
});
