// r4: the floor-plan contact check. Every plan image a brochure would publish is looked at by a second model
// for a phone number, an email, a website, a social handle, a QR code, a logo / brand name or a price, before
// any plan file reaches the repo. A plan is published only on ONE well-formed `clean: true` answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPlanImages, parsePlanReply, PLAN_CHECK_BATCH, PLAN_CHECK_CONCURRENCY, planVerdicts } from '../lib/plan-check.mjs';

const line = (o) => JSON.stringify(o);

describe('parsePlanReply / planVerdicts — the r5 #5 rule', () => {
  it('per index asked: one record; clean only with `clean: true` and an empty `found`; a duplicate or a malformed one is not clean; a missing one is unchecked', () => {
    const reply = [
      'Here are my answers:',                                                               // prose: ignored
      line({ index: 0, clean: true, found: '' }),
      line({ index: 1, clean: false, found: 'phone, logo' }),
      line({ index: 2, clean: true, found: '' }), line({ index: 2, clean: true, found: '' }), // duplicate
      line({ index: 3, clean: 'yes', found: '' }),                                          // malformed
      line({ index: 4, clean: true }),                                                      // `found` absent: clean
      line({ index: 6, clean: true, found: null }),                                         // `found` null: clean
      line({ index: 7, clean: true, found: 'qr' }),                                         // clean, but it found one: NOT clean
      line({ index: 9, clean: true, found: '' }),                                           // not asked
      '{"index":8,"clean":tru',                                                             // broken: ignored → 8 missing
      // index 5: no answer at all
    ].join('\n');
    const v = planVerdicts(parsePlanReply(reply), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(v.get(0), { state: 'clean', flagged: false, found: [] });
    assert.deepEqual(v.get(1), { state: 'dirty', flagged: true, found: ['phone', 'logo'] });
    assert.deepEqual(v.get(2), { state: 'dirty', flagged: false, found: [] }, 'a duplicate');
    assert.deepEqual(v.get(3), { state: 'dirty', flagged: false, found: [] }, 'malformed');
    assert.equal(v.get(4).state, 'clean');
    assert.equal(v.get(6).state, 'clean');
    assert.deepEqual(v.get(7), { state: 'dirty', flagged: true, found: ['qr'] });
    assert.equal(v.get(5).state, 'unchecked');
    assert.equal(v.get(8).state, 'unchecked');
    assert.equal(v.has(9), false);
  });

  it('`found` keeps only its own words: phone, email, website, social, qr, logo, price — never the text it saw', () => {
    const v = planVerdicts(parsePlanReply(line({ index: 0, clean: false, found: 'phone 0551234567, Call us! www.x.sa' })), [0]);
    assert.deepEqual(v.get(0).found, ['phone']);
    const w = planVerdicts(parsePlanReply(line({ index: 0, clean: false, found: 'something odd' })), [0]);
    assert.deepEqual(w.get(0), { state: 'dirty', flagged: true, found: [] });
  });

  it('JSON-object lines are read anywhere — fenced, inside an array, among prose', () => {
    const v = planVerdicts(parsePlanReply(`Sure.\n\`\`\`json\n[${line({ index: 0, clean: true, found: '' })},\n${line({ index: 1, clean: false, found: 'qr' })}]\n\`\`\`\nDone.`), [0, 1]);
    assert.deepEqual([v.get(0).state, v.get(1).found], ['clean', ['qr']]);
  });
});

describe('parsePlanReply / planVerdicts — r6 #4: JSON first per line, arrays, a bounded fallback, found "none"', () => {
  const C = (i) => line({ index: i, clean: true, found: '' });
  const F = (i, found) => line({ index: i, clean: false, found });

  it('a run of stray brackets or commas is not a record: `C0]]]` is not clean; the fallback strips one `[`, one `]`, one `,`', () => {
    for (const reply of [`${C(0)}]]]`, `${C(0)},,]],]`, `[${C(0)}]]]],`, `[[${C(0)}`, `${C(0)},,`]) {
      assert.equal(planVerdicts(parsePlanReply(reply), [0]).get(0).state, 'unchecked', reply);
    }
    for (const reply of [`[${C(0)},`, `${C(0)},`, `${C(0)}]`, `[${C(0)}]`, `${C(0)}],`]) {
      assert.equal(planVerdicts(parsePlanReply(reply), [0]).get(0).state, 'clean', reply);
    }
  });

  it('a compact array on one line gives each object as a record, fenced or not', () => {
    const arr = `[${C(0)},${F(1, 'phone')}]`;
    for (const reply of [arr, `Sure.\n\`\`\`json\n${arr}\n\`\`\`\nDone.`, `${arr},`]) {
      const v = planVerdicts(parsePlanReply(reply), [0, 1]);
      assert.deepEqual([v.get(0), v.get(1)], [{ state: 'clean', flagged: false, found: [] }, { state: 'dirty', flagged: true, found: ['phone'] }], reply);
    }
  });

  it('a pretty-printed array is read — the whole body, or a fenced block among prose', () => {
    const pretty = JSON.stringify([{ index: 0, clean: false, found: 'logo' }, { index: 1, clean: true, found: '' }], null, 2);
    for (const reply of [pretty, `Here you go:\n\`\`\`json\n${pretty}\n\`\`\`\nThat is all.`, `\`\`\`\n${pretty}\n\`\`\``]) {
      const v = planVerdicts(parsePlanReply(reply), [0, 1]);
      assert.deepEqual([v.get(0), v.get(1)], [{ state: 'dirty', flagged: true, found: ['logo'] }, { state: 'clean', flagged: false, found: [] }], reply);
    }
    // A pretty array of one-line objects is read once, not again line by line.
    const oneLine = `[\n  ${C(0)},\n  ${C(1)}\n]`;
    const w = planVerdicts(parsePlanReply(oneLine), [0, 1]);
    assert.deepEqual([w.get(0).state, w.get(1).state], ['clean', 'clean']);
  });

  it('an array line and an object line about the same index are a duplicate: not clean (no clear answer)', () => {
    for (const reply of [`${C(0)}\n${C(1)}\n[${F(0, 'phone')},${C(1)}]`, `[${F(0, 'phone')},${C(1)}]\n${C(0)}`]) {
      const v = planVerdicts(parsePlanReply(reply), [0, 1]);
      assert.deepEqual(v.get(0), { state: 'dirty', flagged: false, found: [] }, reply);
    }
  });

  it('found "none" / "N/A" / "nothing" / "no" / "-" (any case) is empty: clean:true with it is clean', () => {
    for (const found of ['none', 'None', 'NONE', 'n/a', 'N/A', 'nothing', 'Nothing', 'no', 'No', '-', ' none ']) {
      assert.deepEqual(planVerdicts(parsePlanReply(line({ index: 0, clean: true, found })), [0]).get(0), { state: 'clean', flagged: false, found: [] }, found);
      assert.deepEqual(planVerdicts(parsePlanReply(line({ index: 0, clean: false, found })), [0]).get(0), { state: 'dirty', flagged: true, found: [] }, found);
    }
  });

  it('clean:true beside another word that is not a finding ("maybe") is no clear answer — not flagged; a finding word still flags', () => {
    for (const found of ['maybe', 'something odd', 'unsure']) {
      assert.deepEqual(planVerdicts(parsePlanReply(line({ index: 0, clean: true, found })), [0]).get(0), { state: 'dirty', flagged: false, found: [] }, found);
    }
    assert.deepEqual(planVerdicts(parsePlanReply(line({ index: 0, clean: true, found: 'maybe a logo' })), [0]).get(0), { state: 'dirty', flagged: true, found: ['logo'] });
  });
});

describe('checkPlanImages — batches of 12, two at a time, nothing new after a quota', () => {
  const plans = (n) => Array.from({ length: n }, (_, k) => ({ model: k, file: `/w/plan-check/plan-${String(k + 1).padStart(2, '0')}.jpg` }));
  const allClean = (calls) => async (images) => {
    calls.push(images.map((im) => im.file));
    return { reply: images.map((im) => line({ index: im.index, clean: true, found: '' })).join('\n'), error: null, fatal: false };
  };

  it('a W023-shaped brochure: 8 plans, one call, all 8 clean', async () => {
    const calls = [];
    const res = await checkPlanImages(plans(8), { ask: allClean(calls) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].length, 8);
    assert.deepEqual(res.clean, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual([res.dirty, res.unchecked, res.fatal, res.calls], [[], [], false, 1]);
  });

  it('flags only the plan the reply flags', async () => {
    const ask = async (images) => ({ reply: images.map((im) => line({ index: im.index, clean: im.index !== 2, found: im.index === 2 ? 'phone' : '' })).join('\n'), error: null, fatal: false });
    const res = await checkPlanImages(plans(4), { ask });
    assert.deepEqual(res.clean, [0, 1, 3]);
    assert.deepEqual(res.dirty, [{ model: 2, found: ['phone'], flagged: true }]);
  });

  it('25 plans: three calls of at most 12, at most two at once', async () => {
    let running = 0;
    let most = 0;
    const sizes = [];
    const ask = async (images) => {
      running += 1; most = Math.max(most, running);
      sizes.push(images.length);
      await new Promise((r) => setTimeout(r, 10));
      running -= 1;
      return { reply: images.map((im) => line({ index: im.index, clean: true, found: '' })).join('\n'), error: null, fatal: false };
    };
    const res = await checkPlanImages(plans(25), { ask });
    assert.equal(PLAN_CHECK_BATCH, 12);
    assert.equal(PLAN_CHECK_CONCURRENCY, 2);
    assert.deepEqual(sizes.sort((a, b) => b - a), [12, 12, 1]);
    assert.ok(most <= 2, `at most two at once, saw ${most}`);
    assert.equal(res.clean.length, 25);
  });

  it('r5 #5: a reply with no record for any plan asked is a failed call — every plan unchecked (retryable), never dirty', async () => {
    for (const reply of ['All plans look clean.', '', line({ index: 7, clean: true, found: '' }), '{"index":0,"clean":tru']) {
      const res = await checkPlanImages(plans(2), { ask: async () => ({ reply, error: null, fatal: false }) });
      assert.deepEqual([res.clean, res.dirty, res.unchecked], [[], [], [0, 1]], JSON.stringify(reply));
      assert.match(res.errors.join(' '), /no answer/);
    }
    // One answered, one missing: the missing one is unchecked.
    const half = await checkPlanImages(plans(2), { ask: async () => ({ reply: line({ index: 0, clean: true, found: '' }), error: null, fatal: false }) });
    assert.deepEqual([half.clean, half.unchecked], [[0], [1]]);
  });

  it('r6 #4 (NB1): a record about an index not asked makes the whole call unchecked — never applied to another image', async () => {
    const rec = (index, clean = true, found = '') => line({ index, clean, found });
    for (const [what, reply] of [
      ['numbered from 1 (files 0..2)', [rec(1, false, 'phone'), rec(2), rec(3)].join('\n')],
      ['one out of range beside clean answers', [rec(0), rec(1), rec(2), rec(3)].join('\n')],
      ['a negative index', [rec(0), rec(1), rec(2), rec(-1)].join('\n')],
      ['an index that is not a number', [rec(0), rec(1), rec(2), line({ index: '1', clean: false, found: 'phone' })].join('\n')],
      ['a compact array numbered from 1', `[${rec(1)},${rec(2)},${rec(3)}]`],
    ]) {
      const res = await checkPlanImages(plans(3), { ask: async () => ({ reply, error: null, fatal: false }) });
      assert.deepEqual([res.clean, res.dirty, res.unchecked], [[], [], [0, 1, 2]], what);
      assert.match(res.errors.join(' '), /not asked/, what);
    }
  });

  it('a failed call leaves its plans unchecked; a quota stops every later call and says so', async () => {
    const fail = await checkPlanImages(plans(3), { ask: async () => ({ reply: '', error: 'claude -p timed out', fatal: false }) });
    assert.deepEqual([fail.clean, fail.unchecked, fail.fatal], [[], [0, 1, 2], false]);
    let n = 0;
    const quota = await checkPlanImages(plans(30), { ask: async () => { n += 1; return { reply: '', error: 'session limit', fatal: true }; }, concurrency: 1 });
    assert.equal(n, 1, 'nothing is sent after a quota error');
    assert.equal(quota.fatal, true);
    assert.equal(quota.unchecked.length, 30);
    // A throw counts as a failed call.
    const threw = await checkPlanImages(plans(1), { ask: async () => { throw Object.assign(new Error('boom'), { fatal: false }); } });
    assert.deepEqual(threw.unchecked, [0]);
  });

  it('no plans: no call', async () => {
    const res = await checkPlanImages([], { ask: async () => { throw new Error('must not be called'); } });
    assert.deepEqual([res.calls, res.clean, res.unchecked], [0, [], []]);
  });
});
