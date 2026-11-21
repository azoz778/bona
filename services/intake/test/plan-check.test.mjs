// r4: the floor-plan contact check. Every plan image a brochure would publish is looked at by a second model
// for a phone number, an email, a website, a social handle, a QR code, a logo / brand name or a price, before
// any plan file reaches the repo. A plan is published only on ONE well-formed `clean: true` answer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPlanImages, parsePlanReply, PLAN_CHECK_BATCH, PLAN_CHECK_CONCURRENCY, planVerdicts } from '../lib/plan-check.mjs';

const line = (o) => JSON.stringify(o);

describe('parsePlanReply / planVerdicts — strict, like the model-price check (r1 #4)', () => {
  it('one well-formed `clean: true` per index asked is clean; anything else is not', () => {
    const reply = [
      line({ index: 0, clean: true, found: '' }),
      line({ index: 1, clean: false, found: 'phone, logo' }),
      line({ index: 2, clean: true, found: '' }), line({ index: 2, clean: true, found: '' }), // duplicate
      line({ index: 3, clean: 'yes', found: '' }),                                          // malformed
      line({ index: 4, clean: true }),                                                      // no `found`
      line({ index: 9, clean: true, found: '' }),                                           // not asked
      // index 5: no answer at all
    ].join('\n');
    const v = planVerdicts(parsePlanReply(reply), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(v.get(0), { clean: true, found: [] });
    assert.deepEqual(v.get(1), { clean: false, found: ['phone', 'logo'] });
    for (const i of [2, 3, 4, 5]) assert.equal(v.get(i).clean, false, `index ${i}`);
    assert.equal(v.has(9), false);
  });

  it('`found` keeps only its own words: phone, email, website, social, qr, logo, price — never the text it saw', () => {
    const v = planVerdicts(parsePlanReply(line({ index: 0, clean: false, found: 'phone 0551234567, Call us! www.x.sa' })), [0]);
    assert.deepEqual(v.get(0).found, ['phone']);
    const w = planVerdicts(parsePlanReply(line({ index: 0, clean: false, found: 'something odd' })), [0]);
    assert.deepEqual(w.get(0), { clean: false, found: [] });
  });

  it('a reply that is not JSON lines (prose, a broken line) makes no image clean', () => {
    for (const reply of ['All clean!', `${line({ index: 0, clean: true, found: '' })}\n{"index":1,"clean":tru`, '']) {
      const v = planVerdicts(parsePlanReply(reply), [0, 1]);
      assert.equal(v.get(0).clean, false, reply);
      assert.equal(v.get(1).clean, false, reply);
    }
  });

  it('a JSON array of the same records is read the same way', () => {
    const v = planVerdicts(parsePlanReply(`\`\`\`json\n[${line({ index: 0, clean: true, found: '' })},\n${line({ index: 1, clean: false, found: 'qr' })}]\n\`\`\``), [0, 1]);
    assert.deepEqual([v.get(0).clean, v.get(1).found], [true, ['qr']]);
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
    assert.deepEqual(res.dirty, [{ model: 2, found: ['phone'] }]);
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
