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

/**
 * The records in a reply (r5 #5): every line that holds one JSON object — anywhere, fenced or not, inside an
 * array or not ("[{…},", "{…}]" read as the object they hold). Every other line (prose, a record cut short) is
 * ignored.
 * @returns {object[]}
 */
export function parsePlanReply(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trim().replace(/^\[\s*/, '').replace(/\s*[,\]]*$/, '');
    if (!l.startsWith('{') || !l.endsWith('}')) continue;
    try {
      const rec = JSON.parse(l);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec);
    } catch { /* not a record: ignored */ }
  }
  return out;
}

const emptyFound = (f) => f === undefined || f === null || (typeof f === 'string' && f.trim() === '');

/**
 * Per index asked, the verdict (r5 #5): `{ state, flagged, found }`.
 *   - no record about it: 'unchecked';
 *   - more than one, or one that is malformed (`clean` not a boolean, `found` neither text nor empty): 'dirty',
 *     not flagged (no clear answer);
 *   - one with `clean: true` and an empty / null / absent `found`: 'clean';
 *   - one with `clean: false`, or `clean: true` beside something found: 'dirty', flagged.
 * `found` keeps only PLAN_FINDINGS words. Records about an index not asked are ignored.
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
    else out.set(index, { state: 'dirty', flagged: true, found });
  }
  return out;
}

/**
 * Check `plans` ([{ model, file }], the plan images as they would be published) in calls of `batch`, `concurrency`
 * at a time. `ask(images)` gets `[{ index, file }]` (index = the image's number in that call) and returns
 * `{ reply, error, fatal }` (a throw counts as an error, fatal when it says so).
 * @returns {Promise<{clean:number[], dirty:Array<{model:number, found:string[], flagged:boolean}>, unchecked:number[], fatal:boolean,
 *   calls:number, errors:string[]}>}  models by verdict: `unchecked` = its call failed, was never sent, or said
 *   nothing about it; `dirty` = flagged, or no clear answer (`flagged: false`)
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
    const verdicts = planVerdicts(parsePlanReply(s.reply), job.map((_, index) => index));
    // No record about any plan asked: the call failed, whatever it printed — unchecked (retryable), never dirty.
    if ([...verdicts.values()].every((v) => v.state === 'unchecked')) {
      res.errors.push('no answer about any plan in the reply');
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
