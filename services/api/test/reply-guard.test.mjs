/**
 * PR-BR (PLAN T25; brain/DESIGN-brain.md §5.4): the reply guard, "never an unpublished price" in
 * code. Every amount in a reply must be in this turn's tool results or in an earlier reply this
 * guard itself passed (the caller hands those in: wa_outbox dana rows with guarded=1 only); a
 * client's own figure, a team row's negotiated price and a Retell-era Dana row never are. Unit
 * references and property links follow the same rule. The prices here are fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReply, findAmounts, unitRefs, claimsBooking, REPAIR_NOTE } from '../lib/reply-guard.mjs';

const SITE = 'https://bona-real-estate.com';
const villa = JSON.stringify({
  count: 1,
  results: [{
    id: 'BONA-901', slug: 'sea-view-villa', price_en: 'SAR 6,700,000', price_ar: '6,700,000 ر.س',
    url_en: `${SITE}/properties/sea-view-villa/`, url_ar: `${SITE}/ar/properties/sea-view-villa/`,
  }],
});
const amounts = (s) => findAmounts(s).map((a) => a.raw);

test('findAmounts reads Western and Arabic-Indic digits, scale words and currencies, and normalises to SAR', () => {
  for (const [s, raw] of [
    ['SAR 6,700,000', 6_700_000], ['SAR6,700,000', 6_700_000], ['6,700,000 ر.س', 6_700_000], ['٦٬٧٠٠٬٠٠٠ ريال', 6_700_000],
    ['3 ملايين', 3_000_000], ['٣ ملايين', 3_000_000], ['بـ2.5 مليون', 2_500_000], ['2.5m', 2_500_000], ['2.5M', 2_500_000],
    ['2.5 million', 2_500_000], ['3m', 3_000_000], ['500k', 500_000], ['500 ألف', 500_000], ['€900,000', 900_000],
    ['2950000', 2_950_000], ['2 950 000 SAR', 2_950_000], ['SAR 5,000', 5_000], ['1.5 مليار', 1_500_000_000], ['مليون', 1_000_000],
    ['مليونين', 2_000_000], ['a million', 1_000_000],
  ]) assert.deepEqual(amounts(s), [raw], s);
  const [aed] = findAmounts('AED 2,000,000');
  assert.deepEqual([aed.raw, aed.sar, aed.currency], [2_000_000, 2_040_000, 'AED']);
  const [usd] = findAmounts('$1.2m');
  assert.deepEqual([usd.raw, usd.sar, usd.currency], [1_200_000, 4_500_000, 'USD']);
  assert.deepEqual(amounts('بثلاثة ملايين تقريباً'), [null], 'a spelled-out amount is an amount of unknown value');
  assert.deepEqual(amounts('from SAR 2,950,000 to SAR 3,100,000'), [2_950_000, 3_100_000]);
});

test('findAmounts leaves areas, years, times, phone shapes, ids, percentages and small counts alone', () => {
  for (const s of ['12,500 m²', '12,500m²', '1,200 متر مربع', '980 متراً مربعاً', '450 sqm', '2026', '10:00–19:00', '+966 57 626 7694',
    '0500000000', '966500000000', '+966 500 000 000', 'BONA-W012', 'BONA-014', 'B08-19', '2.5%', '5 ٪', '4 bedrooms', 'FAL 1100313556',
    'رخصة فال 1100313556', '500m from the beach', `${SITE}/properties/plot-285123/`, 'Building 113', 'NOBAL 5', 'بالملايين']) {
    assert.deepEqual(findAmounts(s), [], s);
  }
});

test('an amount from this turn\'s tool results passes, in any currency spelling or scale word; one that is not there is a hit', () => {
  for (const text of ['سعرها 6,700,000 ريال', 'It is SAR 6,700,000.', 'It is 6.7 million riyals.', 'سعرها ٦٫٧ مليون', 'No price talk here.']) {
    assert.deepEqual(checkReply(text, { toolResults: [villa] }), { ok: true, hits: [] }, text);
  }
  assert.deepEqual(checkReply('It is around 7 million.', { toolResults: [villa] }), { ok: false, hits: [{ kind: 'amount' }] });
  assert.deepEqual(checkReply('The other one is SAR 3,950,000.', { toolResults: [villa] }).hits, [{ kind: 'amount' }], "another home's price, not returned this turn");
  assert.equal(checkReply('بثلاثة ملايين تقريباً', { toolResults: [villa] }).ok, false, 'a spelled-out amount can never be checked, so it is a hit');
  const units = JSON.stringify({ results: [{ ref: 'B08-19', price_cash: 2_950_000 }] });
  assert.equal(checkReply('B08-19 is 2,950,000 riyals cash.', { toolResults: [units] }).ok, true, 'a JSON number in a tool result counts');
});

test("a client's own figure is never allowed back (it is not in any tool result)", () => {
  // "ممكن 2 مليون؟" from the client; the reply echoes it.
  assert.deepEqual(checkReply('تمام، 2 مليون', { toolResults: [villa] }).hits, [{ kind: 'amount' }]);
  assert.deepEqual(checkReply('Within 2.5m, yes.', { toolResults: [] }).hits, [{ kind: 'amount' }]);
});

test('earlier replies the guard passed (guarded=1 Dana rows) allow their amounts; anything else the caller does not hand in stays a hit', () => {
  const earlier = ['الفيلا الثانية سعرها 4,100,000 ريال.'];
  assert.deepEqual(checkReply('And the second one is SAR 4,100,000.', { toolResults: [], earlierReplies: earlier }), { ok: true, hits: [] });
  // A Retell-era Dana row (guarded=0, e.g. a unit price) or a staff row with a negotiated price is never
  // in earlierReplies (T12 reads guarded=1 rows only), so the same figure is a hit.
  assert.deepEqual(checkReply('And the second one is SAR 4,100,000.', { toolResults: [] }).hits, [{ kind: 'amount' }]);
});

test('a unit reference passes only when a tool returned it in this turn (Arabic-Indic digits too)', () => {
  assert.deepEqual(unitRefs('Unit B08-19 and b٠٨-٢٠'), ['B08-19', 'B08-20']);
  assert.deepEqual(checkReply('الوحدة B08-19 متاحة', { toolResults: [villa] }).hits, [{ kind: 'unit' }]);
  assert.deepEqual(checkReply('الوحدة B٠٨-١٩ متاحة', { toolResults: [villa] }).hits, [{ kind: 'unit' }]);
  assert.equal(checkReply('B08-19 is available.', { toolResults: [JSON.stringify({ results: [{ ref: 'B08-19' }] })] }).ok, true);
  assert.equal(checkReply('B08-19 is available.', { toolResults: [], earlierReplies: ['B08-19'] }).ok, false, 'units: this turn only');
});

test('a property link passes only for a home a tool returned (this turn, or an earlier guarded reply)', () => {
  assert.equal(checkReply(`Here it is: ${SITE}/properties/sea-view-villa/`, { toolResults: [villa] }).ok, true);
  assert.equal(checkReply(`هنا: ${SITE}/ar/properties/sea-view-villa/`, { toolResults: [villa] }).ok, true);
  assert.deepEqual(checkReply(`Here: ${SITE}/properties/other-villa/`, { toolResults: [villa] }).hits, [{ kind: 'link' }]);
  assert.equal(checkReply(`Again: ${SITE}/properties/other-villa/`, { earlierReplies: [`${SITE}/properties/other-villa/`] }).ok, true);
  assert.equal(checkReply(`Our site: ${SITE}/ and ${SITE}/ar/`, {}).ok, true, 'the site itself is not a home');
});

test('hits carry only their kind, never the text or the amount; bad input is a clean pass', () => {
  const r = checkReply('It is SAR 7,777,000 and B08-19.', { toolResults: [villa] });
  assert.deepEqual(r, { ok: false, hits: [{ kind: 'amount' }, { kind: 'unit' }] });
  assert.equal(JSON.stringify(r).includes('7,777,000'), false);
  assert.deepEqual(checkReply(null), { ok: true, hits: [] });
  assert.deepEqual(checkReply('SAR 6,700,000', { toolResults: ['not json at all: SAR 6,700,000'] }), { ok: true, hits: [] }, 'a non-JSON result is read as text');
});

test('the repair note is the design text; a booking claim is recognised for the commit safety net', () => {
  assert.equal(REPAIR_NOTE, "Your draft quoted an amount or unit that no tool returned in this turn. Write the reply again; quote prices only exactly as this turn's tool results give them, or say a team member will confirm.");
  for (const s of ['Your viewing is booked for Sunday.', 'It is confirmed.', 'تم الحجز', 'تم تأكيد موعدك', 'حجزت لك الموعد']) assert.equal(claimsBooking(s), true, s);
  for (const s of ['I can help you book a viewing.', 'The team will confirm the time.', 'نقدر نرتب لك معاينة', '']) assert.equal(claimsBooking(s), false, s);
});
