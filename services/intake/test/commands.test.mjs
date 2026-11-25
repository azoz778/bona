import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANY_LISTING_ID_RE, findListingId, HELP_TEXT, LISTING_ID_RE, parseCaption, parseCommand, parseExpiryDate, parsePriceHint } from '../lib/commands.mjs';
import { INTAKE_ID_RE, LISTING_ID_RE as SITE_LISTING_ID_RE } from '../../../scripts/curate/rules.mjs';

describe('parseCaption', () => {
  it('reads an empty caption', () => {
    const c = parseCaption('');
    assert.equal(c.dryRun, false);
    assert.equal(c.publishBrochure, false);
    assert.equal(c.hidden, false);
    assert.equal(c.category, null);
    assert.equal(c.price, null);
    assert.equal(c.period, null);
  });

  it('detects #test, #brochure and #hidden', () => {
    const c = parseCaption('villa #test #brochure #hidden');
    assert.equal(c.dryRun, true);
    assert.equal(c.publishBrochure, true);
    assert.equal(c.hidden, true);
    assert.deepEqual(c.tags.sort(), ['brochure', 'hidden', 'test']);
  });

  // Every accepted brochure is re-published under Bona branding now, so #brochure only says
  // out loud what already happens and #nobrochure is the flag that changes anything.
  it('reads #nobrochure in all the shapes the owner might type it', () => {
    for (const caption of ['villa #nobrochure', 'villa #nopdf', 'villa #no-brochure', 'villa #no-pdf']) {
      assert.equal(parseCaption(caption).noBrochure, true, caption);
    }
  });

  it('leaves noBrochure false when nothing was asked for', () => {
    assert.equal(parseCaption('').noBrochure, false);
    assert.equal(parseCaption('villa #brochure').noBrochure, false);
  });

  it('#brochure is a no-op alias and never switches the brochure OFF', () => {
    const c = parseCaption('villa #brochure #nobrochure');
    assert.equal(c.publishBrochure, true);
    assert.equal(c.noBrochure, true, '#nobrochure is the one the pipeline reads');
  });

  it('maps rent hints in both languages and defaults the period to year', () => {
    assert.equal(parseCaption('for rent').category, 'rent');
    assert.equal(parseCaption('للإيجار').category, 'rent');
    assert.equal(parseCaption('for rent').period, 'year');
    assert.equal(parseCaption('for rent 250000 per month').period, 'month');
  });

  it('never sets a period on a sale', () => {
    const c = parseCaption('for sale 4,500,000 SAR per year');
    assert.equal(c.category, 'buy');
    assert.equal(c.period, null);
  });

  it('maps off-plan and international', () => {
    assert.equal(parseCaption('off-plan').category, 'off-plan');
    assert.equal(parseCaption('international listing').category, 'international');
  });
});

describe('parsePriceHint', () => {
  const cases = [
    ['SAR 4,500,000', 4500000, 'SAR'],
    ['4.5m SAR', 4500000, 'SAR'],
    ['price 750000', 750000, 'SAR'],
    ['AED 2,000,000', 2000000, 'AED'],
    ['٤٥٠٠٠٠٠ ريال', 4500000, 'SAR'],
    ['990,000 ر.س', 990000, 'SAR'],
    ['1.2 million', 1200000, 'SAR'],
    ['850k SAR', 850000, 'SAR'],
  ];
  for (const [input, amount, currency] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => {
      const p = parsePriceHint(input);
      assert.ok(p, `expected a price from ${input}`);
      assert.equal(p.amount, amount);
      assert.equal(p.currency, currency);
    });
  }

  it('ignores small bare numbers so specs are not read as prices', () => {
    assert.equal(parsePriceHint('3 bedrooms 4 bathrooms 174 sqm'), null);
  });

  it('never invents a price from an empty caption (TAQEEM)', () => {
    assert.equal(parsePriceHint(''), null);
    assert.equal(parsePriceHint('villa in Al Khalidiyah'), null);
  });

  it('takes the largest figure when several appear', () => {
    assert.equal(parsePriceHint('was 3,000,000 now SAR 4,500,000').amount, 4500000);
    assert.equal(parsePriceHint('2.5m - 3m').amount, 3000000);
    // the same amount written twice is one price, and the written currency is kept
    assert.equal(parsePriceHint('4.5 million (SAR 4,500,000)').explicitCurrency, true);
  });

  // r2 review: an old price is never the price, even when it is the larger one.
  // r4 review: every set-aside that rests on a WORD is a guess, and a guess can only veto.
  it('reads no price when an old price is larger than the new one (the label is a guess)', () => {
    for (const caption of ['Was SAR 5m, now SAR 4.5m', 'was 5,000,000 now 4,500,000', 'السعر السابق 5 مليون، الآن 4.5 مليون', 'previously 5m, reduced to 4.5m']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  // r2 review (Claude): setting a real price aside must never hand its slot to a smaller figure.
  it('keeps the real price next to a smaller fee, deposit or income figure', () => {
    for (const [caption, amount] of [
      ['Apartment in Al Olaya area SAR 1,200,000, service charge SAR 12,000/year', 1200000],
      ['Residential plot 2.5M, commission 2.5% = 62,500', 2500000],
      ['Bedrooms 4, SAR 2.5m, maintenance fee 8,000 SAR', 2500000],
      ['Building, annual income 350,000 SAR, built 2015, SAR 5.5m', 5500000],
      ['Floor 3, SAR 1,200,000 (service charge SAR 15,000)', 1200000],
      ['Villa on King Fahd Road SAR 3.2M, down payment SAR 320,000', 3200000],
      ['SAR 4.5M 200 sqm, deposit 50,000', 4500000],
      ['Price 4.5M 2025 handover, 10% down = 450,000', 4500000],
      ['Corner plot SAR 2,500,000', 2500000],
      ['Al Malqa area 4.5m', 4500000],
      ['Olaya Street 4.5m', 4500000],
      ['Built 2020, SAR 4.5m', 4500000],
      ['Unit A-12 SAR 3.2m', 3200000],
      ['Villa SAR 4.5m, 300m from the beach', 4500000],
      ['Land 30m x 40m, SAR 2.5m', 2500000],
      ['Villa 4.5m on a 30m-wide street', null],
      ['850 ألف ريال, 3.5m ceilings', null],
      ['Villa 2.8m SAR, 25m frontage', null],
    ]) {
      assert.equal(parsePriceHint(caption)?.amount ?? null, amount, caption);
    }
  });

  // r2 review: a currency between two figures was taken by the first ("Floor 12 AED 2,000,000" read SAR,
  // "Built 2019 SAR 4,500,000 متر" read SAR 2,019).
  // r3 review (Claude): a guess may only ever lose a price, never hand its slot to a smaller figure.
  it('never lets a figure set aside on a guess hand its slot to a smaller one', () => {
    for (const caption of [
      'Villa for sale 4.5m from the owner directly, service charge 15,000 SAR yearly',
      'Residential plot 2,500,000, commission 2.5% = 62,500',
      'Apartment in Al Olaya area 1,200,000, service charge SAR 12,000/year',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const [caption, amount] of [
      ['SAR 4.5m by owner, service charge 12,000', 4500000],
      // r8: a price word before the figure keeps a metre word away
      ['Price 4.5M high floor, maintenance 20,000 SAR', 4500000],
      ['شقة مدعومة من الإسكان 850,000 ريال والعربون 20,000 ريال', 850000],
      ['أرض 625 متر مربع 2.5 مليون، العربون 100 ألف', 2500000],
      ['Villa 450 sqm price SAR 4,500,000, deposit SAR 50,000', 4500000],
      ['فيلا للبيع\nالمساحة 450 متر مربع\n4,500,000 ريال\nالعربون 50,000 ريال', 4500000],
      ['Land 1,250 sqm, SAR 3,600 per sqm\n4,500,000 SAR total\nDeposit 100,000 SAR', 4500000],
      ['Price 4,500,000 (per sqm 7,200), deposit 50,000', 4500000],
      ['Handover 30.06.2027, price 1.2M', 1200000],
      ['Apartment 1.2M 2 bedrooms', 1200000],
      ['Villa 4.5m 2 floors, annual maintenance 6,000 SAR', 4500000],
      ['Villa 2.8m SAR, Frontage 25m', null],
      ['Ceiling height 3m, Area 450 sqm\n- Zero commission: 2,150,000', null],
      ['Height 3m\n- Price without commission: 2150000', null],
      ['Ceiling height 3m, villa 4.5m SAR', 4500000],
      ['Plot dimensions 25m by 40m, 2.5m SAR', null],
      ['Apartment 4.5M x 2 payments, deposit 50,000', 4500000],
      ['Area: 12,000\nPrice: SAR 4,500,000', 4500000],
    ]) {
      assert.equal(parsePriceHint(caption)?.amount ?? null, amount, caption);
    }
    for (const caption of ['• Price per sqm:\n• SAR 3,500', 'Price per sqm:\n\nSAR 3,500']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('reads no price when a deposit, fee or income figure is larger than the price, and never takes it', () => {
    assert.equal(hint('Rent 45,000 per year, deposit 5,000'), 'SAR 45000');
    assert.equal(hint('السعر بدون عمولة 4,500,000 ريال\nمؤجرة بـ 180,000 ريال سنوياً'), 'SAR 4500000');
    assert.equal(hint('Zero commission: 12.5M, 1,500 sqft'), 'SAR 12500000');
    for (const [caption, amount] of [
      ['Price SAR 85,000 yearly العربون 100 ألف', null],
      ['شقة تمليك السعر: ٦٥ ألف سنوي\n- العربون 100 ألف', null],
      ['Rent 45,000 per year, deposit 50,000', null],
      ['Office SAR 120,000 yearly, service charge SAR 150,000', null],
      ['Building SAR 5.5m, annual income 6,000,000', null],
    ]) {
      assert.equal(parsePriceHint(caption)?.amount ?? null, amount, caption);
    }
    assert.equal(parsePriceHint('Deposit 50,000'), null);
  });

  // r4 review (Codex)
  it('reads currencies as whole words and keeps them with their figure', () => {
    assert.equal(hint('AED 450,000 European-style apartment'), 'AED 450000');
    assert.equal(hint('Price 450,000 AED 2027-06-30 handover'), 'AED 450000');
    assert.equal(hint('Price 2m\nAED'), 'AED 2000000');
    assert.equal(hint('Price 450,000 AED 1,200 m frontage'), 'AED 450000');
    assert.equal(hint('Price 450,000 AED (per sqm: AED 7,200)\nBank valuation 400,000 AED'), 'AED 450000');
  });

  it('never reads a price that includes fees as a fee', () => {
    assert.equal(hint('Price including fees:\n\n• 2,000,000 AED\nBank valuation: 1,850,000 AED'), 'AED 2000000');
    assert.equal(hint('السعر شامل الرسوم: 2,000,000 ريال'), 'SAR 2000000');
    assert.equal(parsePriceHint('Booking fee 5,000 SAR'), null);
    assert.equal(parsePriceHint('رسوم الخدمة 12,000 ريال'), null);
  });

  it('reads a full-width colon as a label colon', () => {
    assert.equal(parsePriceHint('Price per m²：\n• AED 3,500'), null);
  });

  it('gives a currency between two figures to the first when the second is smaller', () => {
    assert.equal(hint('Off-plan 1,250,000 AED 2027 handover'), 'AED 1250000');
    assert.equal(hint('Price: 1,450,000 AED 1,100 BUA'), 'AED 1450000');
    assert.equal(hint('Asking 5.9m, 6.2m with furniture'), 'SAR 6200000');
    assert.equal(hint('SAR 2.05M'), 'SAR 2050000');
    assert.equal(hint('Villa 4.5m - Street facing\nDiscount 200,000 for cash'), 'SAR 4500000');
    assert.equal(hint('فيلا 4.5m واجهة شمالية | مؤجرة 150 ألف'), 'SAR 4500000');
    assert.equal(hint('Price 4.5m - Height 3m'), 'SAR 4500000');
  });

  // r5 review (Codex)
  it('round 5: rate units, attached currencies, blank lines, rounding', () => {
    assert.equal(hint('Price 450,000 AED (per m²: AED 7,200)\nBank valuation 400,000 AED'), 'AED 450000');
    assert.equal(hint('Dubai apartment: 450,000AED 5 bedrooms'), 'AED 450000');
    assert.equal(hint('Price: AED\n\n450,000'), 'AED 450000');
    assert.equal(hint('Price 450,000\n\nAED'), 'AED 450000');
    assert.equal(parsePriceHint('Asking 4.5m\nEstimated rent USD 180,000\nDeposit SAR 15,000'), null);
    assert.equal(hint('Asking SAR 125m long-term lease, current annual rent 4m'), 'SAR 125000000');
    assert.equal(hint('Asking OMR 175,000.125'), 'OMR 175000.125');
    assert.equal(hint('SAR 2.05M'), 'SAR 2050000');
    assert.equal(parsePriceHint('Price per sqm\n• AED 3,500'), null);
  });

  // r5 review (Claude)
  it('round 5: currency gap, multi-currency veto, metres next to money, per-m rates, frontage labels', () => {
    assert.equal(hint('Price 4,500,000 (USD 1,200,000)'), 'SAR 4500000');
    assert.equal(hint('Apartment 850,000 (OMR 87,000)'), 'SAR 850000');
    assert.equal(hint('Villa 2,500,000 (AED 9,500 service charge)'), 'SAR 2500000');
    assert.equal(hint('Price: SAR 2,500,000 (USD 680,000)'), 'SAR 2500000');
    assert.equal(parsePriceHint('Price 4,500,000\n≈ USD 1,200,000\n≈ EUR 1,100,000'), null);
    assert.equal(hint('Land for sale SAR 150m from the owner directly, rented SAR 9,500,000 yearly'), 'SAR 150000000');
    assert.equal(hint('Mall for sale SAR 150m high yield\nRented SAR 10,500,000 yearly'), 'SAR 150000000');
    assert.equal(hint('Rent SAR 15,000/m - parking SAR 1,500'), 'SAR 15000');
    assert.equal(hint('Apartment for rent\nRent AED 12,000 / m\nرسوم ايجار 2,500 AED'), 'AED 12000');
    assert.equal(parsePriceHint('Shop SAR 15,000/m - parking SAR 1,500'), null);
    assert.equal(hint('Rent SAR 15,000/month - parking SAR 1,500'), 'SAR 15000');
    assert.equal(parsePriceHint('Villa for sale - sea frontage 3.2m\nCurrently rented 180,000/yr'), null);
    const t0 = performance.now();
    assert.equal(hint('450,000' + ' '.repeat(64000)), 'SAR 450000');
    assert.ok(performance.now() - t0 < 1000);
  });

  // r6 review (Codex)
  it('round 6: unit labels, own currency first, line breaks, per m ², attached currency scan', () => {
    assert.equal(hint('Unit 12 price AED\n450,000'), 'AED 450000');
    assert.equal(hint('Asking 4,500,000 (sqm: 450)\nBank valuation: 4,200,000'), 'SAR 4500000');
    assert.equal(hint('Asking 4,500,000 (sqm 450)'), 'SAR 4500000');
    assert.equal(hint('Asking AED 450,000 EUR equivalent: 115,000'), 'AED 450000');
    assert.equal(parsePriceHint('For rent: AED 1,200 per m ²'), null);
    assert.equal(parsePriceHint('Asking 4.5mAED\nEquivalent USD 1.225m\nBank valuation 5m'), null);
    assert.equal(hint('Price\r\nAED\r\n\r\n450,000'), 'AED 450000');
    const t0 = performance.now();
    assert.equal(hint('Asking AED 450,000' + '\r\n'.repeat(3000) + 'Available now'), 'AED 450000');
    assert.ok(performance.now() - t0 < 1000);
  });

  // r6 review (Claude)
  it('round 6: per-metre rates in parentheses, "/m." at a sentence end, borrowed currencies', () => {
    assert.equal(hint('السعر 3 مليون (المتر 1500 ريال)'), 'SAR 3000000');
    assert.equal(hint('Price 1.85M (sqm price AED 4,500)'), 'SAR 1850000');
    // no price word before 850,000: the unit after it may make it an area, so a guess (no caption price)
    assert.equal(parsePriceHint('من 780,000 حتى 850,000 (المتر 1850 ريال)'), null);
    assert.equal(hint('السعر من 780,000 حتى السعر 850,000 (المتر 1850 ريال)'), 'SAR 850000');
    assert.equal(hint('Rent SAR 15,000/m. Parking SAR 1,500'), 'SAR 15000');
    assert.equal(hint('Apartment for rent AED 8,500/m.\nChiller AED 1,200'), 'AED 8500');
    assert.equal(hint('Monthly installment 15,000 SAR 2.15M USD 1,100 BUA'), 'USD 2150000');
    assert.equal(parsePriceHint('Land 1.2m sqm, deposit 50,000'), null);
    assert.equal(hint('فرصة استثمارية\nأرض 600 م السعر 900,000 المتر 1500 ريال'), 'SAR 900000');
    assert.equal(hint('أرض 1200 م السعر 2,160,000 المتر 1800 ر.س'), 'SAR 2160000');
    assert.equal(parsePriceHint('Land 12,000 sqm 2 streets'), null);
  });

  it('reads the rent figure before "/m" on a rent caption, and leaves the period alone', () => {
    const c = parseCaption('Apartment for rent: AED 12,000 / m');
    assert.equal(c.price.amount, 12000);
    // r7 review: a "/m" elsewhere (parking) must not turn a yearly rent monthly
    assert.equal(parseCaption('For rent: AED 45,000 annually\nParking AED 1,200/m').period, 'year');
  });

  // r7 review (Codex)
  it('round 7: a currency between a bare price and a large detail, plain units before money, "/ m sq"', () => {
    assert.equal(parsePriceHint('Dubai villa 2.4m AED 12,000 service charge'), null);
    assert.equal(hint('Land 450٬000 sqft USD 0.20/sqft\nAsking USD 90,000'), 'USD 90000');
    assert.equal(parsePriceHint('For rent: AED 12,000 / m sq'), null);
    assert.equal(hint('Villa AED 2.4m, AED 12,000 service charge'), 'AED 2400000');
    // r7 review (Claude): a unit that labels the next figure keeps the area rule for a bare figure
    assert.equal(parsePriceHint('Warehouse 12,000 sqm: suitable for logistics'), null);
    assert.equal(parsePriceHint('Land 12,000 sqm SAR 1,500 per sqm'), null);
    assert.equal(parsePriceHint('أرض 15000 م2 950 ريال للمتر'), null);
    assert.equal(hint('Price 2,000,000 AED'), 'AED 2000000');
    assert.equal(parsePriceHint('Price 2,000,000 AED 450,000 down payment'), null);
    assert.equal(parsePriceHint('Villa for rent, SAR 120,000. Video: https://m.youtube.com/watch?v=abc') && parseCaption('Villa for rent, SAR 120,000. Video: https://m.youtube.com/watch?v=abc').period, 'year');
  });

  // r8 review (Codex)
  it('round 8: m sq ft, a currency line with words, a price word before metres', () => {
    assert.equal(hint('Asking 4.5m sq ft 12,000 SAR 3,000 annual service charge'), 'SAR 4500000');
    assert.equal(hint('Dubai apartment: Asking 450,000\nAED negotiable'), 'AED 450000');
    assert.equal(hint('Asking 150m from the owner directly\nAnnual rent SAR 9,500,000'), 'SAR 150000000');
    assert.equal(hint('Asking:\n4,500,000 (sqm: 450)\nBank valuation 4,200,000'), 'SAR 4500000');
    assert.equal(parsePriceHint('Land 12,000 m.sq'), null);
    const t0 = performance.now();
    assert.equal(hint('Price AED 450,000\n' + 'ً'.repeat(60000)), 'AED 450000');
    assert.ok(performance.now() - t0 < 500);
  });

  // r8 review (Claude)
  it('round 8: "/m" with a word after on a rent caption, whose currency across a comma or a line', () => {
    assert.equal(hint('1BR for rent AED 6,500/m sqft 850, parking AED 1,000'), 'AED 6500');
    assert.equal(hint('Rent AED 12,000 /m. Square layout, chiller AED 1,200'), 'AED 12000');
    assert.equal(parsePriceHint('Rent AED 12,000 / m sq, parking AED 1,000'), null);
    assert.equal(parsePriceHint('Price 980,000, OMR 196,000 to book'), null);
    assert.equal(parsePriceHint('Price 2,000,000\nAED 450,000 down payment'), null);
    assert.equal(parsePriceHint('Villa for sale 4.5M\nUSD 900,000 to book'), null);
    assert.equal(hint('السعر 3,500,000 ريال 50,000 عربون'), 'SAR 3500000');
    assert.equal(parsePriceHint('Apartment in Dubai Marina 980,000 ,USD 245,000 down payment'), null);
    assert.equal(parsePriceHint('4,500,000,USD 900,000 down payment'), null);
    assert.equal(hint('Price,4,500,000 SAR'), 'SAR 4500000');
    // a comma inside a figure never starts one: an emoji before the figure must not leave 500,000
    assert.equal(parsePriceHint('فيلا للبيع - 🔥12,500,000 SAR🔥'), null);
    assert.equal(parsePriceHint('Villa for sale | 💵4,500,000 ر.س💵 | 625 م2'), null);
    // a currency line that carries its own figure never joins the line above (a phone there must not become a price)
    assert.equal(hint('Ref No. 4582\nللتواصل: 0555226302\nريال سعودي 1.85M'), 'SAR 1850000');
    assert.equal(hint('Call 0555226302 SAR, villa 1.85M'), 'SAR 1850000');
    assert.equal(hint('Price 2,000,000\nAED 2,500,000 for the bigger unit'), 'AED 2500000');
  });

  it('parses a caption full of spaces in linear time', () => {
    const t0 = performance.now();
    assert.equal(hint('450,000' + ' '.repeat(112000) + 'AED'), 'AED 450000');
    assert.ok(performance.now() - t0 < 1000);
  });

  it('gives a currency to the figure it belongs to', () => {
    assert.equal(hint('Floor 12 AED 2,000,000'), 'AED 2000000');
    assert.equal(hint('Bedrooms 4 AED 450,000'), 'AED 450000');
    assert.equal(hint('4,500,000 AED 5 bedrooms'), 'AED 4500000');
    assert.equal(hint('4,500,000 AED, 5 bedrooms'), 'AED 4500000');
    assert.equal(parsePriceHint('Built 2019 SAR 4,500,000 متر'), null);
    assert.equal(parsePriceHint('Built 2019 SAR 4 500 000'), null);
  });

  it('sets money with an area unit aside as a guess', () => {
    assert.equal(hint('SAR 4,500,000 sqm 450'), null);
    // a price word before a multiplier figure: the unit after it labels the next figure
    assert.equal(hint('Price 4.5M sqm 450'), 'SAR 4500000');
    // without a price word, the unit after the multiplier makes it a guess
    assert.equal(hint('Villa 4.5M sqm 450'), null);
    assert.equal(hint('Land 12,000 sqm 4.5M متر'), null);
  });

  it('reads no price when widths that may be millions are larger than the price', () => {
    assert.equal(hint('Corner villa on 2 streets 20m and 15m, 4.5m'), null);
    assert.equal(hint('Corner villa, streets 20m and 15m wide, 4.5m'), null);
  });

  // r3 review (Codex): rules meant for figures with no currency reached money, and a currency went astray.
  it('keeps money money: the metre and label rules never touch a figure with a currency', () => {
    assert.equal(hint('Villa asking AED 4.5m from the developer, deposit AED 50,000'), 'AED 4500000');
    assert.equal(hint('Villa in Al Olaya area\n4,500,000\nDeposit 50,000'), 'SAR 4500000');
    assert.equal(hint('AED 1000000000'), 'AED 1000000000');
  });

  it('hands a currency back to the figure before it, whatever it reached', () => {
    assert.equal(hint('8,500 AED 3 bedrooms, deposit AED 2,000'), 'AED 8500');
    // a currency between a figure and an area, rate or metres is the figure's before
    assert.equal(hint('450,000 AED 1,200 sqm'), 'AED 450000');
    assert.equal(hint('450,000 AED 450/m2'), 'AED 450000');
    assert.equal(hint('Dubai Marina 1,250,000 USD 2,400 sqft'), 'USD 1250000');
    assert.equal(hint('850 ألف ريال 3.5m ceilings'), null);
    assert.equal(hint('4,500,000  AED 5 bedrooms'), 'AED 4500000');
    assert.equal(hint('Price 4,500,000 SAR 450 m²'), 'SAR 4500000');
    assert.equal(hint('Price:\n2,500,000\nAED'), 'AED 2500000');
    // several currencies: only figures with their own written currency count, and only SAR ones when SAR is there
    assert.equal(hint('Service charge 12,000 SAR 20m street / Big size villa 1.2M USD cash'), null);
    assert.equal(hint('سعر المتر 3500 ريال 2,000,000 AED (negotiable)'), 'AED 2000000');
    assert.equal(hint('Price 450,000 AED 3,500,000 USD'), 'USD 3500000');
    // AED between 2,000,000 and 545,000 may be either's: no caption price
    assert.equal(parsePriceHint('Price 2,000,000 AED 545,000 USD 3 BR'), null);
    assert.equal(parsePriceHint('الأسعار بين 2.1 million و 2.4 million USD 654,000 approx.'), null);
    assert.equal(hint('Penthouse Price SAR 6,200,000 (EUR 1,519,000)'), 'SAR 6200000');
    assert.equal(hint('Price: 2,500,000 AED / 2,553,000 SAR'), 'SAR 2553000');
    assert.equal(hint('Penthouse - Price: 2,500,000 AED 2,553,000 SAR 450 sqm'), 'SAR 2553000');
    // AED stays with 4,400,000 (a conversion): the largest written figure is the price
    assert.equal(hint('SAR 4,500,000 AED 4,400,000'), 'SAR 4500000');
    // a currency handed back onto a figure that already holds a different one firmly: no caption price
    assert.equal(parsePriceHint('SAR 4,500,000 AED 450 sqm'), null);
    assert.equal(hint('فيلا للبيع - 6,200,000 AED 6,330,000 SAR 5 BR'), 'SAR 6330000');
    assert.equal(hint('Penthouse - Price: 4,500,000 AED (~4,595,000 SAR)'), 'SAR 4595000');
    assert.equal(hint('Villa for sale Price 2,500,000 AED (~681,000 USD)'), 'AED 2500000');
    assert.equal(hint('Off-plan towers\nVilla 1: SAR 1,850,000\nType 2 - 1400 sqft: 2,450,000 SAR\nService charge AED 18/sqft'), 'SAR 2450000');
    assert.equal(hint('Rented 180,000 yearly، لا تحتاج صيانة 6,200,000 SAR 3 BR'), 'SAR 6200000');
    assert.equal(hint('Free booking - 4.5M AED Q4 2027\n- Monthly installment 15,000 SAR'), 'AED 4500000');
    assert.equal(hint('القسط الشهري ٨٬٥٠٠ ريال, السعر EUR 2,500,000 (final)'), 'EUR 2500000');
    assert.equal(hint('Unit A12 price: AED\n450,000'), 'AED 450000');
    assert.equal(parsePriceHint('Price per m2: AED\n12,000'), null);
  });

  it('reads no price at all when a figure is unclear, rather than a smaller one', () => {
    for (const caption of ['Villa 450 m 2, annual maintenance 6,000 SAR', 'SAR 4,500 000', 'SAR 1,250 000 negotiable', 'SAR 4,500, 000, service charge 12,000 SAR',
      'Price: SAR 4500 000', 'Price: AED 1 200 000, deposit AED 50,000']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  // The m of "m2" used to be read as "million": "Villa 450 m2" became SAR 450,000,000, larger
  // than the real price, so it won. A multiplier must be a whole word now.
  it('never reads the m of an area unit as millions', () => {
    for (const caption of ['Villa 450 m2', 'Villa 450m2', 'Villa 450 m²', 'villa 450 M2 for sale']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parsePriceHint('Villa 450 m2 SAR 4,500,000').amount, 4500000);
    assert.equal(parsePriceHint('SAR 4,500,000 villa 450m2').amount, 4500000);
  });

  it('never reads the m or k of a word that only starts with one as a multiplier', () => {
    assert.equal(parsePriceHint('10 mins to the airport'), null);
    assert.equal(parsePriceHint('15 km from the corniche'), null);
    assert.equal(parsePriceHint('15 km from the corniche, 2.5m SAR').amount, 2500000);
  });

  // A bare figure of 10,000 or more used to pass as a price even when it was the plot area.
  it('never takes an area as the price, however large', () => {
    for (const caption of [
      'Land 12,000 sqm', 'Land 12,000 sq m', 'Land 12,000 sq. m', 'Land 12000m2', 'Land 12,000 square meters',
      'Land 120,000 sq ft', 'أرض 12000 م2', 'أرض ١٢٠٠٠ م²', 'أرض 12000 متر مربع',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parsePriceHint('Land 12,000 sqm SAR 9,000,000').amount, 9000000);
  });

  it('never takes a rate per square metre as the price', () => {
    for (const caption of ['SAR 3,500/m2', '3,500 SAR per sqm', '3500 ريال للمتر', '3500 ريال / م2']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parsePriceHint('Land 12,000 m2 at SAR 3,500/m2, total SAR 42,000,000').amount, 42000000);
  });

  it('keeps a price that is only followed by a word that starts like a unit', () => {
    assert.equal(parsePriceHint('4,500,000 ريال مترو الرياض قريب').amount, 4500000);
    assert.equal(parsePriceHint('4,500,000 ريال للبيع').amount, 4500000);
    assert.equal(parsePriceHint('SAR 4,500,000 metro nearby').amount, 4500000);
    assert.equal(parsePriceHint('SAR 4,500,000 per year').amount, 4500000);
  });

  // r1 review (Claude + Codex): every caption below read wrongly at cbf3ad4, most of them on main too.
  const hint = (c) => { const p = parsePriceHint(c); return p && `${p.currency} ${p.amount}`; };

  it('reads each line on its own: an area on the next line never cancels the price', () => {
    assert.equal(hint('Price: 4.5m SAR\nSqm: 12,000'), 'SAR 4500000');
    assert.equal(hint('Bedrooms: 4\nAED 450,000'), 'AED 450000');
    assert.equal(hint('Price SAR 4,500,000\n4 bedrooms'), 'SAR 4500000');
  });

  it('never runs a figure into the number after it', () => {
    assert.equal(hint('SAR 4,500,000 4 bedrooms'), 'SAR 4500000');
    assert.equal(hint('SAR 4,500,000, 5 bedrooms'), 'SAR 4500000');
    // "950,000 120" could be one figure typed with a stray space: unclear, so no caption price
    assert.equal(hint('SAR 950,000 120 units'), null);
    // spaces never group thousands (they joined phone numbers and unit counts into prices)
    assert.equal(parsePriceHint('SAR 4 500 000'), null);
    assert.equal(hint('SAR 950 000 120 units'), null);
    assert.equal(hint('Price: SAR 3,200,000\nCall (+966) 555 226 302'), 'SAR 3200000');
    // a stray space after a comma is a broken figure, not a smaller price
    assert.equal(parsePriceHint('SAR 4,500, 000'), null);
    assert.equal(hint('SAR 4,500,000, 450 m2'), 'SAR 4500000');
    assert.equal(hint('SAR 4,500,000.'), 'SAR 4500000');
    assert.equal(hint('SAR 4,500,000.00'), 'SAR 4500000');
  });

  it('takes a currency written at the end of the line above the figure', () => {
    assert.equal(hint('Price: AED\n450,000'), 'AED 450000');
    assert.equal(hint('Price: EUR\u202F450,000'), 'EUR 450000');
    assert.equal(hint('450,000\nAED'), 'AED 450000');
    assert.equal(hint('Price 450,000\nAED\nVilla in Obhur'), 'AED 450000');
    // a currency line between two figure lines: whose is it? no caption price
    assert.equal(parsePriceHint('Price 450,000\nAED\n3 bedrooms'), null);
    assert.equal(parsePriceHint('Floor 3\nAED\n450,000'), null);
  });

  it('keeps a large price written in groups even though it is long', () => {
    assert.equal(hint('AED 1,000,000,000'), 'AED 1000000000');
  });

  it('reads the Arabic decimal and thousands separators', () => {
    assert.equal(hint('السعر ٤٫٥ مليون ريال'), 'SAR 4500000');
    assert.equal(hint('السعر ٤٬٥٠٠٬٠٠٠ ريال'), 'SAR 4500000');
  });

  it('reads the multiplier words it used to read, and their Arabic endings', () => {
    assert.equal(hint('السعر ٨٥٠ ألفاً ريال'), 'SAR 850000');
    assert.equal(hint('السعر ٨٥٠ ألف ريال'), 'SAR 850000');
    assert.equal(hint('4.5 millions SAR'), 'SAR 4500000');
    assert.equal(hint('4.5mil SAR'), 'SAR 4500000');
    assert.equal(hint('4.5 mln'), 'SAR 4500000');
    assert.equal(hint('4.5M'), 'SAR 4500000');
  });

  it('never reads a spaced or written-out square metre as millions', () => {
    for (const caption of ['Villa 450 m 2', 'Villa 450 m ²', 'Villa 450 m^2', 'Villa 450 M 2 for sale', 'Land 12,000 m 2']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('never reads the m of a street width as the price', () => {
    // 20m before "street" may be 20 million: a guess, larger than the price, so no caption price
    assert.equal(hint('Villa 600 m2 on a 20m street, SAR 3,200,000'), null);
    assert.equal(hint('Villa on a 20 m road, 3.2m SAR'), null);
    assert.equal(hint('Villa SAR 3.2m on a 200m road'), 'SAR 3200000');
  });

  it('knows more ways to write an area', () => {
    for (const caption of [
      'Land 12,000 (sqm)', 'أرض ١٢٠٠٠ أمتار مربعة', 'أرض 12000 م', 'المساحة 12000م', 'Land 12,000 sq yd', 'Land 12,000 ft²',
      'Land 12,000 sq mt', 'Land 12,000 square-meters', 'Land 12,000 meter2', 'أرض 12000 مترا', 'أرض 12000 مـ2', 'أرض 12000 \u200Fم2',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('never takes a figure whose label says area or rate per metre', () => {
    for (const caption of [
      'Area: 12,000', 'Sqm: 12,000', 'Plot area 12,000', 'سعر المتر: ٣٥٠٠ ريال', '٣٥٠٠ ريال / المتر المربع',
      'Price per sqm SAR 3,500', 'المساحة: ١٢٠٠٠', 'أرض 12000 م2 سعر المتر 3500 ريال',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const caption of ['Price per square metre: SAR 3,500', 'Area (sqm): 12,000', 'Price per sqm:\nSAR 3,500']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(hint('Area 450 m2, price 4.5m'), 'SAR 4500000');
    assert.equal(hint('Size: 450 m2 / Price: 4,500,000'), 'SAR 4500000');
  });

  it('never takes a phone, licence or id number as the price', () => {
    assert.equal(hint('SAR 4,500,000 call 0555226302'), 'SAR 4500000');
    assert.equal(parsePriceHint('ترخيص 7200012345'), null);
    assert.equal(parsePriceHint('call 0555226302'), null);
    assert.equal(parsePriceHint('رقم الهوية 1012345678'), null);
    // written in groups: a figure straight after another figure is part of a longer number
    assert.equal(parsePriceHint('+966 55 522 6302'), null);
    assert.equal(parsePriceHint('call 0555 226 302'), null);
    assert.equal(hint('SAR 4,500,000 call 0555 226 302'), 'SAR 4500000');
  });

  it('reads a bare m after 1,000 or more as metres, and a distance as no price', () => {
    for (const caption of ['Land 12,000 m', 'SAR 4,500,000 m', '15,000 km from the city', 'أرض 12000 مترمربع', 'Call 55 522 6302', '966 555226302']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a street then 20m: its width or 20 million? Unclear, so no caption price
    assert.equal(hint('Villa on street 20m, 4.5m SAR'), null);
    assert.equal(parsePriceHint('street 20m'), null);
    assert.equal(hint('Jeddah West 12m'), 'SAR 12000000');
    assert.equal(hint('Villa on a 20m-wide street, SAR 3,200,000'), null);
    assert.equal(hint('Villa 450 m ^ 2\nPrice: SAR 3,200,000'), 'SAR 3200000');
  });
});

// Review finding: both of these used to be hand-written copies of the site's rules, which is
// how two definitions of the same id drift apart. They are DERIVED now — same source, plus
// the /i the owner's phone keyboard needs — so the copy cannot rot.
describe('the command id patterns are the site\'s own, not a second copy', () => {
  it('derives the intake id pattern from rules.mjs::INTAKE_ID_RE', () => {
    assert.equal(LISTING_ID_RE.source, INTAKE_ID_RE.source);
    assert.equal(LISTING_ID_RE.flags, 'i');
  });
  it('derives the licence id pattern from rules.mjs::LISTING_ID_RE', () => {
    assert.equal(ANY_LISTING_ID_RE.source, SITE_LISTING_ID_RE.source);
    assert.equal(ANY_LISTING_ID_RE.flags, 'i');
  });
  it('still means what the commands need it to mean', () => {
    for (const id of ['BONA-015', 'bona-015', 'BONA-W003', 'bona-w0123']) assert.ok(ANY_LISTING_ID_RE.test(id), id);
    for (const id of ['BONA-15', 'BONA-W1', 'TK-001', 'BONA-015 ']) assert.ok(!ANY_LISTING_ID_RE.test(id), id);
    assert.ok(!LISTING_ID_RE.test('BONA-015'), 'the intake pattern still refuses a curated id');
  });
});

describe('parseCommand', () => {
  it('stays silent on ordinary chatter', () => {
    for (const text of ['hello', 'شكرا', 'when is the viewing?', '']) {
      assert.equal(parseCommand(text).cmd, null, text);
    }
  });

  it('parses remove', () => {
    assert.deepEqual(parseCommand('remove BONA-W003'), { cmd: 'remove', id: 'BONA-W003' });
    assert.deepEqual(parseCommand('remove bona-w003'), { cmd: 'remove', id: 'BONA-W003' });
    assert.equal(parseCommand('remove').cmd, 'error');
    assert.equal(parseCommand('remove BONA-003').cmd, 'error', 'curated ids are not editable from WhatsApp');
  });

  it('parses hero with a 1-based photo number', () => {
    assert.deepEqual(parseCommand('hero BONA-W003 4'), { cmd: 'hero', id: 'BONA-W003', index: 4 });
    assert.equal(parseCommand('hero BONA-W003 0').cmd, 'error');
    assert.equal(parseCommand('hero BONA-W003').cmd, 'error');
  });

  it('parses price, including on-request', () => {
    assert.deepEqual(parseCommand('price BONA-W003 4500000'), { cmd: 'price', id: 'BONA-W003', amount: 4500000, currency: 'SAR', onRequest: false });
    assert.deepEqual(parseCommand('price BONA-W003 onrequest'), { cmd: 'price', id: 'BONA-W003', onRequest: true });
    assert.deepEqual(parseCommand('price BONA-W003 on request'), { cmd: 'price', id: 'BONA-W003', onRequest: true });
    assert.equal(parseCommand('price BONA-W003').cmd, 'error');
  });

  it('parses the status verbs', () => {
    assert.deepEqual(parseCommand('sold BONA-W003'), { cmd: 'status-set', id: 'BONA-W003', status: 'sold' });
    assert.deepEqual(parseCommand('reserved BONA-W003'), { cmd: 'status-set', id: 'BONA-W003', status: 'reserved' });
    assert.deepEqual(parseCommand('available BONA-W003'), { cmd: 'status-set', id: 'BONA-W003', status: 'available' });
    assert.deepEqual(parseCommand('hide BONA-W003'), { cmd: 'hidden-set', id: 'BONA-W003', hidden: true });
    assert.deepEqual(parseCommand('show BONA-W003'), { cmd: 'hidden-set', id: 'BONA-W003', hidden: false });
  });

  // `brochure <id>` re-runs brochure_pdf.py on the listing and its files in the repo. It is
  // what the owner reaches for after `price` or a title fix: those facts are printed in the
  // brochure, so the PDF goes stale the moment they change.
  it('parses brochure <id>, and `pdf` as its alias', () => {
    assert.deepEqual(parseCommand('brochure BONA-W003'), { cmd: 'brochure', id: 'BONA-W003' });
    assert.deepEqual(parseCommand('brochure bona-w003'), { cmd: 'brochure', id: 'BONA-W003' });
    assert.deepEqual(parseCommand('/pdf BONA-W012'), { cmd: 'brochure', id: 'BONA-W012' });
  });

  it('asks for an id rather than guessing which listing to rebuild', () => {
    assert.equal(parseCommand('brochure').cmd, 'error');
    assert.match(parseCommand('brochure').message, /brochure BONA-W001/);
    assert.equal(parseCommand('brochure BONA-003').cmd, 'error', 'curated ids are not editable from WhatsApp');
  });

  it('parses help / status / retry, with or without a leading slash', () => {
    assert.equal(parseCommand('help').cmd, 'help');
    assert.equal(parseCommand('/help').cmd, 'help');
    assert.equal(parseCommand('status').cmd, 'status');
    assert.equal(parseCommand('retry').cmd, 'retry');
  });

  // REGA advertisement licences. Two things separate these from every other command: they
  // also address a CURATED listing (BONA-###), whose numbers live in licences.json rather
  // than an inbox JSON; and nothing about them is guessed — a licence line the owner cannot
  // show REGA is worse than no line, so anything that does not parse is a usage error.
  it('parses licence <id> <adNumber> <expiry>', () => {
    assert.deepEqual(parseCommand('licence BONA-W003 7200012345 2027-03-01'), {
      cmd: 'licence', id: 'BONA-W003', adNumber: '7200012345', adExpiry: '2027-03-01', lang: 'en',
    });
    assert.deepEqual(parseCommand('license bona-w003 7200012345 2027-03-01'), {
      cmd: 'licence', id: 'BONA-W003', adNumber: '7200012345', adExpiry: '2027-03-01', lang: 'en',
    }, 'the American spelling is the same command');
    assert.equal(parseCommand('/licence BONA-W003 FAL-7200012345/2 2027-03-01').adNumber, 'FAL-7200012345/2', 'letters, / and - are all in a REGA number');
  });

  it('reaches a curated listing too — a licence belongs to every listing, not just the intake\'s', () => {
    assert.equal(parseCommand('licence BONA-015 7200012345 2027-03-01').id, 'BONA-015');
    assert.equal(parseCommand('wafi BONA-015 1234567890').id, 'BONA-015');
    assert.equal(parseCommand('remove BONA-015').cmd, 'error', 'every OTHER command is still intake-only');
  });

  it('reads the Arabic verbs, Arabic-Indic digits and DD/MM/YYYY — and answers in Arabic', () => {
    assert.deepEqual(parseCommand('ترخيص BONA-W003 ٧٢٠٠٠١٢٣٤٥ ٠١/٠٣/٢٠٢٧'), {
      cmd: 'licence', id: 'BONA-W003', adNumber: '7200012345', adExpiry: '2027-03-01', lang: 'ar',
    });
    assert.deepEqual(parseCommand('وافي BONA-W003 ١٢٣٤٥٦٧٨٩٠'), {
      cmd: 'wafi', id: 'BONA-W003', wafiNumber: '1234567890', lang: 'ar',
    });
    assert.equal(parseCommand('licence BONA-W003 7200012345 01/03/2027').adExpiry, '2027-03-01', 'day first, the way a Saudi form prints it');
  });

  it('refuses an expiry that is not a real calendar date', () => {
    // Date.parse() would have ROLLED 2027-02-31 over to the 3rd of March and published an
    // expiry the owner never typed — see rules.mjs::isCalendarDate.
    for (const bad of ['2027-02-31', '2027-13-01', '2027-02-29', 'soon', '2027/03', '31/02/2027']) {
      const c = parseCommand(`licence BONA-W003 7200012345 ${bad}`);
      assert.equal(c.cmd, 'error', bad);
      assert.match(c.message, /is not a real date/, bad);
    }
    assert.equal(parseExpiryDate('2028-02-29'), '2028-02-29', '2028 IS a leap year');
  });

  it('asks for the pieces it is missing rather than half-recording a licence', () => {
    assert.equal(parseCommand('licence').cmd, 'error');
    assert.match(parseCommand('licence').message, /usage: licence BONA-W001/);
    assert.equal(parseCommand('licence BONA-W003').cmd, 'error', 'no number');
    assert.equal(parseCommand('licence BONA-W003 7200012345').cmd, 'error', 'no expiry');
    assert.match(parseCommand('licence BONA-W003 7200012345').message, /the expiry date is part of the licence/);
    assert.equal(parseCommand('licence BONA-W003 12 2027-03-01').cmd, 'error', 'too short to be a licence number');
    assert.equal(parseCommand('wafi').cmd, 'error');
    assert.equal(parseCommand('wafi BONA-W003 ab').cmd, 'error');
    assert.match(parseCommand('wafi').message, /usage: wafi BONA-W001/);
  });

  it('parses `clear` on both, so a wrong number can be taken off again', () => {
    assert.deepEqual(parseCommand('licence BONA-W003 clear'), { cmd: 'licence', id: 'BONA-W003', clear: true, lang: 'en' });
    assert.deepEqual(parseCommand('wafi BONA-W003 clear'), { cmd: 'wafi', id: 'BONA-W003', clear: true, lang: 'en' });
    assert.deepEqual(parseCommand('ترخيص BONA-W003 مسح'), { cmd: 'licence', id: 'BONA-W003', clear: true, lang: 'ar' });
  });

  it('documents every command it accepts', () => {
    for (const verb of ['remove', 'hero', 'price', 'brochure', 'sold', 'hide', 'status', 'licence', 'wafi']) {
      assert.ok(HELP_TEXT.includes(verb), `HELP_TEXT should mention ${verb}`);
    }
  });

  it('tells the owner about #nobrochure, the only caption flag that changes the PDF', () => {
    assert.ok(HELP_TEXT.includes('#nobrochure'));
  });

  it('mentions the video capability', () => {
    assert.match(HELP_TEXT, /video BONA-W001/);
  });
});

// A video only ever attaches to a listing that already exists, so it is addressed by pulling
// an id out of free text — the caption — rather than a fixed verb + argv shape.
describe('findListingId — pulling an id out of a video\'s caption', () => {
  it('finds the id in any of the phrasings an owner might type', () => {
    for (const caption of ['BONA-W001', 'video BONA-W001', 'add this to BONA-W001', 'bona-w001', '/video BONA-W0123']) {
      assert.ok(findListingId(caption), caption);
    }
    assert.equal(findListingId('video BONA-W001'), 'BONA-W001');
    assert.equal(findListingId('bona-w001'), 'BONA-W001', 'case-insensitive, always returned uppercase');
    assert.equal(findListingId('add this to BONA-W0123'), 'BONA-W0123');
  });

  it('finds nothing in ordinary chatter or a curated id', () => {
    for (const caption of ['', 'the master bedroom', 'BONA-001', 'bona w001']) {
      assert.equal(findListingId(caption), null, caption);
    }
  });

  it('takes the first id when a caption somehow carries more than one', () => {
    assert.equal(findListingId('BONA-W001 not BONA-W002'), 'BONA-W001');
  });
});
