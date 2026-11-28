/**
 * PR-B3 (PLAN T12 tests 6, 11, 12): a whole booking conversation through lib/dana-wa.mjs with the real
 * sender (lib/wa-send.mjs), the real pacing (lib/pacing.mjs) on a fake clock whose sleeps move it, a
 * scripted fake brain (lib/brain/fake.mjs) and a fake commit step standing in for PR-B4's. Nothing leaves
 * the process: Evolution is a fake fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { createTeam, isExcludedLead } from '../lib/team.mjs';
import { createInboxStore } from '../lib/inbox/store.mjs';
import { createSender } from '../lib/wa-send.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { createDana } from '../lib/dana-wa.mjs';
import { createPacing } from '../lib/pacing.mjs';
import { createFakeBrain, brainReply } from '../lib/brain/fake.mjs';

const SITE = 'https://bona.azoz.uk';
const T0 = Date.parse('2026-11-29T11:00:00+03:00'); // a Sunday morning
const LEAD = 'LEAD-20261129-0000f10w';
const OWNER = '966500000009';
const CLIENT = '966500000031';
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: SITE });
const HOME = inventory.all()[0];

function rig({ client = CLIENT, inboxVia = null, turns = [], commit = null, pacing: givenPacing = null, batchMs = 0 } = {}) {
  const s = openDb(':memory:');
  let clock = T0;
  const now = () => clock;
  const team = createTeam(s, { now });
  team.ensureOwner({ phone: OWNER, name: 'Owner' });
  team.setSetting('dana_enabled', '1');
  const inbox = createInboxStore(s, { now });
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ route: String(url).split('/message/')[1].split('/')[0], body: JSON.parse(init.body), at: clock });
    return { ok: true, status: 201, text: async () => JSON.stringify({ key: { id: `KEY-${posts.length}` } }) };
  };
  const env = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona2', BONA_OWNER_JID: `${OWNER}@s.whatsapp.net` };
  const sender = createSender({ env, team, inbox, db: s, fetchImpl, now });
  const sleep = async (ms) => { clock += ms; };
  const pacing = givenPacing ?? createPacing({ cfg: { waLinkedAt: null }, now, random: () => 0, sleep });
  const brain = createFakeBrain({ turns });
  const notes = { calls: [], handover: (...a) => notes.calls.push(['handover', ...a]), stopped: (...a) => notes.calls.push(['stopped', ...a]), alert: (...a) => notes.calls.push(['alert', ...a]) };
  const logs = [];
  s.insertLead({
    lead_id: LEAD, created: T0 - 60_000, updated: T0 - 60_000, phone_e164: client, wa_jid: `${client}@s.whatsapp.net`, channel: 'whatsapp',
    match_method: inboxVia ?? 'ref', stage: 'new', inbox_state: 'in', inbox_since: T0 - 60_000, inbox_via: inboxVia,
  });
  const ownerTest = { autoMode: (l) => l?.lead_id === LEAD, active: () => true, ownNumberOk: () => true };
  const dana = createDana({
    db: s, inbox, team, sender, retell: null, inventory, siteUrl: SITE, agentId: null, brain, ownerTest, notes, pacing, sleep,
    ...(commit ? { commit } : {}), ...(batchMs === null ? {} : { batchMs }),
    alerts: { notify: async () => ({}), notifyOwners: async () => ({}) },
    // The owner's test chat is his own number: the real owner test (PR-A2) lifts the team exclusion for it.
    isExcludedLead: (l) => (client === OWNER ? false : isExcludedLead(team, s, l)), now, log: (o) => logs.push(o),
  });
  let k = 0;
  const say = (text) => {
    k += 1;
    inbox.upsertMessage({ key_id: `IN-${k}`, lead_id: LEAD, jid: `${client}@s.whatsapp.net`, direction: 'in', sender_kind: 'client', text, ts: clock });
    dana.wake(LEAD, clock);
    return clock;
  };
  return { s, team, inbox, sender, dana, brain, notes, logs, posts, say, now, at: (t) => { clock = Math.max(clock, t); }, tick: (ms) => { clock += ms; } };
}

const tool = (name, args = {}, result = { ok: true }) => ({ name, args, result });

test('REGRESSION (PLAN T12 test 11): a 12-turn booking conversation over 15 min, with batching, trips no cap and no loop guard', async () => {
  const search = tool('search_properties', { query: 'villa' }, { count: 1, results: [{ id: HOME.id, slug: HOME.slug }] });
  const turns = [
    brainReply('Welcome! Are you looking to buy, invest off-plan, or sell?'),
    brainReply('Great. Which district do you prefer, and what budget?'),
    brainReply('Here is a villa that fits.', { tools: [search] }),
    brainReply('I am sending you its brochure.', { tools: [tool('send_brochure', { listing_id: HOME.id })] }),
    brainReply('It is in a quiet street close to schools.'),
    brainReply('Here is where it is on the map.', { tools: [tool('send_location', { listing_id: HOME.id })] }),
    brainReply('I can offer Monday 10:00, Monday 14:00 or Tuesday 11:00. What is your name?', { tools: [tool('viewing_slots', { listing_id: HOME.id })] }),
    brainReply('Thank you, Khalid. Booking Monday 14:00 for you.', { tools: [tool('save_needs', { name: 'Khalid' }), tool('book_viewing', { listing_id: HOME.id })] }),
    brainReply('You are welcome. Anything else about the villa?'),
    brainReply('Yes, there is parking for two cars.'),
    brainReply('The garden faces south.'),
    brainReply('See you on Monday!'),
  ];
  const commit = {
    afterPreSend: async ({ text, turn }) => {
      const names = (turn.toolCalls ?? []).map((c) => c.name);
      if (names.includes('send_brochure')) return { bubbles: [{ kind: 'text', text }, { kind: 'document', url: `${SITE}/brochures/${HOME.id}.pdf`, fileName: `${HOME.id}.pdf`, caption: 'The brochure' }] };
      if (names.includes('book_viewing')) return { bubbles: [{ kind: 'text', text: 'Your viewing is booked ✅\nMonday 30 November, 2:00 pm (one hour)' }] };
      return { bubbles: [{ kind: 'text', text }] };
    },
  };
  const h = rig({ turns, commit });
  // The client's side: some turns are two or three quick messages, batched into one turn.
  const script = [
    ['Hi'], ['I want to buy', 'a villa'], ['Al Khalidiyah, around 3 million'], ['can I see the brochure?'], ['what about schools?'],
    ['where is it exactly?'], ['can I visit?', 'this week if possible'], ['Monday 14:00 please', 'my name is Khalid'], ['thanks'],
    ['is there parking?'], ['which way does the garden face?', 'and the pool?'], ['great, see you then'],
  ];
  for (let i = 0; i < script.length; i += 1) {
    h.at(T0 + i * 75_000);
    for (const text of script[i]) {
      h.say(text);
      h.tick(2_000);
    }
    await h.dana.flush();
  }
  assert.ok(h.now() - T0 >= 15 * 60_000 - 75_000 && h.now() - T0 <= 22 * 60_000, `over about 15 minutes (${Math.round((h.now() - T0) / 1000)} s)`);
  assert.equal(h.brain.calls.length, 12, 'one model call a turn: the quick messages were batched');
  assert.equal(h.inbox.countDanaTurns({ leadId: LEAD, sinceTs: T0 - 1 }), 12, 'twelve turns, the brochure bubble inside its own');
  assert.equal(h.posts.filter((p) => p.route === 'sendMedia').length, 1);
  assert.equal(h.posts.length, 13);
  const lead = h.s.getLead(LEAD);
  assert.deepEqual([lead.dana_hold_reason, lead.dana_hold_until, lead.needs_human, lead.dana_off], [null, null, 0, 0], 'no hold, no hand-over, no stop');
  assert.equal(h.team.getSetting('dana_enabled'), '1');
  assert.deepEqual(h.logs.filter((l) => l.evt === 'dana.skipped'), [], 'nothing skipped: no cap, no loop guard');
  assert.equal(h.logs.filter((l) => l.evt === 'dana.answered').length, 12);
  assert.deepEqual(h.inbox.unansweredClientMessages(LEAD), []);
  // The FIFO kept its gap: no two sends closer than 4 s.
  const gaps = h.posts.slice(1).map((p, i) => p.at - h.posts[i].at);
  assert.ok(gaps.every((g) => g >= 4000), JSON.stringify(gaps));
});

test('PLAN T12 test 6: in the test chat, a booking turn (text, PDF, confirmation) plus a booking note, a new-client note and a command reply inside one minute trips nothing', async () => {
  const commit = {
    afterPreSend: async ({ text }) => ({
      bubbles: [
        { kind: 'text', text },
        { kind: 'document', url: `${SITE}/brochures/${HOME.id}.pdf`, fileName: `${HOME.id}.pdf`, caption: 'The brochure' },
        { kind: 'text', text: 'Your viewing is booked ✅\nMonday 30 November, 2:00 pm (one hour)' },
      ],
    }),
  };
  const immediate = { batchDelay: () => 0, typingFloorMs: () => 0, fifo: (fn) => fn(), tier: createPacing().tier };
  const h = rig({ client: OWNER, inboxVia: 'owner_test', turns: [brainReply('Booking Monday 14:00 for you.', { tools: [tool('book_viewing', {})] })], commit, pacing: immediate });
  h.say('Monday 14:00 please, my name is Khalid');
  await h.dana.flush();
  // The notes go to the owner on their own per-recipient key (`note:to:`), inside the same minute.
  for (const text of ['*Bona — viewing booked*', '*Bona — new enquiry*', '*Bona — test mode*\nOK']) {
    assert.equal((await h.sender.sendTo({ jid: `${OWNER}@s.whatsapp.net`, text, kind: 'note' })).ok, true, text);
  }
  assert.equal(h.posts.length, 6);
  assert.deepEqual(h.posts.map((p) => p.route), ['sendText', 'sendMedia', 'sendText', 'sendText', 'sendText', 'sendText'], "the commit's order: text, brochure, confirmation (r1)");
  const lead = h.s.getLead(LEAD);
  assert.deepEqual([lead.dana_hold_reason, lead.needs_human], [null, 0]);
  assert.equal(h.team.getSetting('dana_enabled'), '1', 'no breaker');
  assert.equal(h.s.db.prepare("SELECT COUNT(*) n FROM wa_outbox WHERE status <> 'accepted'").get().n, 0, 'nothing refused');
});

test('PLAN T12 test 12 (the wiring): a brain chat\'s batch window comes from pacing, restarted on each message from its first wake', async () => {
  const seen = [];
  const fake = { batchDelay: (o) => { seen.push(o); return 0; }, typingFloorMs: () => 0, fifo: (fn) => fn(), tier: createPacing().tier };
  const h = rig({ turns: [brainReply('Of course.')], pacing: fake, batchMs: null });
  h.say('hello');
  h.tick(3000);
  h.say('are you there?');
  await h.dana.flush();
  assert.equal(seen.length, 2, 'once per message');
  assert.equal(seen[0].firstAt, seen[1].firstAt, 'measured from the first wake (the 15 s cap)');
  assert.equal(seen[1].at - seen[0].at, 3000);
  assert.equal(h.brain.calls.length, 1, 'one batch');
});
