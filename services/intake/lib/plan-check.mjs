// The floor-plan contact check (r4, owner decision 2026-11-21): a floor plan cut from a developer's PDF can
// carry the developer's phone number, website, QR code, logo or a price table in its pixels — and the owner's
// rule is "no developer logos or contacts" on the site and in the Bona brochure. So every plan image a run
// would publish is looked at by a second model before any plan file reaches the repo, and a plan is published
// only on ONE `clean: true` answer about it with nothing found (r5 #5).
//
// One call covers up to PLAN_CHECK_BATCH (12) plans; more plans take more calls, PLAN_CHECK_CONCURRENCY (2) at
// a time, none started after a quota error. The call itself is injected (`ask`: pipeline.mjs passes
// claude.mjs askPlanContacts), so this module is pure logic and tested without a model.

/** Plans looked at in one call. */
export const PLAN_CHECK_BATCH = 12;
/** Calls running at once. */
export const PLAN_CHECK_CONCURRENCY = 2;

/** What a plan may show that keeps it off the site — the only words `found` is read in (never the text it saw). */
export const PLAN_FINDINGS = Object.freeze(['phone', 'email', 'website', 'social', 'qr', 'logo', 'price']);

const json = (s) => { try { return { v: JSON.parse(s) }; } catch { return null; } };
/** A parsed value's records: an object is one, an array gives each of its object elements. */
const recordsOf = (v) => (Array.isArray(v) ? v : [v]).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
/** The records of a text that is one JSON array (compact or pretty-printed), else null. */
const arrayRecords = (s) => { const p = json(s.trim()); return p && Array.isArray(p.v) ? recordsOf(p.v) : null; };

/**
 * The records in a reply (r5 #5, r6 #4):
 *   - the whole reply, or a fenced block, that is one JSON array (pretty-printed or not): its objects;
 *   - otherwise each trimmed line, read as JSON first after dropping ONE trailing comma: an object is a record,
 *     an array (compact, on one line) gives each object in it;
 *   - else an array written one object per line ("[{…},", "{…}]"): at most ONE `[` before the object and ONE `]`
 *     and / or ONE `,` after it — never a run of brackets.
 * Every other line (prose, a record cut short, stray brackets) is ignored. A record about the same index on an
 * array line and on an object line is two records (a duplicate).
 * @returns {object[]}
 */
export function parsePlanReply(text) {
  const body = String(text ?? '');
  const whole = arrayRecords(body);
  if (whole) return whole;
  const out = [];
  // A fenced array is read whole, and its lines are not read again.
  const rest = body.replace(/```[^\n]*\n([\s\S]*?)```/g, (block, inner) => {
    const recs = arrayRecords(inner);
    if (!recs) return block;
    out.push(...recs);
    return '\n';
  });
  for (const raw of rest.split('\n')) {
    const l = raw.trim();
    const first = json(l.replace(/,$/, ''));
    if (first) { out.push(...recordsOf(first.v)); continue; }
    const member = /^\[?\s*(\{.*\})\s*\]?\s*,?$/.exec(l)?.[1];
    const second = member ? json(member) : null;
    if (second) out.push(...recordsOf(second.v));
  }
  return out;
}

/** `found` words that say nothing was found (r6 #4), any case. */
const NOTHING_FOUND = new Set(['none', 'n/a', 'nothing', 'no', '-']);
const emptyFound = (f) => f === undefined || f === null
  || (typeof f === 'string' && (f.trim() === '' || NOTHING_FOUND.has(f.trim().toLowerCase())));

/**
 * Per index asked, the verdict (r5 #5): `{ state, flagged, found }`.
 *   - no record about it: 'unchecked';
 *   - more than one, or one that is malformed (`clean` not a boolean, `found` neither text nor empty): 'dirty',
 *     not flagged (no clear answer);
 *   - one with `clean: true` and an empty / null / absent `found`, or one saying nothing was found ("none",
 *     "n/a", "nothing", "no", "-", any case — r6 #4): 'clean';
 *   - one with `clean: false`, or `clean: true` beside a PLAN_FINDINGS word: 'dirty', flagged;
 *   - one with `clean: true` beside any other word ("maybe"): 'dirty', not flagged (no clear answer, r6 #4).
 * `found` keeps only PLAN_FINDINGS words. Records about an index not asked are not read here (checkPlanImages
 * then leaves the whole call unchecked, r6 #4).
 * @returns {Map<number, {state:'clean'|'dirty'|'unchecked', flagged:boolean, found:string[]}>}
 */
export function planVerdicts(records, asked) {
  const out = new Map();
  for (const index of asked) {
    const mine = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object' && r.index === index);
    if (!mine.length) { out.set(index, { state: 'unchecked', flagged: false, found: [] }); continue; }
    const one = mine.length === 1 ? mine[0] : null;
    const wellFormed = one && typeof one.clean === 'boolean' && (emptyFound(one.found) || typeof one.found === 'string');
    if (!wellFormed) { out.set(index, { state: 'dirty', flagged: false, found: [] }); continue; }
    const found = emptyFound(one.found) ? [] : [...new Set(one.found.toLowerCase().split(/[^a-z]+/).filter((w) => PLAN_FINDINGS.includes(w)))];
    if (one.clean === true && emptyFound(one.found)) out.set(index, { state: 'clean', flagged: false, found: [] });
    else if (one.clean === true && !found.length) out.set(index, { state: 'dirty', flagged: false, found: [] });
    else out.set(index, { state: 'dirty', flagged: true, found });
  }
  return out;
}

/**
 * Check `plans` ([{ model, file }], the plan images as they would be published) in calls of `batch`, `concurrency`
 * at a time. `ask(images)` gets `[{ index, file }]` (index = the image's number in that call) and returns
 * `{ reply, error, fatal }` (a throw counts as an error, fatal when it says so).
 * @returns {Promise<{clean:number[], dirty:Array<{model:number, found:string[], flagged:boolean}>, unchecked:number[], fatal:boolean,
 *   calls:number, errors:string[]}>}  models by verdict: `unchecked` = its call failed, was never sent, said
 *   nothing about it, or answered about an image not asked; `dirty` = flagged, or no clear answer (`flagged: false`)
 */
export async function checkPlanImages(plans, { ask, batch = PLAN_CHECK_BATCH, concurrency = PLAN_CHECK_CONCURRENCY } = {}) {
  const list = Array.isArray(plans) ? plans : [];
  const jobs = [];
  for (let k = 0; k < list.length; k += batch) jobs.push(list.slice(k, k + batch));
  const res = { clean: [], dirty: [], unchecked: [], fatal: false, calls: 0, errors: [] };
  const settled = new Array(jobs.length);
  let next = 0;
  let stop = false;
  const lane = async () => {
    while (!stop && next < jobs.length) {
      const k = next;
      next += 1;
      res.calls += 1;
      const images = jobs[k].map((p, index) => ({ index, file: p.file }));
      try {
        settled[k] = await ask(images);
      } catch (err) {
        settled[k] = { reply: '', error: String(err?.message || err), fatal: err?.fatal === true };
      }
      if (settled[k]?.fatal) stop = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), jobs.length) }, lane));
  jobs.forEach((job, k) => {
    const s = settled[k];
    if (s?.fatal) res.fatal = true;
    if (!s || s.error) {
      if (s?.error) res.errors.push(s.error);
      res.unchecked.push(...job.map((p) => p.model));
      return;
    }
    const asked = job.map((_, index) => index);
    const records = parsePlanReply(s.reply);
    const verdicts = planVerdicts(records, asked);
    // No record about any plan asked: the call failed, whatever it printed — unchecked (retryable), never dirty.
    if ([...verdicts.values()].every((v) => v.state === 'unchecked')) {
      res.errors.push('no answer about any plan in the reply');
      res.unchecked.push(...job.map((p) => p.model));
      return;
    }
    // A record about an index not asked (numbered from 1, out of range, not a number): the reply's numbering is
    // not ours, so none of it is applied to any image — the whole call is unchecked (retryable, r6 #4).
    if (records.some((r) => !asked.includes(r.index))) {
      res.errors.push('an answer about an image not asked in the reply');
      res.unchecked.push(...job.map((p) => p.model));
      return;
    }
    job.forEach((p, index) => {
      const v = verdicts.get(index);
      if (v.state === 'clean') res.clean.push(p.model);
      else if (v.state === 'unchecked') res.unchecked.push(p.model);
      else res.dirty.push({ model: p.model, found: v.found, flagged: v.flagged });
    });
  });
  return res;
}
