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

test('only a price field of a tool result authorises a JSON number: an area, a count, beds or baths never does', () => {
  // A home on request: its area (1,250 m²) must not let an invented "SAR 1,250 per month" through.
  const onRequest = JSON.stringify({ count: 1, results: [{ id: 'BONA-901', price_en: 'Price on request', price_ar: 'السعر عند الطلب', beds: 5, baths: 6, area_sqm: 1250 }] });
  for (const text of ['SAR 1,250 per month', 'Rent is 1,250 riyals.', 'It is SAR 5 a night.', 'It is SAR 6.']) {
    assert.deepEqual(checkReply(text, { toolResults: [onRequest] }).hits, [{ kind: 'amount' }], text);
  }
  // The published units cut: only cashFrom is a price; count, areaMin and areaMax are not.
  const cut = JSON.stringify({ count: 12, summary: { rows: [{ label: { en: '2 bedrooms', ar: 'غرفتا نوم' }, count: 12, areaMin: 120, areaMax: 180, cashFrom: 995_000 }], delivery: '2028-06', updated: '2026-11-01' } });
  assert.deepEqual(checkReply('2 bedrooms from SAR 995,000.', { toolResults: [cut] }), { ok: true, hits: [] });
  for (const text of ['SAR 180 a month', 'SAR 12 deposit', 'SAR 120']) assert.deepEqual(checkReply(text, { toolResults: [cut] }).hits, [{ kind: 'amount' }], text);
  // Price fields as the tools name them pass: price, price_cash, cashFrom, rent, a nested price object, an array of prices.
  for (const [result, text] of [
    [{ results: [{ price_cash: 2_950_000 }] }, 'SAR 2,950,000'],
    [{ price: 2_950_000 }, '2,950,000 riyals'],
    [{ rent: 85_000 }, 'Rent SR 85,000 a year'],
    [{ monthly_rent: 7_000 }, 'SAR 7,000 a month'],
    [{ price: { cash: 2_950_000, twoYear: 3_100_000 } }, 'SAR 3,100,000 over two years'],
    [{ prices: [995_000, 1_200_000] }, 'from SAR 1,200,000'],
    [{ availability: { from: 995_000 } }, 'from SAR 995,000'],
  ]) assert.deepEqual(checkReply(text, { toolResults: [JSON.stringify(result)] }), { ok: true, hits: [] }, text);
  assert.deepEqual(checkReply('SAR 2,950,000', { toolResults: [JSON.stringify({ count: 2_950_000 })] }).hits, [{ kind: 'amount' }], 'a count is never a price');
  assert.deepEqual(checkReply('SAR 2,950,000', { toolResults: [JSON.stringify(2_950_000)] }).hits, [{ kind: 'amount' }], 'a bare number has no price field');
});

test("a client's own figure is never allowed back (it is not in any tool result)", () => {
  // "ممكن 2 مليون؟" from the client; the reply echoes it.
  assert.deepEqual(checkReply('تمام، 2 مليون', { toolResults: [villa] }).hits, [{ kind: 'amount' }]);
  assert.deepEqual(checkReply('Within 2.5m, yes.', { toolResults: [] }).hits, [{ kind: 'amount' }]);
});

test('a comma decimal ("2,5 مليون") or dot thousands ("2.950.000") is read as one number; a grouping that cannot be read, next to a scale word or a currency, is an amount of unknown value', () => {
  for (const [s, raw] of [
    ['2,5 مليون', 2_500_000], ['٢,٥ مليون', 2_500_000], ['2,95 مليون ريال', 2_950_000], ['2,5m', 2_500_000], ['price 2,5 million', 2_500_000],
    ['2.950.000 ريال', 2_950_000], ['SAR 6.700.000', 6_700_000], ['SAR 6,700,000.00', 6_700_000], ['6.700.000,00 €', 6_700_000],
    ['2.950 مليون', 2_950_000], ['SAR 5,000', 5_000], ['سعرها 6,7 مليون', 6_700_000],
  ]) assert.deepEqual(amounts(s), [raw], s);
  for (const s of ['1,23,45 مليون', 'SAR 1.2.3', '12345,678 ريال']) assert.deepEqual(amounts(s), [null], s);
  for (const s of ['29.11.2026', '1,2,3 bedrooms', 'version 1.2.3']) assert.deepEqual(amounts(s), [], s);
  assert.deepEqual(amounts('+5 مليون'), [null], 'a scale word counts as read only when an amount used it, never because a digit is before it');
  for (const text of ['تمام، 2,5 مليون', 'السعر 2,5 مليون', 'السعر ٢,٥ مليون', 'price 2,5 million', 'السعر 2,95 مليون ريال', 'It is 2,5m.', 'السعر 2.950.000 ريال']) {
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: false, hits: [{ kind: 'amount' }] }, text);
  }
  assert.deepEqual(checkReply('the villa is 6,700,000 and the other is 2,5 million', { toolResults: [villa] }).hits, [{ kind: 'amount' }]);
  for (const text of ['the villa is 6.700.000 ريال', 'سعرها 6,7 مليون']) assert.deepEqual(checkReply(text, { toolResults: [villa] }), { ok: true, hits: [] }, text);
});

test('a number right after a colon ("Price:2,950,000 SAR") is an amount; a time ("10:30") is not', () => {
  for (const [s, raw] of [
    ['Price:2,950,000 SAR', 2_950_000], ['السعر:2,950,000 ريال', 2_950_000], ['السعر:٢٬٩٥٠٬٠٠٠ ريال', 2_950_000], ['Price:2.5M', 2_500_000],
    ['السعر:2.5 مليون', 2_500_000], ['rent:85,000 SAR', 85_000], ['Price:SAR 2,950,000', 2_950_000],
  ]) {
    assert.deepEqual(amounts(s), [raw], s);
    assert.deepEqual(checkReply(`The villa is ${s}.`, { toolResults: [villa] }), { ok: false, hits: [{ kind: 'amount' }] }, s);
    assert.deepEqual(checkReply(`The villa is ${s}.`, { toolResults: [JSON.stringify({ results: [{ price_cash: raw }] })] }), { ok: true, hits: [] }, s);
  }
  for (const [s, raw] of [['B08-19:3,100,000 SAR', 3_100_000], ['BONA-W012:2950000', 2_950_000]]) assert.deepEqual(amounts(s), [raw], `${s}: a digit before the colon is not a time`);
  for (const s of ['10:00–19:00', 'at 10:30', '2026-11-29 10:30', 'Time:10:30', 'الساعة:10:30', '10:30:00', 'Floors:3', 'Tel:0500000000']) assert.deepEqual(findAmounts(s), [], s);
});

test('a half or a quarter next to a million word ("مليون ونص", "نص مليون", "half a million") is an amount of unknown value', () => {
  const tools = [JSON.stringify({ results: [{ price_cash: 1_000_000 }, { price_cash: 2_000_000 }] })];
  for (const s of ['مليون ونص', 'مليون و نصف ريال', 'مليونين ونص', 'نص مليون', 'بنص مليون', 'ربع مليون', 'مليون إلا ربع', '2 مليون ونص', '2 ونص مليون',
    'half a million', 'a quarter of a million', 'a million and a half', 'a million-and-a-half', '1 million and a half', 'half-a-million']) {
    assert.deepEqual(amounts(s), [null], s);
    assert.deepEqual(checkReply(`السعر ${s}`, { toolResults: tools }).hits, [{ kind: 'amount' }], s);
  }
  for (const [s, raw] of [['مليون', 1_000_000], ['مليون ريال', 1_000_000], ['a million', 1_000_000], ['2 مليون', 2_000_000], ['1.5 مليون', 1_500_000]]) {
    assert.deepEqual(amounts(s), [raw], s);
  }
});

test('a range reads its lower bound with the upper bound\'s scale ("between 2 and 3 million" is 2M and 3M)', () => {
  for (const [s, raws] of [
    ['between 2 and 3 million', [2_000_000, 3_000_000]], ['2.9–3.1 million', [2_900_000, 3_100_000]], ['من 2 إلى 3 مليون', [2_000_000, 3_000_000]],
    ['بين 2 و3 ملايين', [2_000_000, 3_000_000]], ['2-3 million SAR', [2_000_000, 3_000_000]], ['2-3m', [2_000_000, 3_000_000]],
    ['500-900k', [500_000, 900_000]], ['SAR 2 to 3 million', [2_000_000, 3_000_000]], ['from SAR 2,950,000 to SAR 3,100,000', [2_950_000, 3_100_000]],
    ['SAR 2.5M-3M', [2_500_000, 3_000_000]], ['2m-3m', [2_000_000, 3_000_000]], ['500k-900k', [500_000, 900_000]],
  ]) assert.deepEqual(amounts(s), raws, s);
  for (const s of ['2 to 3 bedrooms', '2-3 floors', '200-500m from the beach', '29-11-2026', '10:00-19:00', '2-3 million m²']) assert.deepEqual(findAmounts(s), [], s);
  assert.deepEqual(amounts('Villa 3-2.5 million'), [2_500_000], 'a lower "bound" above the upper one is not a range');
  for (const s of ['Villa 2 – 3.2 million', 'Option 2 - 3.2 million', '1- 3.2 مليون']) assert.deepEqual(amounts(s), [3_200_000], `${s}: a spaced dash is a list line, not a range`);
  const upper = [JSON.stringify({ results: [{ price_cash: 3_000_000 }] })];
  assert.deepEqual(checkReply('between 2 and 3 million', { toolResults: upper }).hits, [{ kind: 'amount' }], 'the lower bound is checked too');
  assert.equal(checkReply('between 2 and 3 million', { toolResults: [JSON.stringify({ results: [{ price_cash: 2_000_000 }, { price_cash: 3_000_000 }] })] }).ok, true);
  assert.equal(checkReply('It is 2.9–3.1 million.', { toolResults: [JSON.stringify({ price_en: 'SAR 2.9–3.1 million' })] }).ok, true, 'a range a tool returned may be quoted back');
});

test('a range shares one currency: the bound without one takes the other bound\'s ("80,000–90,000 SAR" is SAR 80,000 and SAR 90,000)', () => {
  const cur = (s) => findAmounts(s).map((a) => [a.raw, a.currency]);
  const lowerTakes = [
    'Annual rent is 80,000–90,000 SAR.', 'Annual rent is 80,000-90,000 SAR.', 'Annual rent is 80,000 to 90,000 SAR.', 'Annual rent is 80,000 to SAR 90,000.',
    'الإيجار السنوي من 80,000 إلى 90,000 ريال', 'الإيجار السنوي 80,000-90,000 ريال', 'الإيجار السنوي ٨٠٬٠٠٠–٩٠٬٠٠٠ ر.س', 'الإيجار من 80,000 الى 90,000 ر.س',
  ];
  const upperTakes = ['Annual rent is SAR 80,000–90,000.', 'Annual rent is SAR 80,000 to 90,000.', 'الإيجار من 80,000 ريال إلى 90,000', 'الإيجار ر.س 80,000-90,000'];
  for (const s of [...lowerTakes, ...upperTakes]) assert.deepEqual(cur(s), [[80_000, 'SAR'], [90_000, 'SAR']], s);
  assert.deepEqual(cur('80,000–90,000 USD'), [[80_000, 'USD'], [90_000, 'USD']]);
  assert.deepEqual(cur('1.2-1.5 م ريال'), [[1_200_000, 'SAR'], [1_500_000, 'SAR']], 'a short scale next to the shared currency');
  assert.deepEqual(cur('SAR 2.5 million to 3 million'), [[2_500_000, 'SAR'], [3_000_000, 'SAR']]);
  for (const [s, raws] of [['2 million to 3 million USD', [2_000_000, 3_000_000]], ['500k-900k USD', [500_000, 900_000]], ['من 2 مليون إلى 3 مليون دولار', [2_000_000, 3_000_000]]]) {
    assert.deepEqual(cur(s), raws.map((r) => [r, 'USD']), `${s}: a bound with its own scale takes the shared currency`);
  }
  for (const s of ['SAR 85,000 or 2 years', 'SAR 2 million or 3 bedrooms', 'SAR 85,000 and 100,000 m² of land']) {
    assert.deepEqual(cur(s), [[s.includes('million') ? 2_000_000 : 85_000, 'SAR']], `${s}: not a range`);
  }

  const upper = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 90,000 / year', price_ar: '90,000 ر.س سنوياً' }] })];
  const lower = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 80,000 / year', price_ar: '80,000 ر.س سنوياً' }] })];
  for (const s of lowerTakes) assert.deepEqual(checkReply(s, { toolResults: upper }).hits, [{ kind: 'amount' }], `${s}: a lower bound no tool returned`);
  for (const s of upperTakes) assert.deepEqual(checkReply(s, { toolResults: lower }).hits, [{ kind: 'amount' }], `${s}: an upper bound no tool returned`);
  const usd = [JSON.stringify({ results: [{ price_en: 'USD 90,000' }, { price_en: 'SAR 80,000' }] })];
  assert.deepEqual(checkReply('It is 80,000–90,000 USD.', { toolResults: usd }).hits, [{ kind: 'amount' }], 'the lower bound is USD 80,000, not the SAR 80,000 the tool gave');

  const range = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 80,000–90,000 / year', price_ar: 'من 80,000 إلى 90,000 ر.س سنوياً' }] })];
  for (const s of [...lowerTakes, ...upperTakes]) assert.deepEqual(checkReply(s, { toolResults: range }), { ok: true, hits: [] }, `${s}: the tool's own range`);
  const both = [JSON.stringify({ results: [{ rent_min: 80_000, rent_max: 90_000 }] })];
  for (const s of lowerTakes) assert.deepEqual(checkReply(s, { toolResults: both }), { ok: true, hits: [] }, `${s}: both bounds returned`);
});

test('a currency (never a scale) is shared across a spaced dash, a slash and "or"/"and" in either order, when the other number is money on its own', () => {
  const cur = (s) => findAmounts(s).map((a) => [a.raw, a.currency]);
  const upper = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 90,000 / year', price_ar: '90,000 ر.س سنوياً' }] })];
  const lower = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 80,000 / year', price_ar: '80,000 ر.س سنوياً' }] })];
  const lowerTakes = [
    'Annual rent is 80,000 – 90,000 SAR.', 'Annual rent is 80,000 - 90,000 SAR.', 'الإيجار 80,000 - 90,000 ريال سنوياً', 'Annual rent is 80,000 / 90,000 SAR.',
    'Annual rent is 80,000/90,000 SAR.', 'Annual rent is 80000 – 90,000 SAR.',
  ];
  const upperTakes = ['SAR 80,000 – 90,000 per year', 'SAR 80,000 - 90,000 per year', 'ر.س 80,000 – 90,000 سنوياً', 'SAR 80,000/90,000 per year'];
  for (const s of lowerTakes) {
    assert.deepEqual(cur(s), [[80_000, 'SAR'], [90_000, 'SAR']], s);
    assert.deepEqual(checkReply(s, { toolResults: upper }).hits, [{ kind: 'amount' }], `${s}: a lower bound no tool returned`);
  }
  for (const s of upperTakes) {
    assert.deepEqual(cur(s), [[80_000, 'SAR'], [90_000, 'SAR']], s);
    assert.deepEqual(checkReply(s, { toolResults: lower }).hits, [{ kind: 'amount' }], `${s}: an upper bound no tool returned`);
  }
  const range = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 80,000 – 90,000 / year' }] })];
  for (const s of [...lowerTakes, ...upperTakes]) assert.deepEqual(checkReply(s, { toolResults: range }), { ok: true, hits: [] }, `${s}: the tool's own range`);

  // A second figure below the first: an invented discount is a negotiation (DESIGN §5.4).
  const discounts = [
    'Rent is SAR 90,000 or 85,000 paid in one payment.', 'الإيجار 90,000 ريال أو 85,000 دفعة وحدة', 'الإيجار 90,000 ريال او 85,000 دفعة وحدة',
    'الإيجار 90,000 ريال و85,000 دفعة وحدة', 'SAR 90,000 and 85,000 in one payment', 'Rent is SAR 90,000 – 85,000 paid in one payment.',
    'Rent is SAR 90,000-85,000 paid in one payment.', 'Reduced from SAR 90,000 to 85,000.', 'Rent is 90,000 or 85,000 SAR.',
  ];
  const twoFigures = [JSON.stringify({ results: [{ rent: 90_000 }, { rent_cash: 85_000 }] })];
  for (const s of discounts) {
    assert.deepEqual(cur(s), [[90_000, 'SAR'], [85_000, 'SAR']], s);
    assert.deepEqual(checkReply(s, { toolResults: upper }).hits, [{ kind: 'amount' }], `${s}: a second figure no tool returned`);
    assert.deepEqual(checkReply(s, { toolResults: twoFigures }), { ok: true, hits: [] }, `${s}: both figures returned`);
  }

  // The scale is never shared across a spaced dash, and a number that is not money on its own takes no currency.
  for (const s of ['Villa 2 – 3.2 million', 'Option 2 - 3.2 million', '1- 3.2 مليون']) assert.deepEqual(amounts(s), [3_200_000], s);
  for (const [s, want] of [
    ['Option 1 – SAR 90,000', [[90_000, 'SAR']]], ['SAR 85,000 or 2 years', [[85_000, 'SAR']]], ['SAR 2 million or 3 bedrooms', [[2_000_000, 'SAR']]],
    ['SAR 90,000 / 12 months', [[90_000, 'SAR']]], ['SAR 90,000 / 2026', [[90_000, 'SAR']]], ['Built 2019 – SAR 2,950,000', [[2_950_000, 'SAR']]],
    ['SAR 90,000 or 5% off', [[90_000, 'SAR']]], ['SAR 85,000 and 1,250 m² of land', [[85_000, 'SAR']]], ['1,250 sqm – SAR 6,700,000', [[6_700_000, 'SAR']]],
    ['SAR 6,700,000 – 1500m from the beach', [[6_700_000, 'SAR']]], ['SAR 6,700,000 – 1500 م من البحر', [[6_700_000, 'SAR']]],
    ['Call 0500000000 – SAR 90,000', [[90_000, 'SAR']]], ['+966 50 000 0000 or SAR 90,000', [[90_000, 'SAR']]], ['29/11/2026 – SAR 90,000', [[90_000, 'SAR']]],
    ['Ref 12 3456 – SAR 90,000', [[90_000, 'SAR']]], ['1500 م – SAR 90,000', [[90_000, 'SAR']]], ['500m – SAR 90,000', [[90_000, 'SAR']]],
    ['SAR 90,000 – 10:30', [[90_000, 'SAR']]], ['10:30 – SAR 90,000', [[90_000, 'SAR']]], ['SAR 90,000 / 1447', [[90_000, 'SAR']]],
  ]) assert.deepEqual(cur(s), want, s);
  assert.deepEqual(cur('SAR 80,000, 85,000 or 90,000'), [[80_000, 'SAR']], 'a comma list stays outside the guard (the general clause form)');
  assert.deepEqual(cur('SAR 80,000 or 85,000 or 90,000'), [[80_000, 'SAR'], [85_000, 'SAR'], [90_000, 'SAR']], 'a chain shares the currency on');
  assert.deepEqual(checkReply('Option 1 – SAR 90,000', { toolResults: upper }), { ok: true, hits: [] });
  assert.deepEqual(checkReply('SAR 85,000 or 2 years', { toolResults: [JSON.stringify({ results: [{ price_en: 'SAR 85,000' }] })] }), { ok: true, hits: [] });
  assert.deepEqual(checkReply('Villa 1 – SAR 90,000, villa 2 – SAR 80,000.', { toolResults: [...upper, ...lower] }), { ok: true, hits: [] });
  assert.deepEqual(checkReply('Villa 2 – 3.2 million', { toolResults: [JSON.stringify({ results: [{ price_cash: 3_200_000 }] })] }), { ok: true, hits: [] });
});

test('a full currency name ("ريال سعودي", "Saudi riyals", "ر س") is one currency: it is shared across or/أو/و/a dash/a slash, and the tool\'s own figures pass', () => {
  const cur = (s) => findAmounts(s).map((a) => [a.raw, a.currency]);
  const upper = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 90,000 / year' }] })];
  const twoFigures = [JSON.stringify({ results: [{ rent: 90_000 }, { rent_cash: 85_000 }] })];
  const names = [
    'ريال سعودي', 'ريال  سعودي', 'ريال سعودية', 'ريالاً سعودياً', 'ريالًا سعوديًا', 'ريال سعودى', 'ريالات سعودية', 'ريالاً', 'ريالًا',
    'Saudi riyals', 'Saudi Riyal', 'saudi riyal', 'SR', 'S.R.', 'S.R', 'S. R.', 'ر.س', 'ر. س', 'ر س', 'ر.س.',
  ];
  const joins = [' أو ', ' او ', ' or ', ' و', ' و ', ' and ', ' - ', ' – ', ' / ', '/'];
  for (const name of names) {
    assert.deepEqual(cur(`الإيجار 90,000 ${name} سنوياً`), [[90_000, 'SAR']], name);
    assert.deepEqual(checkReply(`الإيجار 90,000 ${name} سنوياً`, { toolResults: upper }), { ok: true, hits: [] }, `${name}: the tool's own figure`);
    assert.deepEqual(checkReply(`Rent is 90,000 ${name} a year.`, { toolResults: upper }), { ok: true, hits: [] }, `${name}: the tool's own figure (en)`);
    for (const j of joins) {
      const discount = `الإيجار 90,000 ${name}${j}85,000 دفعة وحدة`;
      assert.deepEqual(cur(discount), [[90_000, 'SAR'], [85_000, 'SAR']], discount);
      assert.deepEqual(checkReply(discount, { toolResults: upper }).hits, [{ kind: 'amount' }], `${discount}: a second figure no tool returned`);
      assert.deepEqual(checkReply(discount, { toolResults: twoFigures }), { ok: true, hits: [] }, `${discount}: both figures returned`);
      const lowerFirst = `Rent is 85,000${j}90,000 ${name} a year.`;
      assert.deepEqual(cur(lowerFirst), [[85_000, 'SAR'], [90_000, 'SAR']], lowerFirst);
      assert.deepEqual(checkReply(lowerFirst, { toolResults: upper }).hits, [{ kind: 'amount' }], `${lowerFirst}: a lower figure no tool returned`);
    }
  }
  for (const name of ['ريال سعودي', 'ريالات سعودية', 'ر س']) {
    const glued = `الإيجار 90,000 ${name}-85,000 دفعة وحدة`;
    assert.deepEqual(cur(glued), [[90_000, 'SAR'], [85_000, 'SAR']], glued);
  }
  for (const name of ['Saudi riyals', 'SR', 'S.R.', 'ر.س', 'ر س', 'ريال سعودي']) {
    const s = `Rent is ${name} 90,000 or 85,000 in one payment.`;
    assert.deepEqual(cur(s), [[90_000, 'SAR'], [85_000, 'SAR']], s);
    assert.deepEqual(checkReply(s, { toolResults: upper }).hits, [{ kind: 'amount' }], s);
  }
  // A tool that writes the full name allows the figure in any SAR spelling.
  const arTool = [JSON.stringify({ results: [{ id: 'BONA-902', price_ar: '90,000 ريال سعودي سنوياً' }] })];
  for (const s of ['Rent is SAR 90,000 a year.', 'الإيجار 90,000 ر.س سنوياً', 'Rent is 90,000 Saudi riyals a year.']) {
    assert.deepEqual(checkReply(s, { toolResults: arTool }), { ok: true, hits: [] }, s);
  }
  // "ر س" only on its own: the last letter of a word and a lone س are no currency.
  assert.deepEqual(cur('عشر س 90'), []);
});

test('"SR" is riyals; a spelled-out thousand after a number word, or before a currency, is an amount of unknown value; idioms and areas are not', () => {
  const [sr] = findAmounts('Rent SR 85,000 a year');
  assert.deepEqual([sr.raw, sr.currency], [85_000, 'SAR']);
  assert.equal(checkReply('Rent SR 85,000 a year', { toolResults: [] }).ok, false);
  for (const s of ['الإيجار خمسمية ألف بالسنة', 'rent is five hundred thousand riyals', 'two hundred and fifty thousand', 'بمية وخمسين ألف', 'ألف ريال', 'thousand SAR']) {
    assert.deepEqual(amounts(s), [null], s);
    assert.equal(checkReply(s, { toolResults: [villa] }).ok, false, s);
  }
  for (const s of ['ألف مبروك', 'ألف شكر', 'a thousand thanks', 'خمسة آلاف متر مربع', '85 ألف متر', '1.5 مليون متر مربع']) assert.deepEqual(findAmounts(s), [], s);
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

test('a property link passes only for a home a tool returned in this turn; an earlier guarded reply allows its amounts, never its home links', () => {
  assert.equal(checkReply(`Here it is: ${SITE}/properties/sea-view-villa/`, { toolResults: [villa], siteUrl: SITE }).ok, true);
  assert.equal(checkReply(`هنا: ${SITE}/ar/properties/sea-view-villa/`, { toolResults: [villa], siteUrl: SITE }).ok, true);
  assert.deepEqual(checkReply(`Here: ${SITE}/properties/other-villa/`, { toolResults: [villa], siteUrl: SITE }).hits, [{ kind: 'link' }]);
  // Yesterday's link to a home this turn's search no longer returns (sold, removed) is a hit (DESIGN-brain §5.4).
  assert.deepEqual(checkReply(`Again: ${SITE}/properties/other-villa/`, { earlierReplies: [`${SITE}/properties/other-villa/`], siteUrl: SITE }).hits, [{ kind: 'link' }]);
  assert.deepEqual(checkReply(`Again: ${SITE}/ar/properties/other-villa/`, { toolResults: [villa], earlierReplies: [`${SITE}/ar/properties/other-villa/`], siteUrl: SITE }).hits,
    [{ kind: 'link' }], 'an earlier reply adds nothing to the homes this turn returned');
  const earlier = [`The other villa ${SITE}/properties/other-villa/ is SAR 4,100,000.`];
  assert.deepEqual(checkReply(`It is SAR 4,100,000: ${SITE}/properties/other-villa/`, { earlierReplies: earlier, siteUrl: SITE }).hits, [{ kind: 'link' }],
    'the amount of the earlier reply passes, its link does not');
  assert.deepEqual(checkReply('It is SAR 4,100,000.', { earlierReplies: earlier, siteUrl: SITE }), { ok: true, hits: [] });
  const other = JSON.stringify({ results: [{ id: 'BONA-903', slug: 'other-villa', url_en: `${SITE}/properties/other-villa/` }] });
  assert.equal(checkReply(`Again: ${SITE}/properties/other-villa/`, { toolResults: [other], earlierReplies: earlier, siteUrl: SITE }).ok, true, 'returned again in this turn');
  assert.equal(checkReply(`Our site: ${SITE}/ and ${SITE}/ar/`, { siteUrl: SITE }).ok, true, 'the site itself is not a home');
});

test("a home link passes only on Bona's own site (the same scheme, host and port as siteUrl): a returned path on any other host is a hit", () => {
  const ctx = { toolResults: [villa], siteUrl: SITE };
  assert.equal(checkReply('See https://BONA-Real-Estate.com/properties/sea-view-villa/.', ctx).ok, true, 'the host is case-free');
  assert.equal(checkReply(`(${SITE}/ar/properties/sea-view-villa/)`, ctx).ok, true);
  assert.equal(checkReply('https://bona-real-estate.com:443/properties/sea-view-villa/', ctx).ok, true, 'the default port is the same origin');
  for (const url of [
    'https://evil.example/properties/sea-view-villa/', // another host
    'https://evil.example/ar/properties/sea-view-villa/',
    'https://bona-real-estate.com.evil.example/properties/sea-view-villa/', // look-alike: the site as a subdomain of another
    'https://bona-real-estate.co/properties/sea-view-villa/', // look-alike TLD
    'https://bona-reaI-estate.com/properties/sea-view-villa/', // look-alike letter
    'https://b\u043Ena-real-estate.com/properties/sea-view-villa/', // look-alike Cyrillic o (punycode host)
    'http://bona-real-estate.com/properties/sea-view-villa/', // http, not https
    'https://www.bona-real-estate.com/properties/sea-view-villa/', // a subdomain
    'https://listings.bona-real-estate.com/properties/sea-view-villa/',
    'https://bona-real-estate.com@evil.example/properties/sea-view-villa/', // the site as a user name
    'https://bona-real-estate.com:8443/properties/sea-view-villa/', // another port
    'https://evil.example/go?to=/properties/sea-view-villa/', // the path in a query
  ]) assert.deepEqual(checkReply(`Here: ${url}`, ctx).hits, [{ kind: 'link' }], url);
  assert.deepEqual(checkReply('Again: https://evil.example/properties/other-villa/', { earlierReplies: [`${SITE}/properties/other-villa/`], siteUrl: SITE }).hits,
    [{ kind: 'link' }], 'an earlier reply allows no home, on any host');
  assert.deepEqual(checkReply(`Here: ${SITE}/properties/sea-view-villa/`, { toolResults: [villa] }).hits, [{ kind: 'link' }], 'no siteUrl: no home link passes (fail closed)');
  assert.deepEqual(checkReply(`Here: ${SITE}/properties/sea-view-villa/`, { toolResults: [villa], siteUrl: 'not a url' }).hits, [{ kind: 'link' }]);
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

test('a price right after a listing id or a unit reference and one space ("BONA-935 750,000 ر.س") is an amount; spaced groups never reach across an id or into a comma number', () => {
  for (const [s, raws] of [
    ['BONA-935 750,000 ر.س', [750_000]], ['BONA-W912 150,000 SAR', [150_000]], ['W914 750 000 ريال', [750_000]], ['BONA-W912 150 000 SAR', [150_000]],
    ['B08-19 750,000 ر.س', [750_000]], ['B08-19 750 000', [750_000]], ['Floor 2 750,000', [750_000]], ['Villa A1 750,000 SAR', [750_000]],
    ['BONA-935 ٧٥٠٬٠٠٠ ر.س', [750_000]], ['2 950 000 SAR', [2_950_000]], ['2 950 000.00 SAR', [2_950_000]], ['2 950 000,00 €', [2_950_000]],
    ['2 900 000-3 100 000 SAR', [2_900_000, 3_100_000]],
  ]) assert.deepEqual(amounts(s), raws, s);
  const tools = [JSON.stringify({ results: [
    { id: 'BONA-935', price_en: 'SAR 750,000', price_ar: '750,000 ر.س' }, { id: 'BONA-936', price_en: 'SAR 2,950,000', price_ar: '2,950,000 ر.س' },
  ] })];
  for (const text of ['BONA-935 650,000 ر.س', 'BONA-W912 150,000 SAR', 'W914 750 000 ريال', 'Floor 2 750,000', 'BONA-935 ٦٥٠٬٠٠٠ ر.س']) {
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: false, hits: [{ kind: 'amount' }] }, `${text} (no tool)`);
    if (!text.includes('750')) assert.deepEqual(checkReply(text, { toolResults: tools }), { ok: false, hits: [{ kind: 'amount' }] }, `${text} (another price)`);
  }
  for (const text of ['BONA-935 750,000 ر.س', 'BONA-936 2,950,000 ر.س', 'BONA-935 750 000 ريال']) {
    assert.deepEqual(checkReply(text, { toolResults: tools }), { ok: true, hits: [] }, `${text} (the tool's own price)`);
  }
  const units = [JSON.stringify({ results: [{ ref: 'B08-19', price_en: 'SAR 708,164', price_ar: '708,164 ر.س' }] })];
  assert.deepEqual(checkReply('B08-19 750,000 ر.س', { toolResults: units }), { ok: false, hits: [{ kind: 'amount' }] }, 'a unit ref then a price no tool returned');
  assert.deepEqual(checkReply('B08-19 708,164 ر.س', { toolResults: units }), { ok: true, hits: [] });
});

test('the Arabic comma (U+060C) between digits groups thousands like ","', () => {
  for (const [s, raw] of [
    ['2،800،000 ريال', 2_800_000], ['السعر النهائي ٢،٨٠٠،٠٠٠ ريال', 2_800_000], ['بسعر 2،800،000', 2_800_000], ['SAR 2،800،000', 2_800_000],
    ['٢،٥ مليون', 2_500_000], ['تمام، ٢،٥٠٠،٠٠٠ ضمن المتاح', 2_500_000],
  ]) assert.deepEqual(amounts(s), [raw], s);
  for (const s of ['الأدوار 1،2،3', 'تمام، 3 غرف']) assert.deepEqual(findAmounts(s), [], s);
  const beds = [JSON.stringify({ results: [{ beds: 2, price_en: 'SAR 2,950,000', price_ar: '2,950,000 ر.س' }] })];
  for (const text of ['السعر النهائي ٢،٨٠٠،٠٠٠ ريال', 'تمام، ٢،٥٠٠،٠٠٠', 'SAR 2،800،000', 'تمام، السعر ٢،٨٠٠،٠٠٠ ريال']) {
    assert.deepEqual(checkReply(text, { toolResults: [] }).hits, [{ kind: 'amount' }], `${text} (no tool)`);
    assert.deepEqual(checkReply(text, { toolResults: beds }).hits, [{ kind: 'amount' }], `${text} (another price; beds: 2)`);
  }
  assert.deepEqual(checkReply('2،950،000 ريال', { toolResults: beds }), { ok: true, hits: [] });
});

test('a spelled-out number before a million word ("تلاتة مليون", "twenty one million") is an amount of unknown value', () => {
  for (const s of ['سعرها تلاتة مليون', 'خمسة مليون ريال', 'ثلاثة مليون', 'بخمسة مليون', 'مية مليون', 'twenty one million', 'three million']) {
    assert.deepEqual(amounts(s), [null], s);
  }
  for (const [s, raw] of [['مليون', 1_000_000], ['سعرها مليون ريال', 1_000_000], ['مليونين', 2_000_000], ['a million', 1_000_000], ['one million', 1_000_000]]) {
    assert.deepEqual(amounts(s), [raw], s);
  }
  const oneMillion = [JSON.stringify({ results: [{ price_en: 'SAR 1,000,000', price_ar: '1,000,000 ر.س' }] })];
  assert.deepEqual(checkReply('سعرها تلاتة مليون', { toolResults: oneMillion }).hits, [{ kind: 'amount' }]);
  assert.equal(checkReply('سعرها مليون ريال', { toolResults: oneMillion }).ok, true);
});

test('"MM", an apostrophe thousands separator, and a short scale ("م", "ملي", "mil", "K") right before a currency are read as amounts', () => {
  for (const [s, raw] of [
    ['3.1MM', 3_100_000], ['3.1 MM SAR', 3_100_000], ["3'100'000 SAR", 3_100_000], ['3’100’000 SAR', 3_100_000], ['1.2 م ريال', 1_200_000],
    ['1.2م ريال', 1_200_000], ['3.1 ملي ريال', 3_100_000], ['3 mil SAR', 3_000_000], ['500 K SAR', 500_000],
  ]) assert.deepEqual(amounts(s), [raw], s);
  // A bare "م" is metres ("شارع 15م", "على بعد 500 م"); "mm" in lower case is millimetres; feet and inches are not grouped.
  for (const s of ['على شارع 15م', 'على بعد 500 م من البحر', 'زجاج 10mm', `5'11"`, 'شارعين 20م و 15م']) assert.deepEqual(findAmounts(s), [], s);
  const tools = [JSON.stringify({ results: [{ price_en: 'SAR 2,950,000', price_ar: '2,950,000 ر.س' }] })];
  for (const text of ['3.1MM', '3.1 MM SAR', "3'100'000 SAR", '3’100’000 SAR', '1.2 م ريال', '3.1 ملي ريال', '3 mil SAR', '500 K SAR']) {
    assert.deepEqual(checkReply(text, { toolResults: tools }).hits, [{ kind: 'amount' }], text);
  }
  assert.equal(checkReply("2'950'000 SAR", { toolResults: tools }).ok, true);
});

test('a reply that names a currency must match the tool in that currency or in SAR value; a bare figure matches the raw number', () => {
  const usd = [JSON.stringify({ results: [{ price_en: 'USD 500,000', price_ar: '500,000 دولار' }] })];
  for (const text of ['السعر 500,000 ريال', 'SAR 500,000', '500,000 درهم']) assert.deepEqual(checkReply(text, { toolResults: usd }).hits, [{ kind: 'amount' }], text);
  for (const text of ['$500,000', '500,000 دولار', 'USD 500,000', 'It is 500,000.', 'SAR 1,875,000']) assert.deepEqual(checkReply(text, { toolResults: usd }), { ok: true, hits: [] }, text);
  const sar = [JSON.stringify({ results: [{ price_en: 'SAR 750,000', price_ar: '750,000 ر.س' }] })];
  for (const text of ['$750,000', '750,000 USD', 'AED 750,000', '€750,000']) assert.deepEqual(checkReply(text, { toolResults: sar }).hits, [{ kind: 'amount' }], text);
  for (const text of ['SAR 750,000', '750,000 ريال', '750 ألف ريال', 'It is 750,000.']) assert.deepEqual(checkReply(text, { toolResults: sar }), { ok: true, hits: [] }, text);
  const cash = [JSON.stringify({ results: [{ ref: 'B08-19', price_cash: 2_950_000 }] })];
  assert.equal(checkReply('B08-19 is 2,950,000 riyals.', { toolResults: cash }).ok, true, 'a JSON number counts as SAR');
  assert.equal(checkReply('B08-19 is $2,950,000.', { toolResults: cash }).ok, false);
  assert.equal(checkReply('And the second one is $1,200,000.', { toolResults: [], earlierReplies: ['The second one is SAR 1,200,000.'] }).ok, false, 'an earlier reply keeps its currency');
});

test('WhatsApp formatting (* _ ~ ` ```) never hides an amount: the guard reads the reply as the client sees it after the WhatsApp cleanup', () => {
  // dana-wa's answerFrom flattens markdown (actions.mjs plainText) and the app draws *bold*, _italic_, ~strike~ and ```mono```
  // without their marks, so "*85,000* SAR" reaches the client as "85,000 SAR".
  const rent = [JSON.stringify({ results: [{ id: 'BONA-902', price_en: 'SAR 85,000', price_ar: '85,000 ر.س' }] })];
  for (const text of [
    'The annual rent is *85,000* SAR.', 'The annual rent is **85,000** SAR.', 'The annual rent is _85,000_ SAR.', 'The annual rent is ~85,000~ SAR.',
    'The annual rent is `85,000` SAR.', 'The annual rent is ```85,000``` SAR.', 'The annual rent is *_85,000_* SAR.', 'The annual rent is ~*85,000*~ riyals.',
    'The annual rent is 85,000 *SAR*.', 'The annual rent is *SAR* *85,000*.', 'Rent: *85,000*SAR', 'The annual rent is *85,000* _SAR_ a year.',
    'الإيجار السنوي *85,000* ريال', 'الإيجار السنوي _٨٥٬٠٠٠_ ريال', 'الإيجار السنوي ~٨٥،٠٠٠~ ر.س', 'الإيجار ```85,000``` ريال',
    'الإيجار *85,000* *ريال*', 'الإيجار *ريال* *٨٥٬٠٠٠*', 'الإيجار *_٨٥٬٠٠٠_* ريال سنوياً',
  ]) {
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: false, hits: [{ kind: 'amount' }] }, `${text} (no tool)`);
    assert.deepEqual(checkReply(text.replace(/85,000|٨٥٬٠٠٠|٨٥،٠٠٠/, '95,000'), { toolResults: rent }).hits, [{ kind: 'amount' }], `${text} (another rent)`);
    assert.deepEqual(checkReply(text, { toolResults: rent }), { ok: true, hits: [] }, `${text} (the tool's own rent)`);
  }
  for (const text of ['*Sea view villa* has *4 bedrooms* and _450 m²_.', 'نفتح ~10:00~ إلى *19:00*', 'رقم الإعلان *BONA-902*']) {
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: true, hits: [] }, text);
  }
});

test("a home link written without a scheme (\"www.example.com/properties/x/\") is checked like an http(s) one: only on Bona's own host, only for a returned home", () => {
  const ctx = { toolResults: [villa], siteUrl: SITE };
  for (const text of [
    'Here: bona-real-estate.com/properties/sea-view-villa/', 'هنا: bona-real-estate.com/ar/properties/sea-view-villa/', 'See (BONA-Real-Estate.com/properties/sea-view-villa).',
    '*bona-real-estate.com/properties/sea-view-villa/*', 'bona-real-estate.com:443/properties/sea-view-villa/', `Both: ${SITE}/properties/sea-view-villa/ and bona-real-estate.com/ar/properties/sea-view-villa/`,
  ]) assert.deepEqual(checkReply(text, ctx), { ok: true, hits: [] }, text);
  for (const link of [
    'www.example.com/properties/sea-view-villa/', // the www. form of another host
    'example.com/ar/properties/sea-view-villa', // a bare domain
    'example.com/properties/sea-view-villa',
    'www.bona-real-estate.com/properties/sea-view-villa/', // the site behind www.: a subdomain, as with https
    'listings.bona-real-estate.com/properties/sea-view-villa/',
    'bona-real-estate.com.evil.example/properties/sea-view-villa/', // look-alikes
    'bona-reaI-estate.com/properties/sea-view-villa/',
    'bona-real-estate.co/ar/properties/sea-view-villa/',
    'bоna-real-estate.com/properties/sea-view-villa/',
    'bona-real-estate.com@evil.example/properties/sea-view-villa/', // the site as a user name
    'bona-real-estate.com:8443/properties/sea-view-villa/', // another port
    '//evil.example/properties/sea-view-villa/', // scheme-relative
    'evil.example/go?to=/properties/sea-view-villa/', // the path in a query
    'bona-real-estate.com/properties/other-villa/', // the real host without a scheme, a home no tool returned
    'bona-real-estate.com/ar/properties/other-villa',
    'BONA-REAL-ESTATE.COM/PROPERTIES/OTHER-VILLA/',
  ]) {
    assert.deepEqual(checkReply(`Here: ${link}`, ctx).hits, [{ kind: 'link' }], link);
    assert.deepEqual(checkReply(`الرابط (${link})`, ctx).hits, [{ kind: 'link' }], `${link} (in brackets)`);
  }
  assert.deepEqual(checkReply('Here: bona-real-estate.com/properties/sea-view-villa/', { toolResults: [villa] }).hits, [{ kind: 'link' }], 'no siteUrl: no home link passes');
  assert.deepEqual(checkReply('Again: bona-real-estate.com/properties/other-villa/', { earlierReplies: [`${SITE}/properties/other-villa/`], siteUrl: SITE }).hits,
    [{ kind: 'link' }], 'an earlier guarded reply allows no home link, with or without a scheme');
  assert.deepEqual(checkReply(`Again: ${SITE}/properties/other-villa/`, { earlierReplies: ['bona-real-estate.com/properties/other-villa/'], siteUrl: SITE }).hits, [{ kind: 'link' }]);
  assert.deepEqual(checkReply('Again: www.example.com/properties/other-villa/', { earlierReplies: [`${SITE}/properties/other-villa/`], siteUrl: SITE }).hits,
    [{ kind: 'link' }], 'never another host');
  assert.equal(checkReply('Our site: bona-real-estate.com and bona-real-estate.com/ar/', { siteUrl: SITE }).ok, true, 'the site itself is not a home');
});

test('invisible and look-alike characters never hide an amount or a unit ref: the guard also reads the reply as a reader sees it (format marks gone, every space a space, every dash "-", every digit ASCII)', () => {
  // A direction mark, a zero-width space, a word joiner, a BOM or a bidi isolate (\p{Cf}) between a figure and its currency,
  // or inside a figure, is not drawn: "85,000<RLM> ريال" reaches the client as "85,000 ريال". A thin or en space (\p{Zs})
  // between digit groups reads as a space; U+2011, an en dash or a minus (\p{Pd}, U+2212) in a unit ref as "-"; a mark on
  // a digit (U+FE0F) is not there, but one on a letter stays ("ريالاً" is still riyals).
  const priced = (en, ar) => [JSON.stringify({ results: [{ id: 'BONA-902', price_en: en, price_ar: ar }] })];
  const tools = {
    85_000: priced('SAR 85,000', '85,000 ر.س'), 1_500_000: priced('SAR 1,500,000', '1,500,000 ر.س'), 2_950_000: priced('SAR 2,950,000', '2,950,000 ر.س'),
  };
  const another = priced('SAR 95,000', '95,000 ر.س');
  const marks = ['\u200F', '\u200E', '\u061C', '\u200B', '\u2060', '\uFEFF', '\u2066', '\u2067', '\u2068', '\u2069', '\u200F\u2069', '\uFE0F'];
  const cases = [
    ...marks.flatMap((c) => [
      [`The annual rent is 85,000${c} SAR.`, 85_000], [`The annual rent is SAR${c} 85,000.`, 85_000], [`الإيجار 85,000${c} ريال`, 85_000],
      [`الإيجار السنوي 85,000 ${c}ريالاً`, 85_000], [`الإيجار ${c}٨٥٬٠٠٠${c} ر.س`, 85_000],
    ]),
    ['الإيجار 85,000\u200F ريال', 85_000], ['السعر 2,950\u200F,000 ريال', 2_950_000], ['1\u200B,500,000 SAR', 1_500_000], ['1,500\u200B,000', 1_500_000],
    ['The annual rent is 85\u200B,000 SAR.', 85_000], ['الإيجار 85,\u200F000 ريال', 85_000], ['Rent: 85\u2060000 SAR', 85_000],
    ['Price 2\u2009950\u2009000 SAR', 2_950_000], ['Price 2\u2009950\u2009000', 2_950_000], ['Price 2\u2002950\u2002000', 2_950_000],
    ['Price 2\u2008950\u2008000', 2_950_000], ['السعر 2\u2009950\u2009000 ريال', 2_950_000], ['The annual rent is 85\u2009000 SAR.', 85_000],
    ['The annual rent is 85\u2005000 riyals.', 85_000], ['The annual rent is \uFF18\uFF15,\uFF10\uFF10\uFF10 SAR.', 85_000], ['الإيجار \u{1D7F4}\u{1D7F1},\u{1D7EC}\u{1D7EC}\u{1D7EC} ريال', 85_000],
    ['The annual rent is *85,000*\u200F SAR.', 85_000],
  ];
  for (const [text, figure] of cases) {
    const name = JSON.stringify(text);
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: false, hits: [{ kind: 'amount' }] }, `${name} (no tool)`);
    assert.deepEqual(checkReply(text, { toolResults: another }).hits, [{ kind: 'amount' }], `${name} (another price)`);
    assert.deepEqual(checkReply(text, { toolResults: tools[figure] }), { ok: true, hits: [] }, `${name} (the tool's own figure)`);
  }
  // The tool's own figure, written by the tool with these characters, allows the plain figure, and an earlier guarded reply too.
  assert.equal(checkReply('السعر 2,950,000 ريال', { toolResults: priced('SAR 2\u2009950\u2009000', '2,950\u200F,000 ر.س') }).ok, true);
  assert.equal(checkReply('الإيجار 85,000 ريال', { earlierReplies: ['الإيجار 85,000\u200F ريال'] }).ok, true);
  assert.deepEqual(checkReply('الإيجار 95,000 ريال', { earlierReplies: ['الإيجار 85,000\u200F ريال'] }).hits, [{ kind: 'amount' }]);

  const unit = [JSON.stringify({ results: [{ ref: 'B08-19', price_en: 'SAR 708,164', price_ar: '708,164 ر.س' }] })];
  const otherUnit = [JSON.stringify({ results: [{ ref: 'B09-01', price_en: 'SAR 708,164', price_ar: '708,164 ر.س' }] })];
  for (const ref of ['B08\u201119', 'B08\u201319', 'B08\u201019', 'B08\u221219', 'B08\u200B-19', 'B\u200F08-19', 'B08-\u206619\u2069', 'B\uFF10\uFF18-\uFF11\uFF19', 'b08\u201119']) {
    const text = `الوحدة ${ref} متاحة`;
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: false, hits: [{ kind: 'unit' }] }, `${JSON.stringify(ref)} (no tool)`);
    assert.deepEqual(checkReply(text, { toolResults: otherUnit }), { ok: false, hits: [{ kind: 'unit' }] }, `${JSON.stringify(ref)} (another unit)`);
    assert.deepEqual(checkReply(text, { toolResults: unit }), { ok: true, hits: [] }, `${JSON.stringify(ref)} (the tool's own unit)`);
  }
  assert.equal(checkReply('الوحدة B08-19 متاحة', { toolResults: [JSON.stringify({ results: [{ ref: 'B08\u201119' }] })] }).ok, true, 'a tool that writes U+2011 allows the plain ref');

  // Plain text is untouched by the extra reading: no new hit.
  for (const text of ['نفتح 10:00\u2013 19:00', 'Call us on +966\u202F50\u202F000\u202F0000', 'رقم الإعلان BONA\u2011902', 'Villa\u00A0with 4\u2009bedrooms and 450\u2009m²', 'Plot 12\u2009500 m²', 'السعر يحدده الفريق\u200F.']) {
    assert.deepEqual(checkReply(text, { toolResults: [] }), { ok: true, hits: [] }, JSON.stringify(text));
  }
});

/* Codex r14 P2: a "+" before an amount with a currency or thousands commas is a surcharge, never a phone. */
test('a "+" amount with a currency or thousands commas is checked like any amount; a "+" phone is not', () => {
  for (const reply of ['Parking: +15,000 SAR', 'موقف السيارات: +15,000 ريال', 'Maid room: + 25,000 SAR extra']) {
    assert.deepEqual(checkReply(reply, { toolResults: [] }).hits.map((h) => h.kind), ['amount'], reply);
  }
  assert.deepEqual(checkReply('Parking: +15,000 SAR', { toolResults: ['{"parking":"SAR 15,000"}'] }).ok, true, 'a published surcharge passes');
  for (const reply of ['Call us on +966 12 345 6789', 'اتصل على +966126543210']) assert.equal(checkReply(reply, { toolResults: [] }).ok, true, reply);
});

/* Codex r26 P2: a compound amount is one amount, checked as its total. */
test('"2 million and 500 thousand" is one amount of 2,500,000: allowed only when that total was published', () => {
  const parts = { toolResults: ['{"price":"SAR 2,000,000"}', '{"price":"SAR 500,000"}'] };
  for (const reply of ['سعر الفيلا ٢ مليون و٥٠٠ ألف ريال', 'سعر الفيلا 2 مليون و 500 ألف ريال', 'The villa is 2 million 500 thousand SAR', 'SAR 2 million and 500 thousand', 'سعر الفيلا مليونين و٥٠٠ ألف ريال', 'مليون و٥٠٠ ألف ريال']) {
    assert.deepEqual(checkReply(reply, parts).hits.map((h) => h.kind), ['amount'], reply);
    const total = reply.startsWith('مليون و') ? 'SAR 1,500,000' : 'SAR 2,500,000';
    assert.equal(checkReply(reply, { toolResults: [`{"price":"${total}"}`] }).ok, true, `${reply}: the total was published`);
  }
  assert.deepEqual(findAmounts('٢ مليون و٥٠٠ ألف ريال').map((a) => a.raw), [2_500_000]);
  assert.deepEqual(findAmounts('2 million or 500 thousand SAR').map((a) => a.raw).sort((x, y) => x - y), [500_000, 2_000_000], 'two amounts on "or" stay two');
  // A comma list is two prices, each published (Claude r26).
  const list = { toolResults: ['{"a":"SAR 1,500,000"}', '{"b":"SAR 900,000"}', '{"c":"SAR 2,000,000"}', '{"d":"SAR 500,000"}'] };
  for (const reply of ['Prices: 1.5 million, 900 thousand SAR', 'الأسعار: ١٫٥ مليون، ٩٠٠ ألف ريال', 'The villa is 2 million, 500 thousand down payment']) {
    assert.equal(checkReply(reply, list).ok, true, reply);
  }
  // The word-first form with a published total passes (Claude r26 F1).
  assert.equal(checkReply('السعر مليون و٢٠٠ ألف ريال', { toolResults: ['{"price":"SAR 1,200,000"}'] }).ok, true);
});
