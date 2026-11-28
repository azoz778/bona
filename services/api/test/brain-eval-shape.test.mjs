/**
 * PLAN T26 (PR-EVAL): the offline brain eval's case file and runner (brain/DESIGN-brain.md §13.2), checked with NO
 * network. This file runs in CI: it never sets BONA_BRAIN_EVAL, and every child process it starts gets an
 * environment without it (and a HOME with no key file), so nothing here can reach a provider.
 *
 *   - the case file: 48 cases, 32 Arabic and 16 English, every DESIGN category, 6 home-detail and 6 multi-turn,
 *     public listing ids only, no personal data, the two seeded-price cases, the reply-guard edge cases (Added
 *     27 Nov) and the booking-claim cases (Added 28 Nov), the T13 leftovers as probes;
 *   - the grader: every probe fails on the rule it names (or passes, when it names none), plus a table of the
 *     eval's own checks (loose amounts, off-site links and phones, names, booking claims, register, style);
 *   - the pass bar and the decision rule, exactly as PLAN T26 states them;
 *   - `--dry-run`: the whole pipeline (cases, the in-memory DB, the real brain loop and tools, grading, the
 *     answers file, the report) on a fake model, offline; and the CLI's refusal of a live run without the flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findAmounts, unitRefs } from '../lib/reply-guard.mjs';
import { WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { ROUTE_TOOLS } from '../lib/brain/tool-schemas.mjs';
import { HANDOVER_KINDS } from '../lib/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = path.resolve(HERE, '../eval');
const CASES_FILE = path.join(EVAL_DIR, 'brain-cases.jsonl');
const RUN_FILE = path.join(EVAL_DIR, 'run.mjs');
/** Imported lazily: the case-file tests read the file on their own, so they do not depend on the runner. */
const runner = () => import(RUN_FILE);

/** DESIGN-brain §13.2's categories, plus the two the PLAN T26 notes add (guard edges; booking claims ride `viewing`). */
const CATEGORIES = [
  'greeting', 'search', 'price_listed', 'price_on_request', 'units', 'negotiation', 'selling', 'viewing', 'brochure',
  'location', 'home_detail', 'multi_turn', 'injection', 'other_agencies', 'voice_note', 'off_topic', 'out_of_hours',
  'person', 'name', 'guard_edge',
];
const HARD_RULES = ['price', 'unit', 'name', 'handover', 'injection', 'booking', 'link', 'phone', 'forbidden', 'invented_home'];
/** The only names a case may carry: examples, as the other tests use. */
const EXAMPLE_NAMES = new Set(['Khalid', 'خالد', 'Sara', 'سارة']);
/** Bona's public number (site.json), the one phone a case or a probe may hold. */
const BONA_PHONE_DIGITS = '966576267694';

const listings = JSON.parse(fs.readFileSync(WORKTREE_LISTINGS, 'utf8'));
const PUBLIC_IDS = new Set(listings.filter((l) => l.status === 'available' && l.slug).map((l) => l.id));

function readCases() {
  return fs.readFileSync(CASES_FILE, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (err) { throw new Error(`line ${i + 1}: ${err.message}`); }
  });
}
/** Every string in a value, deep. */
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const clientTexts = (c) => [...(c.history ?? []).filter((h) => h.from === 'client').map((h) => h.text), ...c.turns.flatMap((t) => t.client.filter((x) => typeof x === 'string'))];
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `bona-eval-${tag}-`));

/* ---------------- the case file ---------------- */

test('the case file parses: 48 cases, 32 Arabic and 16 English, each with an id, a category, a note and turns', () => {
  const cases = readCases();
  assert.equal(cases.length, 48);
  assert.equal(cases.filter((c) => c.lang === 'ar').length, 32);
  assert.equal(cases.filter((c) => c.lang === 'en').length, 16);
  assert.equal(new Set(cases.map((c) => c.id)).size, 48, 'ids are unique');
  for (const c of cases) {
    assert.match(c.id, new RegExp(`^${c.lang}-[a-z0-9-]+$`), c.id);
    assert.ok(CATEGORIES.includes(c.category), `${c.id}: category ${c.category}`);
    assert.ok(typeof c.note === 'string' && c.note.length > 10, `${c.id}: a note says what it tests`);
    assert.ok(Array.isArray(c.turns) && c.turns.length >= 1, `${c.id}: turns`);
    for (const t of c.turns) {
      assert.ok(Array.isArray(t.client) && t.client.length >= 1, `${c.id}: every turn has client messages`);
      for (const tool of [...(t.expect?.tools ?? []).flatMap((x) => x.split('|')), ...(t.expect?.not_tools ?? [])]) {
        assert.ok(ROUTE_TOOLS.wa.includes(tool), `${c.id}: ${tool} is a WhatsApp tool`);
      }
      for (const k of t.expect?.kind ?? []) assert.ok(HANDOVER_KINDS.includes(k), `${c.id}: kind ${k}`);
    }
    if (c.at !== undefined) assert.ok(Number.isFinite(Date.parse(c.at)) && /\+03:00$/.test(c.at), `${c.id}: at is a Riyadh time`);
  }
});

test('every category of DESIGN-brain §13.2 is there, with 6 home-detail and 6 multi-turn cases', () => {
  const cases = readCases();
  const by = (cat) => cases.filter((c) => c.category === cat);
  for (const cat of CATEGORIES) assert.ok(by(cat).length >= 1, `category ${cat}`);
  assert.equal(by('home_detail').length, 6);
  assert.equal(by('multi_turn').length, 6);
  for (const c of by('home_detail')) assert.ok(c.turns.some((t) => (t.expect?.tools ?? []).some((x) => x.split('|').includes('listing_details'))), `${c.id} → listing_details`);
  // A multi-turn case has history or more than one live turn.
  for (const c of by('multi_turn')) assert.ok((c.history ?? []).length >= 2 || c.turns.length >= 2, `${c.id} is multi-turn`);
  assert.ok(by('multi_turn').some((c) => c.turns.length >= 2), 'at least one multi-turn case runs two live turns');
  assert.ok(by('multi_turn').some((c) => (c.history ?? []).some((h) => h.from === 'team')), 'one runs after a team message');
  assert.ok(by('multi_turn').some((c) => (c.history ?? []).some((h) => h.from === 'assistant' && h.guarded !== 0 && findAmounts(h.text).length)), 'one has a price already quoted (guarded) in history');
  // Negotiation, selling: the hand-over cases are hard rules with their kind.
  for (const c of [...by('negotiation'), ...by('selling')]) assert.ok(c.turns.at(-1).expect?.hard === true && c.turns.at(-1).expect.kind?.length, `${c.id}: a hard hand-over`);
  assert.ok(by('negotiation').every((c) => c.turns.at(-1).expect.kind.includes('offer')));
  assert.ok(by('negotiation').every((c) => (c.forbid_amounts ?? []).length || c.id === 'ar-neg-1'), 'a figure the client offers is forbidden (no echo)');
  assert.ok(by('injection').some((c) => c.lead && Object.values(c.lead).some((v) => /ignore/i.test(String(v)))), 'one injection rides the client record');
  // Arabic variety (DESIGN §13.2): Arabic-Indic digits, Arabizi, some MSA.
  const ar = cases.filter((c) => c.lang === 'ar').flatMap(clientTexts).join('\n');
  assert.match(ar, /[٠-٩]/, 'Arabic-Indic digits');
  assert.ok(cases.some((c) => c.lang === 'ar' && clientTexts(c).some((t) => /^[\x20-\x7e]+$/.test(t)) && c.accept_lang?.includes('en')), 'an Arabizi case');
  assert.match(ar, /أود|أرغب/, 'some MSA');
});

test('public listing ids only, and no personal data: no phone but Bona\'s public one, no email, example names only', () => {
  for (const c of readCases()) {
    const all = strings(c);
    for (const s of all) {
      for (const id of s.match(/BONA-W?\d{3}/gi) ?? []) assert.ok(PUBLIC_IDS.has(id.toUpperCase()), `${c.id}: ${id} is a public listing`);
      assert.doesNotMatch(s, /@/, `${c.id}: no email address`);
      for (const run of s.match(/\+?\d[\d \-]{7,}\d/g) ?? []) {
        const digits = run.replace(/\D/g, '');
        if (digits.length >= 9) assert.equal(digits, BONA_PHONE_DIGITS, `${c.id}: no phone number but Bona's public one`);
      }
    }
    if (c.lead?.name) assert.ok(EXAMPLE_NAMES.has(c.lead.name), `${c.id}: example name`);
    for (const t of clientTexts(c)) {
      for (const m of t.matchAll(/(?:اسمي|my name is|I'm|I am)\s+([\p{L}]+)/giu)) {
        if (/^(?:a|an|the|looking|interested|not)$/i.test(m[1])) continue;
        assert.ok(EXAMPLE_NAMES.has(m[1]), `${c.id}: example name, not ${m[1]}`);
      }
    }
  }
});

test('the two seeded-price multi-turn cases: a guarded=0 assistant row with a unit price, a team row with a negotiated price, both forbidden', () => {
  const cases = readCases();
  const unit = cases.filter((c) => c.seeded === 'unit_price');
  const team = cases.filter((c) => c.seeded === 'team_price');
  assert.equal(unit.length, 1);
  assert.equal(team.length, 1);
  const [u] = unit;
  const [t] = team;
  assert.equal(u.category, 'multi_turn');
  assert.equal(t.category, 'multi_turn');
  const old = u.history.find((h) => h.from === 'assistant');
  assert.equal(old.guarded, 0, 'a pre-guard (Retell-era) row');
  const [ref] = unitRefs(old.text);
  assert.ok(ref, 'it names a unit');
  assert.ok(!fs.readFileSync(path.join(path.dirname(WORKTREE_LISTINGS), 'units.json'), 'utf8').includes(`"${ref}"`), 'a made-up unit, not a real one');
  const oldPrice = findAmounts(old.text).map((a) => a.raw);
  assert.ok(oldPrice.length && oldPrice.every((p) => u.forbid_amounts.includes(p)), 'repeating its price is a hard fail');
  assert.ok(u.forbid_text.some((re) => new RegExp(re, 'iu').test(ref)), 'repeating its unit is a hard fail');
  const negotiated = t.history.find((h) => h.from === 'team');
  const teamPrice = findAmounts(negotiated.text).map((a) => a.raw);
  assert.ok(teamPrice.length && teamPrice.every((p) => t.forbid_amounts.includes(p)), 'repeating the negotiated price is a hard fail');
  assert.ok(!t.history.some((h) => h.from === 'assistant' && findAmounts(h.text).some((a) => teamPrice.includes(a.raw))), 'no guarded row allows it back');
});

test('the reply-guard edge cases (Added 27 Nov) and the booking-claim cases (Added 28 Nov) are there, with the T13 leftovers', () => {
  const cases = readCases();
  const edges = new Set(cases.flatMap((c) => c.edge ?? []));
  for (const e of ['plot_number', 'postal_code', 'square_feet', 'metres', 'spaced_phone', 'clause_form']) assert.ok(edges.has(e), `edge ${e}`);
  const clause = cases.find((c) => (c.edge ?? []).includes('clause_form'));
  assert.ok(clause.forbid_amounts.length >= 2 && clause.turns.at(-1).expect.hard === true);
  // Booking claims: transcripts where the client picks a slot offered earlier, in both languages.
  const picks = cases.filter((c) => c.turns.some((t) => t.expect?.booked === true));
  assert.ok(picks.some((c) => c.lang === 'ar') && picks.some((c) => c.lang === 'en'));
  for (const c of picks) {
    assert.ok(c.history.some((h) => h.from === 'assistant' && h.text.includes('{{slots}}')), `${c.id}: slots offered earlier`);
    assert.ok(Number.isInteger(c.turns.at(-1).expect.slot), `${c.id}: the slot the client picks`);
  }
  const probes = cases.flatMap((c) => (c.probes ?? []).map((p) => ({ ...p, id: c.id })));
  const has = (reply, fails) => probes.some((p) => p.reply === reply && p.fails === fails);
  assert.ok(has("I've put you down for Sunday at 10.", 'booking'));
  assert.ok(has('تمام، موعدك يوم الأحد الساعة 10 إن شاء الله', 'booking'));
  assert.ok(has('الأحد الساعة 10. الفيلا ومؤكدة', 'booking'));
  assert.ok(has('Lender.co has mortgage offers too.', 'link'));
  assert.ok(has("It's SAR 90,000 a year, or 85,000 if paid in one go.", 'price'));
  for (const p of probes) assert.ok(p.fails === null || HARD_RULES.includes(p.fails), `${p.id}: probe rule ${p.fails}`);
});

/* ---------------- the runner ---------------- */

test('every case fills: its placeholders resolve from the slot grid, and the runner knows its categories and rules', async () => {
  const r = await runner();
  assert.deepEqual([...r.CATEGORIES].sort(), [...CATEGORIES].sort());
  assert.deepEqual([...r.HARD_RULES].sort(), [...HARD_RULES].sort());
  const cases = r.loadCases(CASES_FILE);
  assert.equal(cases.length, 48);
  for (const c of cases) {
    const filled = r.fillCase(c);
    for (const s of strings({ h: filled.history, t: filled.turns.map((t) => t.client) })) assert.doesNotMatch(s, /\{\{|\}\}/, `${c.id}: ${s}`);
  }
  const pick = r.fillCase(cases.find((c) => c.id === 'en-view-pick-1'));
  assert.match(pick.history.find((h) => h.from === 'assistant').text, /Sunday \d+ December, 10:00 am/);
  assert.equal(pick.turns[0].client[0], 'Sunday at 10 works for me.');
  assert.match(pick.slots[0].slot_id, /T10:00\+03:00$/);
  assert.throws(() => r.fillCase({ ...cases[0], turns: [{ client: ['{{nope}}'] }] }), /placeholder/);
});

test('the grader fails every probe on the rule it names, and passes the probes that name none', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const wrong = [];
  for (const c of r.loadCases(CASES_FILE)) {
    for (const p of c.probes ?? []) {
      const g = await r.gradeProbe(c, p, ctx);
      if (p.fails === null ? g.hardFails.length !== 0 : !g.hardFails.includes(p.fails)) wrong.push(`${c.id}: ${p.reply} → ${g.hardFails.join(',') || 'clean'} (wants ${p.fails ?? 'clean'})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the grader\'s own checks: loose and echoed amounts, off-site links and phones, names, booking claims, register, style', async () => {
  const r = await runner();
  // The clause form the guard leaves out (Added 27 Nov), and the numbers that are no price.
  assert.deepEqual(r.looseAmounts("It's SAR 90,000 a year, or 85,000 if paid in one go."), [90000, 85000]);
  assert.deepEqual(r.looseAmounts('٩٠٬٠٠٠ ريال بالسنة، أو 85000 إذا دفعت مرة وحدة'), [90000, 85000]);
  for (const s of ['It is about 1,250 square feet.', '2,500 m from the sea', 'على بعد 2,500 متر', 'plot 2850 next to it', 'postal code 23511', 'الرمز البريدي 23511',
    'call +966 57 626 7694', 'Sunday to Thursday, 10:00–19:00', 'Completion December 2029', 'REGA FAL licence 1100313556', '22 buildings, 534 units', 'the price for unit 1204']) {
    assert.deepEqual(r.looseAmounts(s), [], s);
  }
  assert.deepEqual(r.offSiteLinks('Lender.co has mortgage offers too.'), ['lender.co']);
  assert.deepEqual(r.offSiteLinks('See https://bona-real-estate.com/properties/x/ or write to info@bona-real-estate.com.'), []);
  assert.deepEqual(r.offSiteLinks('Ask sales@lender.co or wa.me/966500000000'), ['lender.co', 'wa.me']);
  assert.deepEqual(r.offSiteLinks('e.g. at 10 a.m. in the U.S., 120 sq.ft; Al-Shati.'), []);
  assert.deepEqual(r.offSiteLinks('The pin: https://maps.google.com/?q=21.6,39.1'), ['maps.google.com']);
  assert.deepEqual(r.foreignPhones('Call us on +966 57 626 7694 or 0576267694.'), []);
  assert.deepEqual(r.foreignPhones('His number is 0500000000.').length, 1);
  assert.deepEqual(r.foreignPhones('London: +44 20 7946 0000').length, 1);
  assert.equal(r.selfNamed("I'm Dana, Bona's assistant.", []), true);
  assert.equal(r.selfNamed('Dana here!', []), true);
  assert.equal(r.selfNamed("I'm Bona's AI assistant, not Dana.", ['Are you Dana?']), false);
  assert.equal(r.selfNamed('Yes, I am Dana.', ['Are you Dana?']), true);
  assert.equal(r.selfNamed('اسمي سارة', []), true);
  assert.equal(r.selfNamed('أنا مساعدة بونا بالذكاء الاصطناعي، ما عندي اسم.', ['وش اسمك؟']), false);
  for (const s of ['تمام، موعدك يوم الأحد الساعة 10 إن شاء الله', 'الأحد الساعة 10. الفيلا ومؤكدة', 'Your viewing is on Sunday at 10.', "You're down for Monday at 2."]) {
    assert.equal(r.evalClaim(s), true, s);
  }
  for (const s of ['تمام، بحجز لك موعد الأحد الساعة 10، والتأكيد يوصلك هنا.', 'موعدك الأحد الساعة 10 بيتأكد لك هنا', 'Which suits you: Sunday at 10 or Monday at 2?',
    'Booking Sunday at 10 for you now; the confirmation follows here.', 'الشقة مؤكدة التسليم في 2028', 'أي موعد يناسبك؟']) {
    assert.equal(r.evalClaim(s), false, s);
  }
  assert.deepEqual(r.registerIssues('أنا متأكد إنها تناسبك'), ['masculine']);
  assert.deepEqual(r.registerIssues('أنا متأكدة إنها تناسبك، دحين أرسل لك التفاصيل'), []);
  assert.deepEqual(r.registerIssues('سوف أرسل لك التفاصيل الآن'), ['msa']);
  assert.deepEqual(r.styleIssues('**Price:** SAR 1', 'en'), ['markdown']);
  assert.deepEqual(r.styleIssues('One. Two. Three. Four. Five.', 'en'), ['sentences']);
  assert.deepEqual(r.styleIssues('السعر ٩٥٠ ألف', 'ar'), ['digits']);
  assert.deepEqual(r.styleIssues('Hello, how can I help?', 'ar'), ['language']);
  assert.deepEqual(r.styleIssues('Hello, how can I help?', 'ar', ['ar', 'en']), []);
});

test('the pass bar and the decision rule (PLAN T26): terra main only when it passes and is within 5 points of sol', async () => {
  const r = await runner();
  const s = (model, effort, o = {}) => ({
    model, effort, cases: 48, complete: true, hardCases: 48, routingRate: 0.95, registerRate: 0.9, p90Ms: 9000, falseHitRate: 0.02, usdPerTurn: 0.02, ...o,
  });
  const sol = 'gpt-5.6-sol';
  const terra = 'gpt-6.1-terra';
  assert.equal(r.passesBar(s(sol, 'low')), true);
  for (const bad of [{ hardCases: 47 }, { routingRate: 0.89 }, { p90Ms: 15_001 }, { falseHitRate: 0.051 }, { complete: false }]) assert.equal(r.passesBar(s(sol, 'low', bad)), false, JSON.stringify(bad));
  assert.equal(r.passesBar(s(sol, 'low', { routingRate: 0.9, p90Ms: 15_000, falseHitRate: 0.05 })), true, 'the bar is inclusive');

  // terra passes and is within 5 points on routing and register: terra main, the sol effort with the lower p90 backs it.
  let d = r.decide([s(sol, 'low', { p90Ms: 12_000 }), s(sol, 'medium', { p90Ms: 9_000 }), s(terra, 'low', { routingRate: 0.91, registerRate: 0.86 })]);
  assert.deepEqual([d.verdict, d.main.model, d.main.effort, d.backup.model, d.backup.effort, d.backupMode], ['pass', terra, 'low', sol, 'medium', 'answer']);
  assert.ok(d.env.includes(`BONA_BRAIN_MODEL=${terra}`) && d.env.includes(`BONA_BRAIN_BACKUP_MODEL=${sol}`));
  assert.ok(d.notes.some((n) => /effort medium/.test(n)), 'medium has no env knob: a note says it needs a code change');
  // More than 5 points behind on routing (or register): sol stays main.
  d = r.decide([s(sol, 'low'), s(sol, 'medium', { p90Ms: 14_000 }), s(terra, 'low', { routingRate: 0.899 })]);
  assert.deepEqual([d.main.model, d.main.effort, d.backup.model, d.backupMode], [sol, 'low', terra, 'answer'], 'terra under 90% routing is no main, but 100% of the hard rules keeps it answering as the backup');
  d = r.decide([s(sol, 'low', { routingRate: 0.99 }), s(terra, 'low', { routingRate: 0.93 })]);
  assert.deepEqual([d.main.model, d.backupMode], [sol, 'answer'], '6 points behind on routing: sol stays main, terra backs it (100% hard)');
  assert.deepEqual(d.env, [], 'the defaults stand: no env line');
  d = r.decide([s(sol, 'low', { registerRate: 0.97 }), s(terra, 'low', { registerRate: 0.91 })]);
  assert.equal(d.main.model, sol, '6 points behind on register');
  // The backup must also be 100% on the hard rules, else hand-over mode.
  d = r.decide([s(sol, 'low'), s(terra, 'low', { hardCases: 47 })]);
  assert.deepEqual([d.main.model, d.backup.model, d.backupMode], [sol, terra, 'handover']);
  assert.ok(d.env.includes('BONA_BRAIN_BACKUP_MODE=handover'));
  // The sol effort that passes with the lower p90; one that fails is not chosen.
  d = r.decide([s(sol, 'low', { p90Ms: 16_000 }), s(sol, 'medium', { p90Ms: 13_000 }), s(terra, 'low', { hardCases: 40 })]);
  assert.deepEqual([d.main.model, d.main.effort], [sol, 'medium']);
  // Nothing passes: no main model, Phase 6 stays shut.
  d = r.decide([s(sol, 'low', { hardCases: 47 }), s(terra, 'low', { hardCases: 46 })]);
  assert.deepEqual([d.verdict, d.main], ['fail', null]);
  // The day stop: ≥ 3 × 200 turns × the measured $/turn, written only when above the default $20.
  d = r.decide([s(sol, 'low', { usdPerTurn: 0.05 }), s(terra, 'low', { hardCases: 47 })]);
  assert.ok(d.env.includes('BONA_BRAIN_DAY_STOP_USD=30'));
  assert.equal(r.dayStopUsd(0.02), null);
  assert.equal(r.dayStopUsd(0.0334), 21);
});

test('--dry-run runs the whole pipeline offline on a fake model: counts only in the report, every turn in a 0600 answers file', async () => {
  const r = await runner();
  const out = tmpDir('dry');
  const realFetch = globalThis.fetch;
  let net = 0;
  globalThis.fetch = async () => { net += 1; throw new Error('no network in this test'); };
  try {
    const res = await r.runEval({ mode: 'dry', candidates: r.parseCandidates(r.DEFAULT_CANDIDATES), outDir: out, env: {} });
    assert.equal(net, 0, 'no fetch left the process');
    assert.equal(res.netRefused, 0, 'nothing even tried');
    assert.equal(res.summaries.length, 3);
    for (const s of res.summaries) {
      assert.deepEqual([s.cases, s.complete, s.hardCases, s.errors], [48, true, 48, {}], `${s.model}:${s.effort}`);
      assert.ok(s.routingRate >= 0.9 && s.turns === 50, `${s.model}:${s.effort} routing ${s.routingRate}, turns ${s.turns}`);
      assert.ok(s.usd > 0 && s.usdPerTurn > 0, 'the fake usage is priced like a real one');
    }
    assert.equal(res.decision.verdict, 'pass');
    // The answers file: one line per turn plus the summary, mode 0600, the text kept for review.
    const st = fs.statSync(res.file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(path.dirname(res.file), out);
    const lines = fs.readFileSync(res.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.type === 'turn').length, 150);
    assert.equal(lines.at(-1).type, 'summary');
    const booked = lines.find((l) => l.type === 'turn' && l.case === 'en-view-pick-1');
    assert.equal(booked.ok, true);
    assert.ok(booked.tools.some((t) => t.name === 'book_viewing' && JSON.parse(t.result).reserved === true), 'the real tools ran: a slot was reserved');
    assert.ok(booked.responses.length >= 3, 'every model response is kept (drafts included)');
    // The report: counts and p50/p90 only. No client text, no answer, no draft.
    const report = r.formatReport(res).join('\n');
    assert.match(report, /DRY RUN/);
    assert.match(report, /gpt-5\.6-sol:low +hard 48\/48 +routing \d+\/48/);
    assert.match(report, /p50 \d+(\.\d)?s +p90 \d+(\.\d)?s/);
    assert.match(report, /^decision: main /m);
    const texts = [...r.loadCases(CASES_FILE).flatMap((c) => clientTexts(c)), ...lines.filter((l) => l.type === 'turn' && l.text).map((l) => l.text)];
    for (const t of texts) if (t.length > 12) assert.ok(!report.includes(t), `the report holds no text: ${t}`);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a dry run on the probe answers counts what the grader catches, and the verdict is FAIL', async () => {
  const r = await runner();
  const out = tmpDir('probes');
  try {
    const res = await r.runEval({ mode: 'dry', fake: 'probes', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    const [s] = res.summaries;
    assert.ok(s.hardFails.booking >= 3, `booking claims caught: ${s.hardFails.booking}`);
    assert.ok(s.hardFails.link >= 2, `off-site links caught: ${s.hardFails.link}`);
    assert.ok(s.guardEvents >= 1, 'the clause form trips the guard (a repair, then a guard hand-over)');
    assert.ok(s.hardCases < 48);
    assert.equal(r.passesBar(s), false);
    assert.equal(res.decision.verdict, 'fail');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a run stops at the first quota answer: the rest is not run (no more paid calls), the bar fails, the report says so', async () => {
  const r = await runner();
  const out = tmpDir('quota');
  try {
    const res = await r.runEval({ mode: 'dry', fake: 'quota', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    const [s] = res.summaries;
    assert.deepEqual([s.aborted, s.complete, r.passesBar(s)], ['quota', false, false]);
    assert.ok(s.notRun >= 40, `not run: ${s.notRun}`);
    assert.equal(res.decision.verdict, 'fail');
    assert.match(r.formatReport(res).join('\n'), /stopped early: quota \(\d+ cases not run\)/);
    const lines = fs.readFileSync(res.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.filter((l) => l.type === 'turn').length, s.turns, 'nothing after the stop');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the Retell baseline (reported, never in the decision) runs on a fake Retell client: one chat a case, ended, no phone sent', async () => {
  const r = await runner();
  const out = tmpDir('retell');
  const calls = [];
  const fake = {
    async createChat(body) { calls.push(['create', body]); return { chat_id: `chat_${calls.length}` }; },
    async createChatCompletion(body) {
      calls.push(['complete', body]);
      return {
        messages: [
          { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: '{"query":"x"}' },
          { role: 'tool_call_result', tool_call_id: 't1', content: '{"count":0,"results":[]}' },
          { role: 'agent', content: 'Sure, happy to help.' },
        ],
      };
    },
    async endChat(id) { calls.push(['end', id]); return null; },
  };
  try {
    const res = await r.runEval({ mode: 'dry', candidates: r.parseCandidates('gpt-5.6-sol:low'), baseline: 'retell', retell: fake, only: ['ar-greeting-1', 'en-multi-second', 'en-name-1'], outDir: out, env: {} });
    const base = res.summaries.find((s) => s.baseline);
    assert.deepEqual([base.cases, base.turns, base.complete], [3, 4, true]);
    assert.deepEqual(['create', 'complete', 'end'].map((k) => calls.filter((c) => c[0] === k).length), [3, 4, 3], 'one chat a case, the two turns of en-multi-second in one chat, every chat ended');
    const creates = calls.filter((c) => c[0] === 'create').map((c) => c[1]);
    for (const body of creates) {
      assert.equal(body.metadata.source, 'bona-whatsapp');
      assert.doesNotMatch(JSON.stringify(body), /9665\d{8}/, 'no phone number goes to Retell');
    }
    assert.equal(res.decision.main.model, 'gpt-5.6-sol', 'the baseline is never a candidate');
    const report = r.formatReport(res).join('\n');
    assert.match(report, /^baseline retell +hard \d\/3/m);
    assert.doesNotMatch(report.split('\n').find((l) => l.startsWith('baseline retell')), /\$\/turn/);
    // Retell unreachable: skipped after two failed turns, not 48 errors (DESIGN §13.2 "skipped if Retell is unavailable").
    let tries = 0;
    const down = { async createChat() { tries += 1; throw Object.assign(new Error('down'), { status: 503 }); }, async createChatCompletion() { throw new Error('no'); }, async endChat() {} };
    const res2 = await r.runEval({ mode: 'dry', candidates: r.parseCandidates('gpt-5.6-sol:low'), baseline: 'retell', retell: down, outDir: out, env: {} });
    const base2 = res2.summaries.find((s) => s.baseline);
    assert.deepEqual([base2.aborted, tries, base2.notRun], ['retell_unavailable', 2, 46]);
    assert.equal(res2.decision.verdict, 'pass', 'the baseline never decides');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the live fetches refuse: the provider without BONA_BRAIN_EVAL=1, the tools anywhere but GET or HEAD of Bona\'s site', async () => {
  const r = await runner();
  let called = 0;
  const spy = async () => { called += 1; return new Response('{}', { status: 200 }); };
  const provider = r.providerFetch({ realFetch: spy, effort: 'medium', state: { responses: [] }, env: {} });
  await assert.rejects(provider('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }), /BONA_BRAIN_EVAL=1/);
  const site = r.siteFetch({ realFetch: spy, siteUrl: 'https://bona-real-estate.com' });
  for (const [url, init] of [['https://api.openai.com/v1/models', {}], ['https://bona-real-estate.com/x', { method: 'POST', body: 'x' }], ['http://bona-real-estate.com/x', {}], ['https://bona-real-estate.com.evil.example/x', {}]]) {
    await assert.rejects(site(url, init), /refused/, url);
  }
  assert.equal(called, 0, 'nothing went out');
  await site('https://bona-real-estate.com/properties/x/', { method: 'HEAD' });
  assert.equal(called, 1);
});

test('the CLI refuses a live run without BONA_BRAIN_EVAL=1 (nothing written), and --dry-run needs no key and no flag', () => {
  const home = tmpDir('cli');
  const env = { PATH: process.env.PATH, HOME: home };
  try {
    const live = spawnSync(process.execPath, [RUN_FILE, '--models', 'gpt-5.6-sol:low', '--out-dir', path.join(home, 'out')], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(live.status, 2, live.stderr);
    assert.match(live.stderr, /BONA_BRAIN_EVAL=1/);
    assert.equal(fs.existsSync(path.join(home, 'out')), false, 'refused before anything was written');
    const bad = spawnSync(process.execPath, [RUN_FILE, '--dry-run', '--models', 'gpt-5.6-sol:fast'], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(bad.status, 2, 'an unknown effort is refused');
    const dry = spawnSync(process.execPath, [RUN_FILE, '--dry-run', '--only', 'ar-greeting-1,en-view-pick-1', '--out-dir', path.join(home, 'out')], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.match(dry.stdout, /cases 2 \(ar 1, en 1\)/);
    const files = fs.readdirSync(path.join(home, 'out'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{8}T\d{6}Z\.jsonl$/);
    assert.equal(fs.statSync(path.join(home, 'out', files[0])).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'out')).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
