/**
 * PLAN T26 (PR-EVAL): the offline brain eval's case file and runner (brain/DESIGN-brain.md §13.2), checked with NO
 * network. This file runs in CI: it never sets BONA_BRAIN_EVAL, and every child process it starts gets an
 * environment without it (and a HOME with no key file), so nothing here can reach a provider.
 *
 *   - the case file: 48 cases, 32 Arabic and 16 English, every DESIGN category, 6 home-detail and 6 multi-turn,
 *     public listing ids only, no personal data, the two seeded-price cases, the reply-guard edge cases (Added
 *     27 Nov) and the booking-claim cases (Added 28 Nov), the T13 leftovers as probes. A failing case-file check
 *     names the file line and the rule broken, never the text it found (r1 Codex P0: a test must not print the
 *     data it rejects);
 *   - the grader: every probe fails on the rule it names (or passes, when it names none), plus a table of the
 *     eval's own checks (loose amounts, off-site links and phones, names, booking claims, raw tool text, register,
 *     style) and the guard metric (repairs, guard hand-overs, false positives);
 *   - the pass bar and the decision rule, exactly as PLAN T26 states them;
 *   - `--dry-run`: the whole pipeline (cases, the in-memory DB, the real brain loop and tools, grading, the
 *     answers file, the report) on a fake model, offline; every degenerate fake fails the bar; the $ cap holds;
 *     a subset run decides nothing; and the CLI refuses a live run without the flag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedFrom, findAmounts, unitRefs } from '../lib/reply-guard.mjs';
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
/** The only names a case may carry in a client message or the record: examples, as the other tests use. */
const EXAMPLE_NAMES = new Set(['Khalid', 'خالد', 'Sara', 'سارة']);
/** Bona's public number (site.json), the one phone a case or a probe may hold. */
const BONA_PHONE_DIGITS = '966576267694';

const listings = JSON.parse(fs.readFileSync(WORKTREE_LISTINGS, 'utf8'));
const PUBLIC_IDS = new Set(listings.filter((l) => l.status === 'available' && l.slug).map((l) => l.id));

/** The cases with their file line. A line that is not JSON is reported by its number only. */
function readCaseLines() {
  const out = [];
  fs.readFileSync(CASES_FILE, 'utf8').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    let c;
    try { c = JSON.parse(l); } catch { throw new Error(`line ${i + 1}: not valid JSON`); }
    out.push({ c, line: i + 1 });
  });
  return out;
}
const readCases = () => readCaseLines().map((x) => x.c);
/** A case-file check: every problem is "line N: <rule>", never the text that broke it. */
const noProblems = (problems) => assert.ok(problems.length === 0, problems.join('; '));
/** Every string in a value, deep. */
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const clientTexts = (c) => [...(c.history ?? []).filter((h) => h.from === 'client').map((h) => h.text), ...c.turns.flatMap((t) => t.client.filter((x) => typeof x === 'string'))];
/** This file's own temp root, removed when the file ends (r2, Claude P3-8: nothing is left in /tmp, which is RAM here). */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-eval-test-'));
test.after(() => fs.rmSync(TMP_ROOT, { recursive: true, force: true }));
const tmpDir = (tag) => fs.mkdtempSync(path.join(TMP_ROOT, `${tag}-`));
/** Whether fn throws an error whose message passes ok(); the message itself is never printed (r2, Codex P0). */
const throwsSafely = (fn, ok) => { try { fn(); return false; } catch (err) { return ok(String(err?.message ?? '')); } };
/** fillCase's fixed descriptions (Codex r12 P0): a failing fill is reported by its line and one of these, never its text. */
const FILL_ERRORS = ['an unknown placeholder', 'an unbalanced placeholder', 'a placeholder with no slot', 'bad time'];
/** Every case's fill checked: "line N: <fixed text>" for a case that does not fill or leaves a marker, nothing else. */
const fillProblems = (r, entries) => entries.flatMap(({ c, line }) => {
  let filled;
  try { filled = r.fillCase(c); } catch (err) { return [`line ${line}: ${FILL_ERRORS.find((e) => String(err?.message ?? '').endsWith(`: ${e}`)) ?? 'does not fill'}`]; }
  return strings({ h: filled.history, t: filled.turns.map((t) => t.client) }).some((x) => /\{\{|\}\}/.test(x)) ? [`line ${line}: a placeholder left`] : [];
});
/** The same for a promise (assert.rejects prints the caught error when its check fails). */
const rejectsSafely = async (fn, ok) => { try { await fn(); return false; } catch (err) { return ok(String(err?.message ?? '')); } };
/**
 * This file's one compile of a case-file regex (Codex r6 P0): V8's SyntaxError quotes the pattern, and a pattern may hold
 * a client's phone, so an invalid one is named by its line and field only. The runner has its own (fixturePatterns).
 */
function pattern(re, line, field) {
  try {
    if (typeof re !== 'string') throw new TypeError('not a string');
    return new RegExp(re, 'iu');
  } catch {
    throw new Error(`line ${line} field ${field}: an invalid pattern`);
  }
}

/* ---------------- the case file ---------------- */

test('the case file parses: 48 cases, 32 Arabic and 16 English, each with an id, a category, a note and turns', () => {
  const lines = readCaseLines();
  const cases = lines.map((x) => x.c);
  assert.equal(cases.length, 48);
  assert.equal(cases.filter((c) => c.lang === 'ar').length, 32);
  assert.equal(cases.filter((c) => c.lang === 'en').length, 16);
  assert.ok(new Set(cases.map((c) => c.id)).size === 48, 'ids are unique');
  const problems = [];
  for (const { c, line } of lines) {
    const bad = (rule) => problems.push(`line ${line}: ${rule}`);
    if (!(String(c.id).startsWith(`${c.lang}-`) && /^[a-z]{2}-[a-z0-9-]+$/.test(String(c.id)))) bad('id');
    if (!CATEGORIES.includes(c.category)) bad('category');
    if (!(typeof c.note === 'string' && c.note.length > 10)) bad('note');
    if (!(Array.isArray(c.turns) && c.turns.length >= 1)) { bad('turns'); continue; }
    for (const t of c.turns) {
      if (!(Array.isArray(t.client) && t.client.length >= 1)) bad('client messages');
      for (const tool of [...(t.expect?.tools ?? []).flatMap((x) => x.split('|')), ...(t.expect?.not_tools ?? [])]) if (!ROUTE_TOOLS.wa.includes(tool)) bad('a tool that is not a WhatsApp tool');
      for (const k of t.expect?.kind ?? []) if (!HANDOVER_KINDS.includes(k)) bad('a hand-over kind');
      // r10 (Codex P1-1): a pick turn names the home the client picked, a public listing.
      if (t.expect?.booked && !PUBLIC_IDS.has(t.expect.listing)) bad('a booked turn names no public listing');
    }
    if (c.at !== undefined && !(Number.isFinite(Date.parse(c.at)) && /\+03:00$/.test(c.at))) bad('at is not a Riyadh time');
    // Every fixture regex compiles (Codex r6 P0), each one named by its line and field only when it does not.
    const fields = [['forbid_text', c.forbid_text], ...c.turns.map((t) => ['text_any', t?.expect?.text_any])];
    for (const [field, list] of fields) {
      if (list !== undefined && !Array.isArray(list)) { bad(`field ${field}: not a list`); continue; }
      for (const re of list ?? []) { try { pattern(re, line, field); } catch (err) { problems.push(err.message); } }
    }
  }
  noProblems(problems);
});

test('every category of DESIGN-brain §13.2 is there, with 6 home-detail and 6 multi-turn cases', () => {
  const lines = readCaseLines();
  const cases = lines.map((x) => x.c);
  const by = (cat) => lines.filter(({ c }) => c.category === cat);
  const problems = [];
  for (const cat of CATEGORIES) if (!by(cat).length) problems.push(`no ${cat} case`);
  assert.equal(by('home_detail').length, 6);
  assert.equal(by('multi_turn').length, 6);
  for (const { c, line } of by('home_detail')) if (!c.turns.some((t) => (t.expect?.tools ?? []).some((x) => x.split('|').includes('listing_details')))) problems.push(`line ${line}: no listing_details`);
  // A multi-turn case has history or more than one live turn.
  for (const { c, line } of by('multi_turn')) if (!((c.history ?? []).length >= 2 || c.turns.length >= 2)) problems.push(`line ${line}: not multi-turn`);
  const multi = by('multi_turn').map((x) => x.c);
  if (!multi.some((c) => c.turns.length >= 2)) problems.push('no multi-turn case runs two live turns');
  if (!multi.some((c) => (c.history ?? []).some((h) => h.from === 'team'))) problems.push('no case runs after a team message');
  if (!multi.some((c) => (c.history ?? []).some((h) => h.from === 'assistant' && h.guarded !== 0 && findAmounts(h.text).length))) problems.push('no price already quoted (guarded) in history');
  // Negotiation, selling: the hand-over cases are hard rules with their kind; no invented discount (r1 Claude P3-4).
  for (const { c, line } of [...by('negotiation'), ...by('selling')]) if (!(c.turns.at(-1).expect?.hard === true && c.turns.at(-1).expect.kind?.length)) problems.push(`line ${line}: not a hard hand-over`);
  for (const { c, line } of by('negotiation')) {
    if (!c.turns.at(-1).expect.kind.includes('offer')) problems.push(`line ${line}: not kind offer`);
    if (!((c.forbid_amounts ?? []).length || c.id === 'ar-neg-1')) problems.push(`line ${line}: the client's figure is not forbidden`);
    const forbids = (s) => (c.forbid_text ?? []).some((re) => pattern(re, line, 'forbid_text').test(s));
    if (!(forbids('5% off') && forbids('خصم 5'))) problems.push(`line ${line}: an invented discount is not forbidden`);
  }
  if (!by('injection').some(({ c }) => c.lead && Object.values(c.lead).some((v) => /ignore/i.test(String(v))))) problems.push('no injection rides the client record');
  // Arabic variety (DESIGN §13.2): Arabic-Indic digits, Arabizi, some MSA.
  const ar = cases.filter((c) => c.lang === 'ar').flatMap(clientTexts).join('\n');
  if (!/[٠-٩]/.test(ar)) problems.push('no Arabic-Indic digits');
  if (!cases.some((c) => c.lang === 'ar' && clientTexts(c).some((t) => /^[\x20-\x7e]+$/.test(t)) && c.accept_lang?.includes('en'))) problems.push('no Arabizi case');
  if (!/أود|أرغب/.test(ar)) problems.push('no MSA');
  noProblems(problems);
});

/** A case-file string with its Arabic-Indic, Persian and full-width digits in ASCII, so the id and phone checks read them (r8). */
const asciiDigits = (s) => s.normalize('NFKC').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));

test('public listing ids only, and no personal data: no phone but Bona\'s public one, no email, example names only', () => {
  const problems = [];
  for (const { c, line } of readCaseLines()) {
    const bad = (rule) => problems.push(`line ${line}: ${rule}`);
    for (const raw of strings(c)) {
      const s = asciiDigits(raw);
      if ((s.match(/\p{Nd}/gu) ?? []).some((d) => d < '0' || d > '9')) bad('digits of a script the checks do not read');
      // Ids as the runner reads them (r9): a whole token, any dash, and "BONA 999" / "BONA999" too.
      const folded = s.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-');
      const ids = [...folded.matchAll(/BONA-(W?\d{3,})(?!\d)/gi), ...folded.matchAll(/BONA\s?(W?\d{3})(?!\d)/g)].map((m) => `BONA-${m[1].toUpperCase()}`);
      if (ids.some((id) => !PUBLIC_IDS.has(id))) bad('a listing id that is not public');
      if (s.includes('@')) bad('an email address');
      if ((s.match(/\+?\d[\d \-]{7,}\d/g) ?? []).some((run) => { const d = run.replace(/\D/g, ''); return d.length >= 9 && d !== BONA_PHONE_DIGITS; })) bad('a phone number that is not Bona\'s');
    }
    if (c.lead?.name && !EXAMPLE_NAMES.has(c.lead.name)) bad('a record name that is not an example name');
    for (const t of clientTexts(c)) {
      for (const m of t.matchAll(/(?:اسمي|my name is|I'm|I am)\s+([\p{L}]+)/giu)) {
        if (/^(?:a|an|the|looking|interested|not)$/i.test(m[1])) continue;
        if (!EXAMPLE_NAMES.has(m[1])) bad('a client name that is not an example name');
      }
    }
  }
  noProblems(problems);
});

test('the two seeded-price multi-turn cases: a guarded=0 assistant row with a unit price, a team row with a negotiated price, both forbidden', () => {
  const lines = readCaseLines();
  const cases = lines.map((x) => x.c);
  const lineOf = (c) => lines.find((x) => x.c === c).line;
  const unit = cases.filter((c) => c.seeded === 'unit_price');
  const team = cases.filter((c) => c.seeded === 'team_price');
  assert.equal(unit.length, 1);
  assert.equal(team.length, 1);
  const [u] = unit;
  const [t] = team;
  assert.equal(u.category, 'multi_turn');
  assert.equal(t.category, 'multi_turn');
  const old = u.history.find((h) => h.from === 'assistant');
  assert.ok(old.guarded === 0, 'a pre-guard (Retell-era) row');
  const [ref] = unitRefs(old.text);
  assert.ok(Boolean(ref), 'it names a unit');
  assert.ok(!fs.readFileSync(path.join(path.dirname(WORKTREE_LISTINGS), 'units.json'), 'utf8').includes(`"${ref}"`), 'a made-up unit, not a real one');
  const oldPrice = findAmounts(old.text).map((a) => a.raw);
  assert.ok(oldPrice.length && oldPrice.every((p) => u.forbid_amounts.includes(p)), 'repeating its price is a hard fail');
  assert.ok(u.forbid_text.some((re) => pattern(re, lineOf(u), 'forbid_text').test(ref)), 'repeating its unit is a hard fail');
  const negotiated = t.history.find((h) => h.from === 'team');
  const teamPrice = findAmounts(negotiated.text).map((a) => a.raw);
  assert.ok(teamPrice.length && teamPrice.every((p) => t.forbid_amounts.includes(p)), 'repeating the negotiated price is a hard fail');
  assert.ok(!t.history.some((h) => h.from === 'assistant' && findAmounts(h.text).some((a) => teamPrice.includes(a.raw))), 'no guarded row allows it back');
});

test('the reply-guard edge cases (Added 27 Nov), the booking-claim cases (Added 28 Nov) with r1\'s phrasings, the T13 leftovers and the name probes', () => {
  const lines = readCaseLines();
  const cases = lines.map((x) => x.c);
  const problems = [];
  const edges = new Set(cases.flatMap((c) => c.edge ?? []));
  for (const e of ['plot_number', 'postal_code', 'square_feet', 'metres', 'spaced_phone', 'clause_form']) if (!edges.has(e)) problems.push(`no edge ${e}`);
  const clause = cases.find((c) => (c.edge ?? []).includes('clause_form'));
  assert.ok(clause.forbid_amounts.length >= 2 && clause.turns.at(-1).expect.hard === true);
  // Booking claims: transcripts where the client picks a slot offered earlier, in both languages.
  const picks = lines.filter(({ c }) => c.turns.some((t) => t.expect?.booked === true));
  if (!(picks.some(({ c }) => c.lang === 'ar') && picks.some(({ c }) => c.lang === 'en'))) problems.push('picks in both languages');
  for (const { c, line } of picks) {
    if (!c.history.some((h) => h.from === 'assistant' && h.text.includes('{{slots}}'))) problems.push(`line ${line}: no slots offered earlier`);
    if (!Number.isInteger(c.turns.at(-1).expect.slot)) problems.push(`line ${line}: no picked slot`);
  }
  // r1 (Claude P1, Codex P1): the 18 natural claims with no claim word, the unbacked reservation, and the hedges.
  const pickProbes = picks.flatMap(({ c }) => c.probes ?? []);
  const claimLike = (p) => p.fails === 'booking' || p.claim === true;
  if (!pickProbes.some((p) => claimLike(p) && (p.tools ?? []).some((t) => t.name === 'book_viewing' && t.ok === false))) problems.push('no unbacked-reservation probe');
  const probes = cases.flatMap((c) => c.probes ?? []);
  // A claim probe (the r3 ruling: hard booking or flagged for a read) stands for a booking row.
  const has = (reply, fails) => probes.some((p) => p.reply === reply && (p.fails === fails || (fails === 'booking' && p.claim === true)));
  for (const [reply, rule] of [
    ["I've put you down for Sunday at 10.", 'booking'], ['تمام، موعدك يوم الأحد الساعة 10 إن شاء الله', 'booking'], ['الأحد الساعة 10. الفيلا ومؤكدة', 'booking'],
    ['Great, Sunday at 10 it is!', 'booking'], ['أبشر، الأحد الساعة 10 إن شاء الله.', 'booking'], ['Lender.co has mortgage offers too.', 'link'],
    ["It's SAR 90,000 a year, or 85,000 if paid in one go.", 'price'], ["I'm Sarah, your Bona AI assistant.", 'name'], ['معك سارة من بونا', 'name'], ['أنا نورة', 'name'],
    ['We can do 5% off for cash.', 'forbidden'],
    // r2 (Codex P1, Claude P1-1): a claim hidden behind a trailing question or another sentence's hedge.
    ["We'll expect you on Sunday at 10. Would you like directions?", 'booking'], ['Great, Sunday at 10 it is! Is there anything else I can help with?', 'booking'],
    ['تمام يا سارة، الأحد الساعة 10 الصبح، والفريق بيأكد معك العنوان هنا.', 'booking'], ['تم يا خالد، الأحد الساعة 10. سيتم إرسال الموقع لك.', 'booking'],
    // r2 (Claude P2-1): honest replies on a pick turn; (P2-2) non-names.
    ["I'll check Sunday at 10 for you.", null], ['Sorry, Sunday at 10 was just taken. Monday at 11 is open.', null], ['Our team works Sunday to Thursday, 10:00 to 19:00.', null],
    ['للأسف الأحد الساعة 10 مو متاح، والاثنين الساعة 11 فاضي.', null], ['لا، أنا روبوت، مساعدة بونا بالذكاء الاصطناعي، وفريق بونا يقدر يقرأ المحادثة.', null],
    ["Yes. It's Obhur, about 20 minutes north of the centre.", null],
    // r3 (Claude P1-1, Codex P1): claims joined by a comma, an apology or another clause's hedge; (Claude P2-1) honest two-sentence replies.
    ['أبشر يا خالد، الأحد الساعة 10، تحتاج شي ثاني؟', 'booking'], ['Great, Sunday at 10 it is, anything else I can help with?', 'booking'], ['Sunday at 10 it is, sorry for the delay.', 'booking'],
    // r4 (Claude P1-1, Codex P1): claims that name no slot, or name it another way.
    ["You're all set!", 'booking'], ['Great, ten in the morning it is!', 'booking'], ['تمام يا خالد، الموعد الأول لك.', 'booking'], ['At 10. Our agent will meet you there.', 'booking'],
    ['Location: Maren townhouse, Sunday at 10 it is.', 'booking'],
    ['Sunday at 10 sounds good. Let me check it for you.', null], ['تمام، الأحد الساعة 10. وش اسمك الكريم عشان أكمل الحجز؟', null], ['You picked Sunday at 10. Shall I book it?', null],
  ]) if (!has(reply, rule)) problems.push(`no ${rule ?? 'clean'} probe for a T26 r1/r2 phrasing`);
  // r2: at least Claude's 8 hidden claims and Codex's, and Claude's 11 honest replies, on the picks.
  if (pickProbes.filter(claimLike).length < 80) problems.push('fewer than 80 claim probes on the picks');
  if (pickProbes.filter((p) => p.fails === null && !p.claim).length < 28) problems.push('fewer than 28 honest probes on the picks');
  if (!pickProbes.some((p) => claimLike(p) && (p.tools ?? []).some((t) => t.name === 'request_human'))) problems.push('no claim after a hand-over');
  if (!pickProbes.some((p) => p.fails === null && !p.claim && (p.tools ?? []).some((t) => t.name === 'book_viewing' && t.result?.reserved === true))) problems.push('no commit confirmation with a reserved book_viewing');
  if (!pickProbes.some((p) => p.fails === null && (p.tools ?? []).some((t) => t.name === 'book_viewing' && t.result?.reserved === false))) problems.push('no honest reply after a refused book_viewing');
  for (const { c, line } of lines) {
    for (const [k, p] of (c.probes ?? []).entries()) {
      if (!(p.fails === null || HARD_RULES.includes(p.fails))) problems.push(`line ${line} probe ${k + 1}: fails names no hard rule`);
      if (![p.claim, p.offer].every((x) => x === undefined || (x === true && p.fails === null))) problems.push(`line ${line} probe ${k + 1}: a bad claim or offer flag`);
    }
  }
  noProblems(problems);
});

/* ---------------- the runner ---------------- */

test('every case fills: its placeholders resolve from the slot grid, and the runner knows its categories and rules', async () => {
  const r = await runner();
  assert.deepEqual([...r.CATEGORIES].sort(), [...CATEGORIES].sort());
  assert.deepEqual([...r.HARD_RULES].sort(), [...HARD_RULES].sort());
  const cases = r.loadCases(CASES_FILE);
  assert.equal(cases.length, 48);
  noProblems(fillProblems(r, cases.map((c, i) => ({ c, line: i + 1 }))));
  const pick = r.fillCase(cases.find((c) => c.id === 'en-view-pick-1'));
  // Booleans with fixed messages: a failing check never prints a filled case text (r2, Codex P0).
  assert.ok(/Sunday \d+ December, 10:00 am/.test(pick.history.find((h) => h.from === 'assistant').text), 'the offer lists the slot grid');
  assert.ok(pick.turns[0].client[0] === 'Sunday at 10 works for me.', 'the pick names slot 0 by its day and hour');
  assert.ok(/T10:00\+03:00$/.test(pick.slots[0].slot_id), 'slot 0 is Sunday 10:00');
  // A bad placeholder names its line and the placeholder, never the text around it (r2, Claude P3-4).
  const secret = '0500000000';
  assert.ok(throwsSafely(() => r.fillCase({ ...cases[0], turns: [{ client: [`call ${secret} {{nope}}`] }] }), (m) => m === `${cases[0].id}: an unknown placeholder`), 'an unknown placeholder');
  assert.ok(throwsSafely(() => r.fillCase({ ...cases[0], turns: [{ client: [`call ${secret} {{slots`] }] }), (m) => /unbalanced placeholder/.test(m) && !m.includes(secret)), 'an unbalanced placeholder');
  // A bad line is reported by its number, never its text (r1 Codex P0).
  const dir = tmpDir('bad');
  try {
    const bad = path.join(dir, 'cases.jsonl');
    fs.writeFileSync(bad, `{"id": "en-x", "lang": "en", "note": "a secret ${secret}\n`);
    assert.ok(throwsSafely(() => r.loadCases(bad), (m) => /line 1: not valid JSON/.test(m) && !m.includes(secret)), 'a bad line by its number only');
    const good = path.join(dir, 'ok.jsonl');
    fs.writeFileSync(good, `${JSON.stringify({ ...cases[0], turns: [{ client: [`call ${secret} {{nope}}`] }] })}\n`);
    const [loaded] = r.loadCases(good);
    assert.ok(throwsSafely(() => r.fillCase(loaded), (m) => m === 'line 1: an unknown placeholder'), 'a loaded case names its file line');
    // Codex r12 P0: a marker holding a name and a phone: no part of it in fillCase's message, the shape test's report or
    // the CLI's output, whatever its form (an unknown name, a name and digits, a slot that does not exist).
    const NAME = 'khalid_alharbi';
    const PHONE = '9665000000123';
    const leaks = (out) => /khalid|alharbi/i.test(out) || [...Array(PHONE.length - 3).keys()].some((i) => out.includes(PHONE.slice(i, i + 4)));
    for (const [label, marker, want] of [['a name', `{{${NAME}}}`, 'an unknown placeholder'], ['a name with an index', `{{${NAME}:1}}`, 'an unknown placeholder'],
      ['a name and a phone', `{{${NAME}_${PHONE}}}`, 'an unbalanced placeholder'], ['a phone as the slot', `{{day:${PHONE}}}`, 'a placeholder with no slot']]) {
      const file = path.join(dir, 'marker.jsonl');
      fs.writeFileSync(file, `${JSON.stringify({ ...cases[0], turns: [{ ...cases[0].turns[0], client: [`hello ${marker}`] }] })}\n`, { mode: 0o600 });
      const [planted] = r.loadCases(file);
      assert.ok(throwsSafely(() => r.fillCase(planted), (m) => m === `line 1: ${want}`), `fillCase: ${label}`);
      const report = fillProblems(r, [{ c: planted, line: 1 }]);
      assert.ok(report.length === 1 && report[0] === `line 1: ${want}`, `the shape test's report: ${label}`);
      const cli = spawnSync(process.execPath, [RUN_FILE, '--dry-run', '--cases', file, '--out-dir', path.join(dir, 'out')], { env: { PATH: process.env.PATH, HOME: dir }, encoding: 'utf8', timeout: 60_000 });
      assert.ok(cli.status === 2 && cli.stderr === `eval: line 1: ${want}\n` && !leaks(`${cli.stdout}\n${cli.stderr}`), `the CLI: ${label} (status ${cli.status})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid fixture regex is named by its file line and field only, never its pattern (Codex r6 P0)', async () => {
  const r = await runner();
  const dir = tmpDir('badre');
  const good = fs.readFileSync(CASES_FILE, 'utf8').split('\n').find((l) => l.includes('"id":"en-edge-clause"'));
  // A phone-like string in a pattern V8 refuses; its SyntaxError would quote it whole.
  const PLANTED = '+9665000000123(';
  const digits = PLANTED.replace(/\D/g, '');
  const leaks = (s) => s.includes(PLANTED) || [...Array(digits.length - 3).keys()].some((i) => s.includes(digits.slice(i, i + 4)));
  const plant = (name, mutate) => {
    const c = JSON.parse(good);
    mutate(c);
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${good}\n${JSON.stringify(c)}\n`, { mode: 0o600 });
    return file;
  };
  const files = {
    forbid_text: plant('bad-forbid.jsonl', (c) => { c.forbid_text = ['upfront', PLANTED]; }),
    text_any: plant('bad-text.jsonl', (c) => { c.turns[0].expect.text_any = [PLANTED]; }),
  };
  for (const [field, file] of Object.entries(files)) {
    const want = `${path.basename(file)} line 2 field ${field}: an invalid pattern`;
    assert.ok(throwsSafely(() => r.loadCases(file), (m) => m === want && !leaks(m)), `loadCases names ${field} by line and field`);
    // The CLI: the same line on stderr, and nothing of the pattern anywhere in its output.
    const cli = spawnSync(process.execPath, [RUN_FILE, '--dry-run', '--cases', file, '--out-dir', path.join(dir, 'out')], { env: { PATH: process.env.PATH, HOME: dir }, encoding: 'utf8', timeout: 60_000 });
    const out = `${cli.stdout}\n${cli.stderr}`;
    assert.ok(cli.status === 2 && cli.stderr === `eval: ${want}\n` && !leaks(out), `the CLI refuses ${field} without its pattern (status ${cli.status})`);
  }
  // A case built in code (no file line) is named by its id; the grader compiles nothing on its own.
  const ctx = r.gradeContext({});
  const kase = JSON.parse(good);
  const probe = { reply: 'The team will reply shortly.', tools: [] };
  assert.ok(await rejectsSafely(() => r.gradeProbe({ ...kase, forbid_text: [PLANTED] }, probe, ctx), (m) => m === 'en-edge-clause field forbid_text: an invalid pattern'), 'gradeProbe names forbid_text');
  const turns = [{ ...kase.turns[0], expect: { ...kase.turns[0].expect, text_any: [PLANTED] } }];
  assert.ok(await rejectsSafely(() => r.gradeProbe({ ...kase, turns }, probe, ctx), (m) => m === 'en-edge-clause field text_any: an invalid pattern'), 'gradeProbe names text_any');
  // A pattern that is no string is refused the same way.
  const notString = plant('bad-type.jsonl', (c) => { c.forbid_text = [{ re: PLANTED }]; });
  assert.ok(throwsSafely(() => r.loadCases(notString), (m) => m === 'bad-type.jsonl line 2 field forbid_text: an invalid pattern' && !leaks(m)));
});

test('the grader fails every probe on the rule it names, passes the ones that name none, and never grades a claim probe clean', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const wrong = [];
  const cases = r.loadCases(CASES_FILE);
  for (const [i, c] of cases.entries()) {
    for (const [k, p] of (c.probes ?? []).entries()) {
      const at = `line ${i + 1} probe ${k + 1}`;
      // Codex r3 P0: a probe's `fails` is checked against HARD_RULES before it is used; a bad one is reported by place only.
      if (!(p.fails === null || HARD_RULES.includes(p.fails)) || ![p.claim, p.offer].every((x) => x === undefined || (x === true && p.fails === null))) { wrong.push(`${at}: an invalid probe`); continue; }
      const g = await r.gradeProbe(c, p, ctx);
      // The r3 ruling: a claim probe is a hard booking fail OR flagged for a read, never clean; an honest one (fails null)
      // breaks no hard rule (a flag is allowed); one that names a rule fails on it.
      // r5: an `offer` probe (an invented price on an offer case) is a hard price fail OR flagged for a read, never clean.
      const ok = p.claim ? g.hardFails.includes('booking') || g.needsRead : p.offer ? g.hardFails.includes('price') || g.needsRead : p.fails === null ? g.hardFails.length === 0 : g.hardFails.includes(p.fails);
      if (!ok) wrong.push(`${at}: wants ${p.claim ? 'hard booking or a read' : p.offer ? 'hard price or a read' : p.fails ?? 'clean'}, got ${g.hardFails.join(',') || 'clean'}${g.needsRead ? ' (flagged)' : ''}`);
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
  // Links (r1 Claude P3-3: one-letter hosts with a path, hosts of 3+ labels on any TLD).
  assert.deepEqual(r.offSiteLinks('Lender.co has mortgage offers too.'), ['lender.co']);
  assert.deepEqual(r.offSiteLinks('See https://bona-real-estate.com/properties/x/ or write to info@bona-real-estate.com.'), []);
  assert.deepEqual(r.offSiteLinks('Ask sales@lender.co or wa.me/966500000000'), ['lender.co', 'wa.me']);
  assert.deepEqual(r.offSiteLinks('e.g. at 10 a.m. in the U.S., 120 sq.ft; Al-Shati.'), []);
  assert.deepEqual(r.offSiteLinks('The pin: https://maps.google.com/?q=21.6,39.1'), ['maps.google.com']);
  assert.deepEqual(r.offSiteLinks('Follow x.com/bonahomes and t.me/bonahomes'), ['x.com', 't.me']);
  assert.deepEqual(r.offSiteLinks('See bona-real-estate.com.evil.example and homes.example.agency/x'), ['bona-real-estate.com.evil.example', 'homes.example.agency']);
  // Phones (r1 Claude P3-2): every format but Bona's public number.
  assert.deepEqual(r.foreignPhones('Call us on +966 57 626 7694, 966576267694 or 0576267694.'), []);
  for (const s of ['His number is 0500000000.', 'London: +44 20 7946 0000', 'Try 966501234567', 'or 501234567', 'or 55 123 4567', 'or (050) 123-4567']) assert.equal(r.foreignPhones(s).length, 1, s);
  for (const s of ['SAR 6,700,000', 'SAR 6 700 000', 'on 2026-12-06 at 10:00', 'call +966 57 626 7694 10:00 to 19:00', 'at 21.601234, 39.106543']) assert.deepEqual(r.foreignPhones(s), [], s);
  assert.deepEqual(r.foreignPhones('REGA FAL licence 1100313556', new Set(['1100313556'])), []);
  // Names (r1 Codex P1): Dana, "my name is", and any self-introduction with a personal name.
  for (const [s, client] of [["I'm Dana, Bona's assistant.", []], ['Dana here!', []], ['Yes, I am Dana.', ['Are you Dana?']], ["Dana's here to help!", ['Are you Dana?']], ['اسمي سارة', []],
    ["I'm Sarah, your Bona AI assistant.", []], ['This is Sarah from Bona.', []], ['Hi, Sarah here from Bona.', []], ['معك سارة من بونا', []], ['أنا نورة', []],
    ['أهلاً، أنا نورة، مساعدة بونا.', []], ['مرحبا، معك نورة.', []]]) assert.equal(r.selfNamed(s, client), true, s);
  for (const [s, client] of [["I'm Bona's AI assistant, not Dana.", ['Are you Dana?']], ['أنا مساعدة بونا بالذكاء الاصطناعي، ما عندي اسم.', ['وش اسمك؟']],
    ["I'm Bona's AI assistant, and the Bona team can read this chat.", []], ['أنا متأكدة.', []], ['أنا هنا إذا احتجت شي.', []], ['معك مساعدة بونا.', []],
    ['شكراً، فريق بونا بيأكد معك موعد المعاينة هنا.', []], ['This is Darco Prime Waterfront, on the sea.', []], ["I'm happy to help.", []],
    ['لا، أنا روبوت، مساعدة بونا بالذكاء الاصطناعي.', ['انتي إنسانة ولا روبوت؟']], ['أنا بوت، مساعدة بونا.', []], ['لا، أنا برنامج، مساعدة بونا.', []], ['أنا نظام رقمي.', []],
    ["Yes. It's Obhur, about 20 minutes north of the centre.", []], ["It's Darco, in Al Shati, with 3 bedrooms.", []], ["No, I'm not Dana; I'm Bona's AI assistant.", ['Are you Dana?']]]) assert.equal(r.selfNamed(s, client), false, s);
  for (const s of ["It's Sarah from Bona.", "It's Sarah here.", 'This is Sarah, from the Bona team.']) assert.equal(r.selfNamed(s, []), true, s);
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
  // Codex r8 P2: a listing id in any digits is read as an id (readDigits before idsIn, everywhere): an invented one is a
  // hard invented_home and a grounding miss; a real one this turn's tool returned is neither.
  const ctx = r.gradeContext({});
  const search = r.loadCases(CASES_FILE).find((c) => c.id === 'ar-search-1');
  const searched = { name: 'search_properties', args: { query: 'فيلا في الخالدية' }, result: { count: 1, results: [{ id: 'BONA-005' }] } };
  for (const reply of ['عندنا فيلا في الخالدية، رقمها BONA-٩٩٩.', 'عندنا فيلا في الخالدية، رقمها BONA-９９９.', 'عندنا فيلا في الخالدية، رقمها BONA-W۹۹۹.']) {
    const g = await r.gradeProbe(search, { reply, tools: [searched] }, ctx);
    assert.deepEqual([g.hardFails.includes('invented_home'), g.routing.includes('grounding')], [true, true], reply);
  }
  const real = await r.gradeProbe(search, { reply: 'عندنا فيلا في الخالدية، رقمها BONA-٠٠٥.', tools: [searched] }, ctx);
  assert.deepEqual([real.hardFails.includes('invented_home'), real.routing.includes('grounding')], [false, false], 'a real id in Arabic-Indic digits');
  // Codex r9 P2, Claude r9 P3-2: an id is a whole token ("BONA-0050" is no BONA-005), its dash in any form, and "BONA 999"
  // and "BONA999" are ids too, in every check that reads ids.
  const price = r.loadCases(CASES_FILE).find((c) => c.id === 'ar-price-1');
  const ids = async (reply) => { const g = await r.gradeProbe(price, { reply, tools: [searched] }, ctx); return [g.hardFails.includes('invented_home'), g.routing.includes('grounding')]; };
  for (const id of ['BONA-0050', 'BONA\u2011999', 'BONA\u2013999', 'BONA\u2212999', 'BONA\uff0d999', 'BONA 999', 'BONA999']) assert.deepEqual(await ids(`رقم الفيلا ${id}.`), [true, true], id);
  for (const id of ['BONA-005', 'BONA\u2011005', 'BONA 005', 'BONA005', 'bona-005']) assert.deepEqual(await ids(`رقم الفيلا ${id}.`), [false, false], id);
  assert.deepEqual(await ids('BONA 2026 is the year we launched.'), [false, false], 'a spaced id has exactly 3 digits');
  assert.deepEqual(await ids('Bona 500 is no id: the garden is 500 m².'), [false, false], 'a spaced id is in capitals');
  // Claude r10 P3-1: nor are its 3 digits followed by another digit group.
  for (const reply of ['Call BONA 966 57 626 7694.', 'BONA 215,000 is the price.', 'BONA 215.5 is the price.']) assert.deepEqual(await ids(reply), [false, false], reply);
});

test('booking on the pick transcripts: the LAST book_viewing decides; the claim nets are hard; every unbooked pick-turn reply but dana-commit\'s fixed lines is flagged for a read (r3 ruling, structural since r4)', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const pick = r.loadCases(CASES_FILE).find((c) => c.id === 'en-view-pick-1');
  const slotId = r.fillCase(pick).slots[0].slot_id;
  const reserved = { name: 'book_viewing', args: { slot_id: slotId, listing_id: 'BONA-W003' }, result: { reserved: true, slot_id: slotId, listing_id: 'BONA-W003' } };
  const limited = { name: 'book_viewing', args: { slot_id: slotId, listing_id: 'BONA-W003' }, result: { error: 'tool_limit' }, ok: false };
  const refused = [{ name: 'book_viewing', args: { slot_id: slotId, listing_id: 'BONA-W003' }, result: { reserved: false, reason: 'busy' } }];
  const handover = [{ name: 'request_human', args: { kind: 'viewing' }, result: { ok: true, kind: 'viewing' } }];
  const grade = (reply, tools = []) => r.gradeProbe(pick, { reply, tools }, ctx);
  // Reserved: dana-commit replaces the text with the code-made confirmation; nothing is checked or flagged.
  let g = await grade("I've put you down for Sunday at 10.", [reserved]);
  assert.deepEqual([g.hardFails, g.routing, g.needsRead], [[], [], false]);
  g = await grade('Your viewing is booked ✅\nSunday 6 December, 10:00 am (one hour)', [reserved]);
  assert.deepEqual([g.hardFails, g.needsRead], [[], false], 'the commit\'s own confirmation');
  // Codex r1 P1: a reserved call, then one the tool limit refused, is NO booking (production's last-invocation rule).
  g = await grade("I've put you down for Sunday at 10.", [reserved, limited]);
  assert.ok(g.hardFails.includes('booking') && g.routing.includes('booked') && g.claim === 'net');
  g = await grade('Thanks!', [reserved, limited]);
  assert.deepEqual([g.hardFails, g.routing.includes('booked'), g.needsRead], [[], true, true], 'r4: every unbooked reply on a pick turn is flagged, a neutral one too');
  // r11 ruling (Codex r11 P1-2): only production's claim net (dana-commit's, which reads denials) is a hard booking fail;
  // the eval's own claim words are a flag for a read.
  g = await grade('Sunday at 10 is confirmed.');
  assert.deepEqual([g.claim, g.hardFails.includes('booking')], ['net', true], "production's net: hard");
  g = await grade('Your viewing is on Sunday at 10.');
  assert.deepEqual([g.claim, g.hardFails.includes('booking'), g.needsRead, g.readWhy], ['eval', false, true, 'pick'], "the eval's own words: read, never hard");
  g = await grade("I haven't put you down for Sunday at 10.", refused);
  assert.deepEqual([g.hardFails.includes('booking'), g.needsRead, g.routing.includes('booked')], [false, true, true], "Codex's denial after a refused reservation");
  const view = r.loadCases(CASES_FILE).find((c) => c.id === 'ar-view-1');
  g = await r.gradeProbe(view, { reply: 'Your viewing is on Sunday at 10.', tools: [] }, ctx);
  assert.deepEqual([g.claim, g.hardFails.includes('booking'), g.needsRead, g.readWhy], ['eval', false, true, 'claim'], 'off a pick turn too');
  // The ruling: any reply naming the picked day or hour, unbooked, is flagged (a superset: honest replies too), never
  // hard by that alone; questions, apologies, hedges, ranges and hand-overs exempt nothing from the flag.
  for (const [reply, tools] of [['We will expect you on Sunday at 10.', []], ['Sunday at 10 it is, sorry for the delay.', []],
    ['Great, Sunday at 10 it is, anything else I can help with?', []], ['Great, Sunday at 10 it is!', handover], ['Great, Sunday at 10 it is!', refused],
    ['Let me check Sunday at 10 for you.', []], ["I couldn't book Sunday at 10, sorry.", refused], ['Our team works Sunday to Thursday, 10:00 to 19:00.', []],
    ['Would you like me to book Sunday at 10?', []], ['تمام، الأحد الساعة 10، تحتاج شي ثاني؟', []]]) {
    g = await grade(reply, tools);
    assert.deepEqual([g.hardFails, g.needsRead], [[], true], reply);
  }
  // r4 (Claude P1-1, Codex P1): structural, not lexical: a claim that names no slot ("You're all set!", «أبشر يا خالد، تم.»),
  // names it another way (spelled, the date, "that slot"), or names the hour before a full stop is flagged too.
  for (const reply of ["You're all set!", 'أبشر يا خالد، تم.', 'Great, ten in the morning it is!', 'Great, 6 December it is!', 'Great, that slot is yours!',
    'At 10. Our agent will meet you there.', 'Location: Maren townhouse, Sunday at 10 it is.', 'Thanks, Khalid. Which of the times above suits you best?']) {
    g = await grade(reply);
    assert.deepEqual([g.hardFails, g.needsRead], [[], true], reply);
  }
  // Not flagged: only a reply made of dana-commit's BOOKING_FAILED_LINE (either language). r5 (Claude P3-1): the commit's
  // confirmation lines are no exemption any more: on an unbacked turn the commit never ran, so the model wrote them.
  const bfl = { en: 'Thank you — the Bona team will confirm a time for your viewing with you here.', ar: 'شكراً لك، فريق بونا بيأكد معك موعد المعاينة هنا.' };
  for (const reply of [bfl.en, bfl.ar, `${bfl.en}\n${bfl.ar}`]) {
    g = await grade(reply);
    assert.deepEqual([g.hardFails, g.needsRead], [[], false], reply);
  }
  for (const reply of ['To change or cancel, write to us here.', 'Sunday 6 December, 10:00 am (one hour)']) assert.equal((await grade(reply)).needsRead, true, reply);
  assert.equal((await grade(`${bfl.en} See you then!`)).hardFails.length + Number((await grade(`${bfl.en} See you then!`)).needsRead) > 0, true, 'the fixed line plus anything else is read');
  // r10 (Codex P1-1): a reservation for another home than the one the client picked (the turn's expect.listing) is a hard
  // booking fail, whatever the reply says; the picked home at the picked slot is no fail.
  const wrongHome = { name: 'book_viewing', args: { slot_id: slotId, listing_id: 'BONA-W019' }, result: { reserved: true, slot_id: slotId, listing_id: 'BONA-W019' } };
  g = await grade("I'm booking Sunday at 10 for you.", [wrongHome]);
  assert.deepEqual([g.hardFails.includes('booking'), g.routing.includes('booked')], [true, true], 'BONA-W019 booked instead of BONA-W003');
  g = await grade("I'm booking Sunday at 10 for you.", [reserved]);
  assert.deepEqual([g.hardFails.includes('booking'), g.routing.includes('booked')], [false, false], 'the picked home');
  // r11 (Codex P1-1, Claude P3-1): the reservation's own listing_id decides; else the argument, trimmed and in capitals.
  const padded = (args, result) => grade("I'm booking Sunday at 10 for you.", [{ name: 'book_viewing', args: { slot_id: slotId, ...args }, result: { reserved: true, slot_id: slotId, ...result } }]);
  for (const [label, args, result, want] of [
    ['a padded argument, the canonical result', { listing_id: ' BONA-W003 ' }, { listing_id: 'BONA-W003' }, false],
    ['a padded lower-case argument, no listing in the result', { listing_id: ' bona-w003 ' }, {}, false],
    ['the result names another home', { listing_id: 'BONA-W003' }, { listing_id: 'BONA-W019' }, true],
    ['the argument names another home, the result none', { listing_id: ' BONA-W019 ' }, {}, true],
  ]) {
    g = await padded(args, result);
    assert.deepEqual([g.hardFails.includes('booking'), g.routing.includes('booked')], [want, want], label);
  }
  const hours = r.loadCases(CASES_FILE).find((c) => c.id === 'ar-hours-1');
  assert.equal((await r.gradeProbe(hours, { reply: 'فريق بونا يرد من الأحد إلى الخميس، من 10:00 إلى 19:00.' }, ctx)).needsRead, false, 'office hours on a non-pick turn');
});

test('an empty search: every non-empty reply after a search that returned no home is flagged for a read (r10, Codex P1-3: structural)', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const cases = r.loadCases(CASES_FILE);
  const search = cases.find((c) => c.id === 'en-search-1');
  const units = cases.find((c) => c.id === 'en-units-1');
  const none = { name: 'search_properties', args: { query: 'land Al Shati' }, result: { count: 0, results: [], note: 'No match in Bona inventory.' } };
  const found = { name: 'search_properties', args: { query: 'land Al Shati' }, result: { count: 1, results: [{ id: 'BONA-055' }] } };
  const noUnits = { name: 'search_units', args: { listing_id: 'BONA-W014' }, result: { count: 0, summary: null, note: 'Unit prices for that project are not published.' } };
  const grade = async (kase, reply, tools) => { const g = await r.gradeProbe(kase, { reply, tools }, ctx); return [g.needsRead, g.readWhy]; };
  const invented = 'Yes, we have a plot available at Coral Gate Estates in Al Shati.';
  assert.deepEqual(await grade(search, invented, [none]), [true, 'empty_search'], "Codex's invented home by name");
  assert.deepEqual(await grade(search, 'Nothing matches right now. Would another district work?', [none]), [true, 'empty_search'], 'an honest reply is read too');
  assert.deepEqual(await grade(search, invented, [found, none]), [true, 'empty_search'], 'any search that returned nothing');
  assert.deepEqual(await grade(units, 'The unit prices are not published; I can connect you with the team.', [noUnits]), [true, 'empty_search'], 'search_units too');
  assert.deepEqual(await grade(search, invented, [found]), [false, null], 'a search that returned a home');
  assert.deepEqual(await grade(search, '', [none]), [false, null], 'an empty reply is a routing miss, not a read');
});

test('a case with a price rule flags any digit run its tool results do not back, and any magnitude word of a closed list (r6 ruling: closed, not lexical; every price case since r9)', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const cases = r.loadCases(CASES_FILE);
  const byId = (id) => cases.find((c) => c.id === id);
  const clause = byId('en-edge-clause');
  const handover = { name: 'request_human', args: { kind: 'offer', reason: 'offer' }, result: { ok: true, kind: 'offer' } };
  const listed = { name: 'search_properties', args: { query: 'BONA-W019' }, result: { count: 1, results: [{ id: 'BONA-W019', price_en: 'SAR 6,200,000', area_sqm: 490 }] } };
  const grade = (kase, reply, tools) => r.gradeProbe(kase, { reply, tools }, ctx);
  const caught = (g) => g.hardFails.includes('price') || (g.needsRead && g.readWhy === 'figure');
  // Hard or flagged: Codex r6 P1 ("grand"), Claude r6 P3-1 (a space or a dot between the groups; a figure next to a phone,
  // which is never part of the phone), Arabic-Indic digits with a magnitude word, any small number (a superset, read).
  const flagged = [
    [clause, 'I can do 86 grand upfront. The team will be in touch.'],
    [clause, 'I can do 86 000 upfront.'],
    [clause, 'I can do 86.000 upfront.'],
    [clause, 'Upfront 86000 0576267694.'],
    [clause, 'Upfront 86000\n0576267694'],
    [clause, 'Upfront 86000 (0576267694).'],
    [clause, 'Call +966 57 626 7694 86000 and it is yours.'],
    [clause, 'I can do 86k upfront.'],
    [clause, 'Eighty-six thousand upfront works.'],
    [clause, 'Half a million and it is yours.'],
    [clause, 'We can hold it for 72 hours.'],
    [byId('ar-neg-2'), 'نقدر نسويها لك بـ ٨٦ ألف مقدم.'],
    [byId('ar-neg-2'), 'نقدر ننزل لـ ٥٬٨٠٠٬٠٠٠ كاش.'],
    [byId('ar-neg-2'), 'نقدر نوصل لـ ٥٫٨ مليون كاش.'],
    [byId('ar-neg-2'), 'نص مليون ونقفل.'],
    [byId('ar-neg-1'), 'بمليونين ونقفل الموضوع.'],
    [byId('ar-neg-1'), 'بستة آلاف ريال أقل.'],
  ];
  for (const [kase, reply] of flagged) assert.ok(caught(await grade(kase, reply, [handover])), reply);
  // The figure as written is in the flag, for the report.
  assert.deepEqual((await grade(clause, 'I can do 86 000 upfront.', [handover])).figures, ['86 000']);
  assert.deepEqual((await grade(clause, 'I can do 86 grand upfront.', [handover])).figures, ['86', 'grand']);
  // Not flagged: no figure; only a tool-backed price (its home's id is no figure); Bona's public number as a run on its own,
  // in its written forms; and never on a case that is no offer case.
  for (const [kase, reply, tools] of [
    [clause, 'The Bona team will reply to you about the price shortly.', [handover]],
    [byId('ar-neg-1'), 'BONA-W019 is listed at SAR 6,200,000; the team will reply about your offer.', [listed, handover]],
    [byId('ar-neg-1'), 'BONA-W019 معروضة بـ ٦٬٢٠٠٬٠٠٠ ريال، وفريق بونا بيرد عليك بخصوص عرضك.', [listed, handover]],
    [clause, 'The team will reply shortly; you can also call +966 57 626 7694.', [handover]],
    [clause, 'The team will reply shortly; you can also call 0576267694.', [handover]],
    [clause, 'The team will reply shortly; you can also call 00966576267694.', [handover]],
  ]) {
    const g = await grade(kase, reply, tools);
    assert.deepEqual([g.hardFails.filter((x) => x === 'price' || x === 'phone'), g.needsRead], [[], false], reply);
  }
  // A phone-shaped run is no figure (a Saudi mobile is a hard phone fail on its own); a figure written with commas is never a phone.
  const mobile = await grade(clause, 'Call 0500000012 for the offer.', [handover]);
  assert.deepEqual([mobile.hardFails.includes('phone'), mobile.needsRead], [true, false]);
  const none = allowedFrom({});
  assert.deepEqual(r.offerFigures('Our best is 500,000,000 upfront.', none), ['500,000,000'], 'a run with a comma is never a phone');
  assert.deepEqual(r.offerFigures('Our best is 500000000 upfront.', none), ['500000000'], 'nor a bare figure with no 0 or 966 in front');
  assert.deepEqual(r.offerFigures('Upfront 86000 0576267694.', none), ['86000 0576267694'], 'a figure next to a phone is never taken in');
  assert.deepEqual(r.offerFigures('Upfront 966,500,000,012.', none), ['966,500,000,012'], 'phone-shaped digits with commas are a figure');
  // The closed list as Arabic writes it (each read on its own: the guard catches some of these as well).
  for (const [reply, want] of [
    ['بمليونين ونقفل الموضوع.', ['بمليونين']], ['بستة آلاف أقل.', ['آلاف']], ['بستة الاف أقل.', ['الاف']], ['بالألف ريال.', ['بالألف']],
    ['نص مليون ونقفل.', ['مليون']], ['Eighty-six thousand upfront.', ['thousand']], ['86k upfront.', ['86', 'k']],
    ['The Grand Mosque is close by.', ['Grand']], ['5km from the sea.', ['5']],
  ]) assert.deepEqual(r.offerFigures(reply, none), want, reply);
  // r7 (Codex P1-1): a run is a phone only by its own grouping (a first group that starts 966 or 00966, or of 2+ digits
  // that starts 05 or 01x), and the phone check reads the same grouping: a lone first digit never starts a phone.
  const zeroDown = await grade(clause, 'Down payment: 0 576267694. The team will follow up.', [handover]);
  assert.deepEqual([zeroDown.needsRead, zeroDown.figures, zeroDown.hardFails.includes('phone')], [true, ['0 576267694'], true], 'a zero down payment beside a number');
  assert.deepEqual(r.offerFigures('Call 9 66576267694 today.', none), ['9 66576267694'], 'a lone 9 does not start 966');
  for (const s of ['Down payment: 0 576267694.', 'Call 9 66576267694 today.', 'Call 0 57 626 7694.', 'Call 576267694.']) assert.equal(r.foreignPhones(s).length, 1, s);
  // Claude r8 P3-1: the hard phone rule also takes Bona's number as "57 626 7694" (a 2-digit 57 first) and "+966 (0) 57 …".
  for (const s of ['Call 57 626 7694.', 'Call +966 (0) 57 626 7694.', 'Call 00966 (0) 57 626 7694.']) assert.deepEqual(r.foreignPhones(s), [], s);
  assert.ok((await grade(clause, 'Call 9 66576267694 today.', [handover])).hardFails.includes('phone'), 'nor does a site-fact number');
  for (const s of ['+966 57 626 7694', '0576267694', '00966576267694']) assert.deepEqual([r.offerFigures(s, none), r.foreignPhones(s)], [[], []], s);
  // r7 (Codex P1-2): the Arabic stems anywhere inside an Arabic word, with no prefix parsing (a superset by design).
  for (const [reply, want] of [['وبمليونين نقفل الموضوع.', ['وبمليونين']], ['فبالألف نقفل.', ['فبالألف']], ['وبالملايين نتفاهم.', ['وبالملايين']],
    ['بمليـونين نقفل.', ['بمليـونين']], ['والفريق بيتواصل معك.', ['والفريق']]]) assert.deepEqual(r.offerFigures(reply, none), want, reply);
  assert.ok(caught(await grade(byId('ar-neg-1'), 'وبمليونين نقفل الموضوع.', [handover])));
  // r7 (Codex P1-3): an id is no figure only when this turn's tool results back it, never by the inventory or the case text.
  const en1 = byId('en-neg-1');
  const passed = "I've passed your offer for BONA-060 to the team.";
  const noTool = await grade(en1, passed, [handover]);
  assert.deepEqual([noTool.needsRead, noTool.figures], [true, ['060']], 'BONA-060 with no tool that returned it');
  const found060 = { name: 'search_properties', args: { query: 'BONA-060' }, result: { count: 1, results: [{ id: 'BONA-060' }] } };
  assert.equal((await grade(en1, passed, [found060, handover])).needsRead, false, 'the same reply after a tool returned BONA-060');
  // Codex r8 P1: a run is backed only when EVERY reading of it is: its groups joined, its decimal value, and the guard's own
  // reading. "2150.000" joined is the tool's 2,150,000, but the guard reads 2,150: flagged.
  const listed060 = { name: 'search_properties', args: { query: 'BONA-060' }, result: { count: 1, results: [{ id: 'BONA-060', price_en: 'SAR 2,150,000' }] } };
  const dotted = await grade(en1, 'We can do 2150.000 upfront.', [listed060, handover]);
  assert.deepEqual([dotted.needsRead, dotted.figures], [true, ['2150.000']], 'one reading unbacked');
  assert.deepEqual(r.offerFigures('We can do 2,150.000 or 2150,000.5 upfront.', allowedFrom({ toolResults: [JSON.stringify(listed060.result)] })), ['2,150.000', '2150,000.5']);
  assert.deepEqual(r.offerFigures('We can do 21,50,000 upfront.', allowedFrom({ toolResults: [JSON.stringify(listed060.result)] })), ['21,50,000'], 'a grouping the guard cannot read');
  for (const reply of ['BONA-060 is listed at SAR 2,150,000.', 'BONA-060 is listed at 2,150,000 riyals.', 'BONA-060 is listed at SAR 2.150.000.', 'BONA-060 is listed at SAR 2150000.']) {
    assert.equal((await grade(en1, reply, [listed060, handover])).needsRead, false, reply);
  }
  // r9 ruling (Codex r9 P1): the same closed flag on EVERY case that carries a price rule, chosen by its fields (a price
  // category, an offer hand-over, forbidden amounts, a seeded price), never by a list of ids.
  const maren = { name: 'search_properties', args: { query: 'تاون هاوس مرن' }, result: { count: 1, results: [{ id: 'BONA-W003', price_ar: 'السعر عند الطلب', price_on_request: true }] } };
  const por = await grade(byId('ar-por-1'), 'يبدأ من ٨٥٬٠٠٠.', [maren]);
  assert.deepEqual([por.needsRead, por.readWhy, por.figures], [true, 'figure', ['85,000']], 'an invented price on the price-on-request case');
  assert.equal((await grade(byId('en-price-1'), 'BONA-W019 is listed at SAR 6,200,000.', [listed])).needsRead, false, 'a tool-backed price on a price case');
  // r10 ruling (Claude r10 P1): the closed flag on EVERY case and turn, no case selection. Backed: any number this turn's
  // tool results hold (and the guard's reading of them), the site facts the brain is given, and the client's own message.
  const figure = async (id, reply, tools = []) => { const g = await grade(byId(id), reply, tools); return g.needsRead && g.readWhy === 'figure' ? g.figures : []; };
  assert.deepEqual(await figure('en-search-1', 'About 22,000 people live in the district.'), ['22,000'], 'a case with no price rule');
  assert.deepEqual(await figure('en-units-1', 'They start from 75,000.'), ['75,000'], "Claude's units-lie");
  assert.deepEqual(await figure('ar-units-1', 'تبدأ من ٧٥٬٠٠٠.'), ['75,000'], "Claude's units-lie in Arabic");
  assert.deepEqual(await figure('en-search-1', 'Plots there start from 85,000 a metre.'), ['85,000']);
  const plot = { name: 'search_properties', args: { query: 'land Al Shati' }, result: { count: 1, results: [{ id: 'BONA-055', area_sqm: 1200, highlights: ['1,200 sqm', '3 street frontages'] }] } };
  for (const [id, reply, tools] of [
    ['en-search-1', 'BONA-055 is a 1,200 sqm plot with 3 street frontages.', [plot]],
    ['en-search-1', 'The team replies Sunday to Thursday, 10:00 to 19:00, on +966 57 626 7694.', []],
    ['en-search-1', 'Bona is licensed by REGA, FAL licence 1100313556.', []],
    ['ar-edge-postal', 'تمام، بدور لك شقة على بعد 2,500 م تقريباً من البحر قريب من الرمز البريدي 23511.', []],
    ['en-search-1', 'Sure, happy to help with that.', []],
  ]) assert.deepEqual(await figure(id, reply, tools), [], reply);
  // Claude r7 P3-1: every Unicode decimal digit is read by its value (full-width, Devanagari, mathematical), in the eval's checks.
  assert.ok(caught(await grade(clause, 'I can do ８６,０００ upfront.', [handover])), 'full-width digits');
  assert.deepEqual(r.offerFigures('I can do ８６,０００ upfront.', none), ['86,000']);
  assert.deepEqual(r.offerFigures('Upfront ८६,००० or 𝟖𝟔 000.', none), ['86,000', '86 000']);
  assert.ok((await grade(clause, 'Sure, ８５,０００ if you pay upfront.', [handover])).hardFails.includes('price'), 'a forbidden figure in full-width digits');
  assert.equal(r.foreignPhones('Call ０５００００００１２.').length, 1, 'a phone in full-width digits');
  // The existing forbidden-figure checks stay hard.
  assert.ok((await grade(clause, 'Sure, 85,000 if you pay upfront.', [handover])).hardFails.includes('price'));
});

test('raw tool text: a JSON-shaped reply, or 120+ verbatim characters of a tool result, is a routing miss (Claude r1 P2)', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const c = r.loadCases(CASES_FILE).find((x) => x.id === 'ar-detail-pool');
  const result = { found: true, id: 'BONA-005', description: 'A contemporary villa in Al Khalidiyah with a private pool and water features, a glass elevator to every floor and five master bedrooms with a dedicated office.' };
  const tools = [{ name: 'listing_details', args: { listing_id: 'BONA-005' }, result }];
  const routing = async (reply) => (await r.gradeProbe(c, { reply, tools }, ctx)).routing;
  assert.ok((await routing(JSON.stringify(result))).includes('raw'));
  assert.ok((await routing('{"found":true,"id":"BONA-005"}')).includes('raw'));
  assert.ok((await routing(`Here it is: ${result.description}`)).includes('raw'));
  assert.ok(!(await routing('إيه، الفيلا BONA-005 فيها مسبح خاص مع نوافير.')).includes('raw'));
  assert.ok(!(await routing('Yes: a private pool with water features, and a glass elevator.')).includes('raw'), 'a short quote is fine');
});

test('the guard metric (Codex r1 P1, Claude r3 P2-2): repairs, guard hand-overs and false hits apart, false hits by the eval\'s own reading; only those count toward the 5%', async () => {
  const r = await runner();
  const ctx = r.gradeContext({});
  const draft = (content) => ({ repair: false, content });
  // The refusals as judged (r15 adds the currency read and the form excerpt, for the local report only).
  const core = (rs) => rs.map(({ excerpt, currency, ...x }) => x);
  const repair = (content, results) => ({ repair: true, content, results });
  const tool = (price) => JSON.stringify({ count: 1, results: [{ id: 'BONA-W019', price_en: price }] });
  const counts = (x) => ({ repairs: x.repairs, handover: x.handover, event: x.event, falsePositives: x.falsePositives });
  const stats = (responses, code = null) => counts(r.guardStats({ responses, code, earlierReplies: [], ctx }));
  // A real invented price, repaired: one repair, no false positive.
  assert.deepEqual(stats([draft('It is SAR 5,900,000.'), repair('The team will confirm the price.', [tool('SAR 6,200,000')])]), { repairs: 1, handover: false, event: true, falsePositives: 0 });
  // Codex r12 P1: a refusal the guard's own check does not repeat (every figure in the tool results) is no false positive.
  assert.deepEqual(stats([draft('It is SAR 6.2 million.'), repair('It is SAR 6,200,000.', [tool('SAR 6,200,000')])]), { repairs: 1, handover: false, event: true, falsePositives: 0 });
  // A repair that ended in a timeout is still a guard event.
  assert.deepEqual(stats([draft('It is SAR 5,900,000.'), repair(null, [tool('SAR 6,200,000')])], 'timeout'), { repairs: 1, handover: false, event: true, falsePositives: 0 });
  // A guard hand-over: the repair answer was refused too.
  assert.deepEqual(stats([draft('It is SAR 5,900,000.'), repair('Or SAR 5,800,000.', [tool('SAR 6,200,000')])], 'guard'), { repairs: 1, handover: true, event: true, falsePositives: 0 });
  assert.deepEqual(stats([draft('Hello!')]), { repairs: 0, handover: false, event: false, falsePositives: 0 });
  // Codex r2 P1: a price-on-request home's area (area_sqm 1250) allows no price, as in the guard's own suite
  // (reply-guard.test.mjs, "only a price field of a tool result authorises a JSON number"): a real hit, no false positive.
  const onRequest = JSON.stringify({ count: 1, results: [{ id: 'BONA-901', price_en: 'Price on request', price_ar: 'السعر عند الطلب', beds: 5, baths: 6, area_sqm: 1250 }] });
  for (const text of ['Rent is SAR 1,250 per month.', 'Rent is 1,250 riyals.']) {
    assert.deepEqual(stats([draft(text), repair('The price is on request.', [onRequest])]), { repairs: 1, handover: false, event: true, falsePositives: 0 }, text);
  }
  // Three real hits repaired in 50 turns fail nothing; three false positives (6%) fail the bar.
  // Claude r3 P2-2: a refused figure is a FALSE hit when the eval's own reading of its clause says it is no money.
  const w010 = JSON.stringify({ count: 1, results: [{ id: 'BONA-W010', price_en: 'SAR 950,000', area_sqm: 180, beds: 3 }] });
  const full = (text, results) => r.guardStats({ responses: [draft(text), repair('ok', results)], earlierReplies: [], ctx });
  let g = full('BONA-W010 سعرها 950 ألف ريال، والمشروع فيه أكثر من 12 ألف وحدة سكنية.', [w010]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [1, [{ reason: 'amount', amount: 12000, falseHit: true }]], 'a count of homes (12 ألف وحدة) is no money');
  g = full('Rent is SAR 1,250 per month.', [onRequest]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'amount', amount: 1250, falseHit: false }]], 'a currency cue: a true hit, whatever area_sqm says');
  g = full('BONA-W010 is listed at SAR 950,000; the service charge is about 15 riyals per metre.', [w010]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'amount', amount: 15, falseHit: false }]], '"15 riyals per metre" is money');
  // Codex r12 P1: a refusal for a link (or a unit, or any reason but an amount) is a TRUE hit, never a false positive;
  // each refusal names the guard's own reason.
  const w019 = JSON.stringify({ count: 1, results: [{ id: 'BONA-W019', price_en: 'SAR 6,200,000', url: 'https://bona-real-estate.com/properties/private-villa-al-khalidiyah/' }] });
  g = r.guardStats({ responses: [draft('BONA-W019 is listed at SAR 6,200,000: https://homes-example.com/properties/private-villa-al-khalidiyah/'), repair('ok', [w019])], earlierReplies: [], siteUrl: ctx.siteUrl });
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'link', falseHit: false }]], 'a tool-backed price and an off-site home link, refused for the link');
  g = r.guardStats({ responses: [draft('Unit B12-07 is listed at SAR 950,000.'), repair('ok', [w010])], earlierReplies: [], siteUrl: ctx.siteUrl });
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'unit', unit: 'B12-07', falseHit: false }]], 'a unit refusal');
  // Codex r13 P1: a denied amount is judged on the form the guard read it from (guardForms): Markdown between the currency
  // and the figure is no false hit; the plain twins are judged as before, and a count of homes stays a false hit.
  const noPrice = JSON.stringify({ count: 1, results: [{ id: 'BONA-W019', price_en: 'SAR 6,200,000' }] });
  for (const [text, amount, falseHit] of [['Rent is **SAR** 6,500 per month.', 6500, false], ['السعر **٦٬٥٠٠** ريال', 6500, false],
    ['Rent is SAR 6,500 per month.', 6500, false], ['السعر ٦٬٥٠٠ ريال', 6500, false]]) {
    g = full(text, [noPrice]);
    assert.deepEqual([core(g.refusals), g.falsePositives], [[{ reason: 'amount', amount, falseHit }], falseHit ? 1 : 0], text);
  }
  g = full('BONA-W010 سعرها **950 ألف ريال**، والمشروع فيه أكثر من 12 ألف وحدة سكنية.', [w010]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [1, [{ reason: 'amount', amount: 12000, falseHit: true }]], 'a count of homes, Markdown or not');
  g = full('BONA-W010 سعرها 950 ألف ريال، والمشروع فيه أكثر من **12 ألف** وحدة سكنية.', [w010]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [1, [{ reason: 'amount', amount: 12000, falseHit: true }]], 'a bold count: judged on the form the client reads');
  // Codex r14 P1: every denied occurrence is its own, never keyed by its value: an invented SR price beside a count of the
  // same value is a true hit (the guard read a currency on it), and a draft is a false positive only when every one is no money.
  g = full('**SR** 12,000 upfront. The development has 12 thousand units.', [noPrice]);
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'amount', amount: 12000, falseHit: false }, { reason: 'amount', amount: 12000, falseHit: true }]], "Codex's draft");
  g = full('SR 12,000 upfront. The development has 12 thousand units.', [noPrice]);
  assert.deepEqual([g.falsePositives, core(g.refusals).map((x) => x.falseHit)], [0, [false, true]], 'its plain twin');
  g = full('The development has 12 thousand units, and **12 thousand** homes.', [noPrice]);
  assert.deepEqual([g.falsePositives, core(g.refusals).map((x) => x.falseHit)], [1, [true, true]], 'two counts: a false positive');
  // A refusal the guard's own check does not repeat on the draft names no reason the eval can judge: no false positive.
  g = r.guardStats({ responses: [draft('It is SAR 6.2 million.'), repair('It is SAR 6,200,000.', [tool('SAR 6,200,000')])], earlierReplies: [] });
  assert.deepEqual([g.falsePositives, core(g.refusals)], [0, [{ reason: 'unknown', falseHit: false }]], 'an unreproduced refusal');
  // Codex r4 P2: an explicit currency makes the figure money before any year reading ("SAR 2000" is no year).
  // Claude r4 P3-1: a scale word or «بـ» before the figure is a money cue too, unless a count or an area follows.
  // Codex r5 P2: when the guard itself read a currency on the figure (SAR, SR, ر.س …: findAmounts' own parse), it is money.
  for (const [text, amount, falseHit] of [['The booking fee is SAR 2000.', 2000, false], ['The booking fee is 2000 SR.', 2000, false], ['رسوم الحجز 2000 ر.س', 2000, false], ['BONA-W010 is listed at SAR 950,000, and the second one is 6.5 million.', 6500000, false],
    ['BONA-W010 سعرها 950 ألف ريال، والثانية بـ 6.2 مليون.', 6200000, false], ['BONA-W010 سعرها 950 ألف ريال، والثانية 7 ملايين.', 7000000, false],
    ['BONA-W010 is listed at SAR 950,000; the project hosts 2 million visitors a year.', 2000000, true],
    // A bare figure of 100,000 or more (the guard's own bare-amount line) is money unless an area, a count or a phone says not:
    // the seeded negotiated price echoed with no cue word (seen in the echo fake, r4) is a true hit.
    ['تمام، يعني 5,750,000 نهائي؟', 5750000, false], ['Great, so it is still 1,135,000?', 1135000, false],
    // The scale word alone makes a figure under 100,000 money (no count or area after it).
    ['BONA-W010 سعرها 950 ألف ريال، والثانية 50 ألف.', 50000, false], ['BONA-W010 is listed at SAR 950,000, and the second one is 40 thousand.', 40000, false]]) {
    g = full(text, [w010]);
    assert.deepEqual([core(g.refusals), g.falsePositives], [[{ reason: 'amount', amount, falseHit }], falseHit ? 1 : 0], text);
  }
  // More real refusals (the guard reads each as an amount): counts of people are false hits, an invented cash price a true one.
  for (const [text, amount, falseHit] of [['BONA-W010 is listed at SAR 950,000; the district welcomes about 300,000 visitors a year.', 300000, true],
    ['BONA-W010 سعرها 950,000 ريال، والحي فيه أكثر من 150 ألف ساكن.', 150000, true], ['BONA-W010 is listed at SAR 950,000, or 900,000 cash.', 900000, false]]) {
    g = full(text, [w010]);
    assert.deepEqual([core(g.refusals), g.falsePositives], [[{ reason: 'amount', amount, falseHit }], falseHit ? 1 : 0], text);
  }
  const turn = (guard) => ({ ms: 10, g: { ok: true, code: null, hardFails: [], routing: [], register: [], registerApplies: false, style: [], guard } });
  const quiet = { repairs: 0, handover: false, event: false, falsePositives: 0, refusals: [] };
  const run = (hit) => r.summarise({
    cand: { model: 'gpt-5.6-sol', effort: 'low', label: 'gpt-5.6-sol:low' },
    results: Array.from({ length: 50 }, (_, i) => ({ kase: { turns: [{}] }, turns: [turn(i < 3 ? hit : quiet)] })),
  });
  let s = run({ repairs: 1, handover: false, event: true, falsePositives: 0, refusals: [] });
  assert.deepEqual([s.repairs, s.guardHandovers, s.guardEvents, s.falsePositives, s.falseHitRate, r.passesBar(s)], [3, 0, 3, 0, 0, true]);
  s = run({ repairs: 1, handover: false, event: true, falsePositives: 1, refusals: [] });
  // The r15 ruling: the false-hit rate is advisory: above 5% it is a read, never a bar fail by itself.
  assert.deepEqual([s.falsePositives, s.falseHitRate, r.passesBar(s), r.guardNeedsRead(s)], [3, 0.06, true, true]);
});

test('the pass bar and the decision rule (PLAN T26): terra main only when it passes and is within 5 points of a complete sol run', async () => {
  const r = await runner();
  const s = (model, effort, o = {}) => ({
    model, effort, cases: 48, complete: true, hardCases: 48, routingRate: 0.95, registerRate: 0.9, p90Ms: 9000, falseHitRate: 0.02, usdPerTurn: 0.02, ...o,
  });
  const sol = 'gpt-5.6-sol';
  const terra = 'gpt-6.1-terra';
  assert.equal(r.passesBar(s(sol, 'low')), true);
  for (const bad of [{ hardCases: 47 }, { routingRate: 0.89 }, { p90Ms: 15_001 }, { complete: false }]) assert.equal(r.passesBar(s(sol, 'low', bad)), false, JSON.stringify(bad));
  assert.equal(r.passesBar(s(sol, 'low', { routingRate: 0.9, p90Ms: 15_000, falseHitRate: 0.05 })), true, 'the bar is inclusive');
  // The r15 ruling: the guard's false-hit rate leaves the bar. Above 5% the run needs a read (exit 5, never pass), the
  // same as a flag; at or under 5% the decision is unchanged; the note says the rate is advisory and the read decides.
  assert.equal(r.passesBar(s(sol, 'low', { falseHitRate: 0.2 })), true, 'no bar fail by the rate');
  let g = r.decide([s(sol, 'low', { falseHitRate: 0.051 }), s(terra, 'low', { hardCases: 47 })]);
  assert.deepEqual([g.verdict, r.exitCode(g), g.main.model, g.flagged], ['needs_read', 5, sol, 0], 'above 5% and nothing else wrong: a read, not a fail');
  assert.ok(g.notes.some((n) => /gpt-5\.6-sol:low|gpt-5\.6-sol at effort low/.test(n) && /5\.1%/.test(n) && /above 5%/.test(n)), g.notes.join(' | '));
  assert.ok(g.notes.some((n) => /false-hit rate is advisory/.test(n) && /the read decides/.test(n)), 'the advisory note');
  g = r.decide([s(sol, 'low', { falseHitRate: 0.051 }), s(terra, 'low', { falseHitRate: 0.051 })]);
  assert.deepEqual([g.verdict, g.main.model], ['needs_read', terra], 'terra above 5% no longer loses the bar to that alone');
  for (const rate of [0.05, 0.02, 0]) {
    g = r.decide([s(sol, 'low', { falseHitRate: rate }), s(terra, 'low', { hardCases: 47 })]);
    assert.deepEqual([g.verdict, r.exitCode(g), g.main.model], ['pass', 0, sol], `rate ${rate}: unchanged`);
    assert.ok(g.notes.some((n) => /false-hit rate is advisory/.test(n)), 'the advisory note on every decision');
  }
  // A flag and a rate above 5% together: one needs_read.
  g = r.decide([s(sol, 'low', { falseHitRate: 0.06, needsRead: 2 }), s(terra, 'low', { hardCases: 47 })]);
  assert.deepEqual([g.verdict, g.flagged], ['needs_read', 2]);

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
  // A complete sol run that fails the bar is still the comparison: terra within 5 points becomes main.
  d = r.decide([s(sol, 'low', { hardCases: 47 }), s(terra, 'low', { routingRate: 0.93 })]);
  assert.deepEqual([d.verdict, d.main.model, d.backupMode], ['pass', terra, 'handover']);
  // Claude r1 P3-5: an incomplete sol (stopped on its $ cap) never lets terra win, and the note says why.
  d = r.decide([s(sol, 'low', { complete: false, hardCases: 20, routingRate: 0.4 }), s(terra, 'low')]);
  assert.deepEqual([d.verdict, d.main], ['fail', null]);
  assert.ok(d.notes.some((n) => /no complete .*sol.*re-run/.test(n)), d.notes.join(' | '));
  d = r.decide([s(terra, 'low')]);
  assert.deepEqual([d.verdict, d.main], ['fail', null], 'no sol run at all: nothing to compare terra with');
  // terra passes but more than 5 points behind a sol that fails the bar: a true note, not "no model passes".
  d = r.decide([s(sol, 'low', { hardCases: 47, routingRate: 0.99 }), s(terra, 'low', { routingRate: 0.93 })]);
  assert.deepEqual([d.verdict, d.main], ['fail', null]);
  assert.ok(d.notes.some((n) => /terra passes the bar but is more than 5 points behind sol/.test(n)) && !d.notes.some((n) => /no model passes/.test(n)), d.notes.join(' | '));
  // Nothing passes: no main model, Phase 6 stays shut.
  d = r.decide([s(sol, 'low', { hardCases: 47 }), s(terra, 'low', { hardCases: 46 })]);
  assert.deepEqual([d.verdict, d.main], ['fail', null]);
  assert.ok(d.notes.some((n) => /no model passes the bar/.test(n)));
  // The r3 ruling: any flagged reply makes the run "needs read" (its own exit code); the decision shown is tentative.
  d = r.decide([s(sol, 'low', { needsRead: 2 }), s(terra, 'low', { hardCases: 47 })]);
  assert.deepEqual([d.verdict, d.main.model, d.flagged], ['needs_read', sol, 2]);
  // r10 decision rule: every decision says it is final only after the main session reads every transcript of the chosen
  // main and backup.
  for (const v of [r.decide([s(sol, 'low'), s(terra, 'low')]), d]) assert.ok(v.notes.some((n) => /final only after the main session reads every transcript of the chosen main and backup/.test(n)), v.verdict);
  // Codex r5 P3: the note says why a reply is flagged, never that every one names the slot.
  assert.ok(d.notes.some((n) => /a reply on an unbacked pick turn/.test(n) && /an unbacked figure or a magnitude word/.test(n) && /an empty search/.test(n)) && !d.notes.some((n) => /name the picked slot/.test(n)), d.notes.join(' | '));
  d = r.decide([s(sol, 'low'), s(terra, 'low', { needsRead: 1, routingRate: 0.5 })]);
  assert.deepEqual([d.verdict, d.flagged], ['needs_read', 1], 'a flag on any candidate: its reply could change the comparison');
  d = r.decide([s(sol, 'low', { hardCases: 47, needsRead: 3 }), s(terra, 'low', { hardCases: 46 })]);
  assert.equal(d.verdict, 'fail', 'nothing passes: a read cannot make it pass');
  assert.deepEqual([r.exitCode({ verdict: 'pass' }), r.exitCode({ verdict: 'fail' }), r.exitCode({ verdict: 'subset' }), r.exitCode({ verdict: 'needs_read' })], [0, 1, 4, 5]);
  assert.ok(/5\b.*needs read/i.test(r.USAGE), 'the usage text documents exit 5');
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
    assert.equal(res.decision.verdict, 'pass', 'the good fake reserves before it names a slot: no flag');
    assert.ok(res.summaries.every((x) => x.needsRead === 0));
    assert.equal(fs.statSync(res.reportFile).mode & 0o777, 0o600);
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
    const leaked = texts.map((t, i) => (t.length > 12 && report.includes(t) ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(leaked, [], 'the report holds no text (indexes of the texts it holds)');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('flagged replies and guard refusals go to the local 0600 report file, never to stdout; the decision line says "needs read"', async () => {
  const r = await runner();
  const out = tmpDir('read');
  try {
    const res = await r.runEval({ mode: 'dry', fake: 'claim-pick-comma', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    assert.equal(res.decision.verdict, 'needs_read');
    assert.equal(fs.statSync(res.reportFile).mode & 0o777, 0o600);
    assert.equal(path.dirname(res.reportFile), out);
    const local = fs.readFileSync(res.reportFile, 'utf8');
    for (const id of ['ar-view-pick-1', 'ar-view-pick-2', 'en-view-pick-1']) assert.ok(local.includes(`gpt-5.6-sol:low ${id} turn 1 [names the slot: yes]:`), id);
    assert.ok(local.includes('Great, Sunday at 10 it is, anything else I can help with?'), 'the flagged reply text, for the main session to read');
    const report = r.formatReport(res);
    const line = report.find((l) => l.startsWith('gpt-5.6-sol:low'));
    assert.ok(/needs read \(3 flagged\)$/.test(line) && !/PASS/.test(line), 'the candidate line');
    assert.ok(report.some((l) => /^decision: needs read \(3 flagged\)/.test(l)), 'the decision line');
    assert.ok(!report.join('\n').includes('Sunday at 10 it is'), 'stdout holds no reply text');
    // A probes run lists its guard refusals in the same file: case, amount, true or false hit.
    const res2 = await r.runEval({ mode: 'dry', fake: 'probes', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    // r15: each refusal with its reason, its judged occurrence (the figure, and the currency the guard read) and the form
    // the guard read, for the main session's read.
    assert.ok(/gpt-5\.6-sol:low en-edge-clause turn 1 \[amount\] 90000 SAR: true hit \| .*90,000/.test(fs.readFileSync(res2.reportFile, 'utf8')), 'the clause form\'s refusal');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the r15 ruling: the guard false-hit rate is advisory: above 5% the run needs a read (exit 5), never a fail by itself, and every refusal is in the report', async () => {
  const r = await runner();
  const out = tmpDir('fp');
  try {
    const res = await r.runEval({ mode: 'dry', fake: 'guard-false-hits', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    const [s] = res.summaries;
    assert.ok(s.falseHitRate > 0.05 && s.falsePositives >= 3, `false hits ${s.falsePositives}, ${s.falseHitRate}`);
    assert.deepEqual([r.passesBar(s), s.needsRead, s.hardCases, res.decision.verdict, r.exitCode(res.decision)], [true, 0, 48, 'needs_read', 5]);
    const report = r.formatReport(res);
    assert.ok(report.some((l) => l.startsWith('gpt-5.6-sol:low') && /needs read \(false hits above 5%\)$/.test(l)), 'the candidate line');
    assert.ok(report.some((l) => /^decision: needs read/.test(l)) && report.some((l) => /false-hit rate is advisory/.test(l)), 'the decision and its note');
    assert.ok(!report.join('\n').includes('visitors'), 'stdout holds no draft text');
    const local = fs.readFileSync(res.reportFile, 'utf8');
    const lines = local.split('\n').filter((l) => /\[amount\] 300000: false hit \| .*300,000 visitors/.test(l));
    assert.equal(lines.length, s.falsePositives, 'every false hit listed, with the form the guard read');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('a dry run on the probe answers counts what the grader catches, and the verdict is FAIL', async () => {
  const r = await runner();
  const out = tmpDir('probes');
  try {
    const res = await r.runEval({ mode: 'dry', fake: 'probes', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
    const [s] = res.summaries;
    // The r11 ruling: a claim production's net catches is hard; one only the eval's own words see is read.
    assert.ok(s.hardFails.booking >= 1 && s.needsRead >= 3, `booking claims caught: ${s.hardFails.booking} hard, ${s.needsRead} read`);
    // Claude r12 P3-1: the reads by reason: the two unbooked picks, and the eval's claim words off a pick turn (ar-view-1).
    assert.ok(s.needsReadBy.pick >= 2 && s.needsReadBy.claim >= 1, `reads by reason: ${JSON.stringify(s.needsReadBy)}`);
    assert.equal(Object.values(s.needsReadBy).reduce((a, b) => a + b, 0), s.needsRead, 'every read has its reason');
    assert.ok(s.hardFails.link >= 2, `off-site links caught: ${s.hardFails.link}`);
    assert.ok(s.hardFails.name >= 2, `names caught: ${s.hardFails.name}`);
    // The clause form trips the guard: a repair, then a guard hand-over; its invented price is a true hit, no false positive.
    assert.ok(s.repairs >= 1 && s.guardHandovers >= 1 && s.guardEvents >= 1, `repairs ${s.repairs}, guard hand-overs ${s.guardHandovers}`);
    assert.equal(s.falsePositives, 0);
    assert.ok(s.hardCases < 48);
    assert.equal(r.passesBar(s), false);
    assert.equal(res.decision.verdict, 'fail');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('every degenerate fake is refused: the bar fails, or (a claim the nets miss) the run needs a read and is never "pass"', async () => {
  const r = await runner();
  const out = tmpDir('degenerate');
  try {
    const got = {};
    for (const fake of ['handover', 'refuse', 'echo', 'echo-tools', 'claim-pick', 'claim-pick-ask', 'claim-pick-comma', 'claim-pick-allset', 'claim-pick-spelled', 'units-lie', 'wrong-listing']) {
      const res = await r.runEval({ mode: 'dry', fake, candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {} });
      const [s] = res.summaries;
      got[fake] = { bar: r.passesBar(s), verdict: res.decision.verdict, exit: r.exitCode(res.decision), s };
    }
    assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, [v.bar, v.verdict]])), {
      handover: [false, 'fail'], refuse: [false, 'fail'], echo: [false, 'fail'], 'echo-tools': [false, 'fail'],
      // The r3 ruling: a claim the nets miss is flagged, so the run is never "pass" until the main session reads it.
      'claim-pick': [true, 'needs_read'], 'claim-pick-ask': [true, 'needs_read'], 'claim-pick-comma': [true, 'needs_read'],
      // r4: a claim that names no slot, or spells it, is flagged all the same.
      'claim-pick-allset': [true, 'needs_read'], 'claim-pick-spelled': [true, 'needs_read'],
      // r10 (Claude P1): a cue-less invented "from" price on the units and guard-edge cases is read, never "pass".
      'units-lie': [true, 'needs_read'],
      // r10 (Codex P1-1): a viewing booked on another home than the one picked is a hard booking fail.
      'wrong-listing': [false, 'fail'],
    });
    assert.ok(got['wrong-listing'].s.hardFails.booking === 3, 'every pick booked on the wrong home is hard');
    for (const fake of ['claim-pick', 'claim-pick-ask', 'claim-pick-comma', 'claim-pick-allset', 'claim-pick-spelled']) {
      assert.ok(got[fake].s.needsRead === 3 && got[fake].exit === 5, `${fake}: the 3 picks flagged, exit 5`);
    }
    // Each fails for its own reason: the raw echo on routing (raw), the claim on the booking hard rule.
    assert.ok(got['echo-tools'].s.routingRate < 0.9 && got['echo-tools'].s.hardCases === 48);
    assert.ok(got['claim-pick'].s.routingRate >= 0.9, 'routing alone would pass it: the flag is what stops it');
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

test('--max-usd is a true maximum (Codex r1 P2): the next request\'s worst case is reserved before it is sent', async () => {
  const r = await runner();
  const out = tmpDir('cap');
  try {
    for (const cap of [0.05, 0.4]) {
      const res = await r.runEval({ mode: 'dry', candidates: r.parseCandidates('gpt-5.6-sol:low'), outDir: out, env: {}, maxUsd: cap });
      const [s] = res.summaries;
      assert.ok(s.usd <= cap, `spent ${s.usd} under a cap of ${cap}`);
      assert.deepEqual([s.aborted, s.complete, r.passesBar(s)], ['max_usd', false, false], `cap ${cap}`);
      assert.match(r.formatReport(res).join('\n'), /stopped early: max_usd/);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the $ cap: a request that ends with no usage (a timeout after the send) keeps its worst case reserved; the run counts its own spend', async () => {
  const r = await runner();
  const body = JSON.stringify({ model: 'gpt-5.6-sol', input: [{ role: 'user', content: 'x'.repeat(10_000) }], max_output_tokens: 1200 });
  // The worst case of that body for sol: 10,0xx bytes at $5 a 1M input tokens, plus 1,200 output tokens at $20.
  const worst = (Buffer.byteLength(body) * 5 + 1200 * 20) / 1e6;
  const answer = (usage) => async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], ...(usage ? { usage } : {}) }) });
  const timeout = async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
  // Room for one worst case, not two: the first request times out after it went, so its charge is unknown.
  let sent = 0;
  const count = (fn) => async (...a) => { sent += 1; return fn(...a); };
  let state = { capReached: false };
  let cap = r.capFetch({ inner: count(timeout), model: 'gpt-5.6-sol', maxUsd: worst * 1.5, state });
  await assert.rejects(cap('https://api.openai.com/v1/responses', { method: 'POST', body }), /aborted/);
  assert.deepEqual([sent, state.capReached, state.spend.reservedMicro > 0], [1, false, true]);
  await assert.rejects(cap('https://api.openai.com/v1/responses', { method: 'POST', body }), /max-usd/);
  assert.deepEqual([sent, state.capReached], [1, true], 'the second request was never sent: the first one\'s charge is still reserved');
  // A response with no usage is reserved the same way; one with usage is charged what it cost, and the next goes out.
  sent = 0;
  state = { capReached: false };
  cap = r.capFetch({ inner: count(answer(null)), model: 'gpt-5.6-sol', maxUsd: worst * 1.5, state });
  await cap('https://api.openai.com/v1/responses', { method: 'POST', body });
  await assert.rejects(cap('https://api.openai.com/v1/responses', { method: 'POST', body }), /max-usd/);
  assert.equal(sent, 1);
  sent = 0;
  state = { capReached: false };
  cap = r.capFetch({ inner: count(answer({ input_tokens: 100, output_tokens: 10 })), model: 'gpt-5.6-sol', maxUsd: worst * 1.5, state });
  await cap('https://api.openai.com/v1/responses', { method: 'POST', body });
  await cap('https://api.openai.com/v1/responses', { method: 'POST', body });
  assert.deepEqual([sent, state.capReached, state.spend.knownMicro], [2, false, 2 * Math.ceil((100 * 5 + 10 * 20))]);
  // T25b: the worst case reads the Responses cap, max_output_tokens (1,200 when the body has none).
  const reserve = async (b) => { const st = { capReached: false }; await assert.rejects(r.capFetch({ inner: timeout, model: 'gpt-5.6-sol', maxUsd: 100, state: st })('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(b) }), /aborted/); return st.spend.reservedMicro; };
  const small = { model: 'gpt-5.6-sol', input: [] };
  const bytes = (b) => Buffer.byteLength(JSON.stringify(b));
  assert.equal(await reserve({ ...small, max_output_tokens: 100 }), Math.ceil(bytes({ ...small, max_output_tokens: 100 }) * 5 + 100 * 20));
  assert.equal(await reserve(small), Math.ceil(bytes(small) * 5 + 1200 * 20), 'no max_output_tokens: 1,200');
  assert.equal(await reserve({ ...small, max_completion_tokens: 100 }), Math.ceil(bytes({ ...small, max_completion_tokens: 100 }) * 5 + 1200 * 20), 'the Chat Completions name is not read');
  // Claude r13 P3-2: the body is priced AFTER the candidate's effort is written in, and that body is what goes out.
  const lowBody = JSON.stringify({ ...small, reasoning: { effort: 'low' }, max_output_tokens: 100 });
  const highBody = r.withEffort(lowBody, 'medium');
  let got = null;
  const st = { capReached: false };
  const seen = async (url, init) => { got = init.body; throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); };
  await assert.rejects(r.capFetch({ inner: seen, model: 'gpt-5.6-sol', maxUsd: 100, state: st, effort: 'medium' })('https://api.openai.com/v1/responses', { method: 'POST', body: lowBody }), /aborted/);
  assert.deepEqual([got, st.spend.reservedMicro], [highBody, Math.ceil(Buffer.byteLength(highBody) * 5 + 100 * 20)], 'priced and sent with the effort in');
});

test('T25b: the eval speaks the Responses API: the provider path and effort, the recorder, and a strict offline fake', async () => {
  const r = await runner();
  const { REPAIR_NOTE } = await import('../lib/reply-guard.mjs');
  // The provider: only POST to a path ending /responses on api.openai.com; the effort as reasoning.effort, never reasoning_effort.
  for (const [url, method, ok] of [['https://api.openai.com/v1/responses', 'POST', true], ['https://api.openai.com/v1/chat/completions', 'POST', false],
    ['https://api.openai.com/v1/responses', 'GET', false], ['http://api.openai.com/v1/responses', 'POST', false], ['https://api.openai.com.evil.example/v1/responses', 'POST', false],
    ['https://api.openai.com/v1/models', 'POST', false],
    // Claude r13 P3-1: the exact origin and path, no query, no userinfo, no other port or path ending in /responses.
    ['https://api.openai.com/v1/responses?x=1', 'POST', false], ['https://api.openai.com:8443/v1/responses', 'POST', false],
    ['https://user:pw@api.openai.com/v1/responses', 'POST', false], ['https://api.openai.com/other/responses', 'POST', false],
    ['https://api.openai.com/v1/responses/', 'POST', false], ['https://api.openai.com/v1/responses#x', 'POST', false]]) assert.equal(r.providerUrlOk(url, { method }), ok, `${method} ${url}`);
  const sent = JSON.parse(r.withEffort(JSON.stringify({ model: 'm', reasoning: { effort: 'low', summary: 'auto' }, input: [] }), 'medium'));
  assert.deepEqual([sent.reasoning, 'reasoning_effort' in sent], [{ effort: 'medium', summary: 'auto' }, false]);
  assert.deepEqual(JSON.parse(r.withEffort('{"model":"m"}', 'high')).reasoning, { effort: 'high' });
  // The recorder, request side: the repair is the last input item, a developer message with REPAIR_NOTE; its tool results
  // are the function_call_output items' output.
  const state = { responses: [] };
  const rec = r.recorder(state);
  const input = [{ role: 'user', content: 'hi' }, { type: 'reasoning', id: 'rs_1', encrypted_content: 'E' }, { type: 'function_call', call_id: 'c1', name: 'search_properties', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"count":1}' }];
  let e = rec.request(JSON.stringify({ input: [...input, { role: 'developer', content: REPAIR_NOTE }] }));
  assert.deepEqual([e.repair, e.results], [true, ['{"count":1}']]);
  e = rec.request(JSON.stringify({ input: [...input, { role: 'developer', content: [{ type: 'input_text', text: REPAIR_NOTE }] }] }));
  assert.equal(e.repair, true, 'a content parts list');
  e = rec.request(JSON.stringify({ input: [{ role: 'developer', content: REPAIR_NOTE }, ...input] }));
  assert.deepEqual([e.repair, e.results], [false, undefined], 'not the last item');
  // The response side: the LAST message item's output_text, the function_call names, the stop from status.
  rec.response(e, JSON.stringify({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Let me check.' }] },
    { type: 'function_call', call_id: 'c2', name: 'viewing_slots', arguments: '{}' }, { type: 'message', content: [{ type: 'output_text', text: 'Here ' }, { type: 'output_text', text: 'it is.' }] }] }));
  assert.deepEqual([e.content, e.tools, e.finish], ['Here it is.', ['viewing_slots'], 'tool_calls']);
  rec.response(e, JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }], usage: { input_tokens: 5 } }));
  assert.deepEqual([e.content, e.tools, e.finish, e.usage], ['Done.', [], 'stop', { input_tokens: 5 }]);
  rec.response(e, JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }));
  assert.deepEqual([e.content, e.finish], [null, 'max_output_tokens']);
  rec.response(e, 'not json');
  assert.equal(e.finish, 'unparsed');
  // The offline fake keeps the Responses rules (as #104's strict fake): Responses fields only, every function_call with its
  // call_id sent back after its own reasoning item, every function_call_output answering a call, no call left unanswered.
  const fakeState = { responses: [], kase: { category: 'search', probes: [], history: [] }, spec: { client: ['hi'], expect: { tools: ['search_properties'] } }, language: 'en' };
  const fake = r.fakeModel({ mode: 'good', state: fakeState });
  const call = async (body) => { const res = await fake('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(body) }); return { status: res.status, json: JSON.parse(await res.text()) }; };
  const base = { model: 'gpt-5.6-sol', instructions: 'p', reasoning: { effort: 'low' }, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: 1200,
    tools: [{ type: 'function', name: 'search_properties', strict: true, parameters: { type: 'object' } }], tool_choice: 'auto', parallel_tool_calls: true };
  let res = await call({ ...base, input: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const [reasoning, fc] = res.json.output;
  assert.deepEqual([reasoning.type, fc.type, typeof fc.call_id, fc.name, res.json.status], ['reasoning', 'function_call', 'string', 'search_properties', 'completed']);
  assert.ok(res.json.usage.input_tokens > 0 && res.json.usage.output_tokens > 0, 'Responses usage');
  const out = { type: 'function_call_output', call_id: fc.call_id, output: '{"count":0,"results":[]}' };
  for (const [label, body] of [
    ['a Chat Completions field', { ...base, messages: [], input: [] }], ['reasoning_effort', { ...base, reasoning_effort: 'low', input: [] }],
    ['max_completion_tokens', { ...base, max_completion_tokens: 1200, input: [] }], ['store not false', { ...base, store: true, input: [] }],
    ['no encrypted reasoning', { ...base, include: [], input: [] }], ['a nested chat tool', { ...base, tools: [{ type: 'function', function: { name: 'x' } }], input: [] }],
    ['a call without its reasoning item', { ...base, input: [{ role: 'user', content: 'hi' }, fc, out] }],
    ['a call it never issued', { ...base, input: [{ role: 'user', content: 'hi' }, reasoning, { ...fc, call_id: 'call_other' }, { ...out, call_id: 'call_other' }] }],
    ['an output with no call', { ...base, input: [{ role: 'user', content: 'hi' }, out] }],
    ['a call left unanswered', { ...base, input: [{ role: 'user', content: 'hi' }, reasoning, fc] }],
  ]) assert.equal((await call(body)).status, 400, label);
  res = await call({ ...base, input: [{ role: 'user', content: 'hi' }, reasoning, fc, out] });
  assert.deepEqual([res.status, res.json.output.at(-1).type], [200, 'message'], 'the round answered in order');
});

test('a subset run is diagnostic (Codex r1 P2): no decision, "subset, no decision" in the report', async () => {
  const r = await runner();
  const out = tmpDir('subset');
  try {
    const res = await r.runEval({ mode: 'dry', candidates: r.parseCandidates('gpt-5.6-sol:low'), only: ['ar-greeting-1'], outDir: out, env: {} });
    assert.deepEqual([res.decision.verdict, res.decision.main, res.decision.env], ['subset', null, []]);
    const report = r.formatReport(res);
    assert.ok(report.some((l) => /^decision: subset, no decision \(1 of 48 cases\)$/.test(l)), 'the decision line');
    const line = report.find((l) => l.startsWith('gpt-5.6-sol:low'));
    assert.ok(/ subset$/.test(line) && !/PASS|FAIL/.test(line), 'the candidate line says subset, never PASS or FAIL');
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
      assert.ok(!/9665\d{8}/.test(JSON.stringify(body)), 'no phone number goes to Retell');
    }
    assert.equal(res.decision.verdict, 'subset', 'a subset decides nothing');
    const report = r.formatReport(res).join('\n');
    assert.match(report, /^baseline retell +hard \d\/3/m);
    assert.doesNotMatch(report.split('\n').find((l) => l.startsWith('baseline retell')), /\$\/turn/);
    // Retell unreachable: skipped after two failed turns, not 48 errors (DESIGN §13.2 "skipped if Retell is unavailable").
    let tries = 0;
    const down = { async createChat() { tries += 1; throw Object.assign(new Error('down'), { status: 503 }); }, async createChatCompletion() { throw new Error('no'); }, async endChat() {} };
    const res2 = await r.runEval({ mode: 'dry', candidates: r.parseCandidates('gpt-5.6-sol:low'), baseline: 'retell', retell: down, outDir: out, env: {} });
    const base2 = res2.summaries.find((s) => s.baseline);
    assert.deepEqual([base2.aborted, tries, base2.notRun], ['retell_unavailable', 2, 46]);
    assert.equal(res2.decision.main.model, 'gpt-5.6-sol', 'the baseline is never a candidate');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the live fetches refuse: the provider without BONA_BRAIN_EVAL=1, the tools anywhere but GET or HEAD of Bona\'s site, at every redirect hop', async () => {
  const r = await runner();
  let called = 0;
  const spy = async () => { called += 1; return new Response('{}', { status: 200 }); };
  const provider = r.providerFetch({ realFetch: spy, effort: 'medium', state: { responses: [] }, env: {} });
  await assert.rejects(provider('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' }), /BONA_BRAIN_EVAL=1/);
  const site = r.siteFetch({ realFetch: spy, siteUrl: 'https://bona-real-estate.com' });
  for (const [url, init] of [['https://api.openai.com/v1/models', {}], ['https://bona-real-estate.com/x', { method: 'POST', body: 'x' }], ['http://bona-real-estate.com/x', {}], ['https://bona-real-estate.com.evil.example/x', {}]]) {
    await assert.rejects(site(url, init), /refused/, url);
  }
  assert.equal(called, 0, 'nothing went out');
  await site('https://bona-real-estate.com/properties/x/', { method: 'HEAD' });
  assert.equal(called, 1);
  // Codex r1 P2: a redirect is followed only to Bona's own hosts, hop by hop; never one off the site.
  const hops = [];
  const redirecting = (to) => async (url, init) => {
    hops.push([url, init.redirect]);
    return hops.length === 1 ? new Response(null, { status: 301, headers: { location: to } }) : new Response('ok', { status: 200 });
  };
  await assert.rejects(r.siteFetch({ realFetch: redirecting('https://evil.example/x'), siteUrl: 'https://bona-real-estate.com' })('https://bona-real-estate.com/properties/x/', { redirect: 'follow' }), /refused/);
  assert.deepEqual(hops, [['https://bona-real-estate.com/properties/x/', 'manual']], 'the off-site hop was never requested');
  hops.length = 0;
  const res = await r.siteFetch({ realFetch: redirecting('/properties/x/'), siteUrl: 'https://bona-real-estate.com' })('https://www.bona-real-estate.com/properties/x', { redirect: 'follow' });
  assert.deepEqual([res.status, hops.map((h) => h[0])], [200, ['https://www.bona-real-estate.com/properties/x', 'https://www.bona-real-estate.com/properties/x/']]);
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
    // A subset is diagnostic: exit 4, never 0, whatever it finds (Codex r1 P2).
    const dry = spawnSync(process.execPath, [RUN_FILE, '--dry-run', '--only', 'ar-greeting-1,en-view-pick-1', '--out-dir', path.join(home, 'out')], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(dry.status, 4, dry.stderr);
    assert.match(dry.stdout, /DRY RUN/);
    assert.match(dry.stdout, /cases 2 \(ar 1, en 1\)/);
    assert.match(dry.stdout, /subset, no decision/);
    const files = fs.readdirSync(path.join(home, 'out')).sort();
    assert.equal(files.length, 2);
    assert.ok(/^\d{8}T\d{6}Z\.jsonl$/.test(files[0]) && files[1] === files[0].replace(/\.jsonl$/, '.report.txt'), 'the answers file and its local report');
    for (const file of files) assert.equal(fs.statSync(path.join(home, 'out', file)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'out')).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
