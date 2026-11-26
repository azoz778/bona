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

  it('maps rent hints in both languages; a caption with no period leaves it to the brochure', () => {
    assert.equal(parseCaption('for rent').category, 'rent');
    assert.equal(parseCaption('للإيجار').category, 'rent');
    // null: buildListing takes the brochure's period, and a year only when it has none (listing.test.mjs)
    assert.equal(parseCaption('for rent').period, null);
    assert.equal(parseCaption('for rent SAR 250000 per month').period, 'month');
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
  const hint = (c) => { const p = parsePriceHint(c); return p && `${p.currency} ${p.amount}`; };

  const cases = [
    ['SAR 4,500,000', 4500000, 'SAR'],
    ['4.5m SAR', 4500000, 'SAR'],
    ['price SAR 750000', 750000, 'SAR'],
    ['AED 2,000,000', 2000000, 'AED'],
    ['٤٥٠٠٠٠٠ ريال سعودي', 4500000, 'SAR'],
    ['990,000 ر.س', 990000, 'SAR'],
    ['1.2 million SAR', 1200000, 'SAR'],
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

  // The rule this PR settles on: a caption that is nothing but a price, or no caption price at all.
  it('reads a caption that is nothing but a price, however it is written', () => {
    for (const [caption, want] of [
      ['#rent SAR 120,000 per year', 'SAR 120000'],
      ['#test SAR 4.5m', 'SAR 4500000'],
      ['4500000 SAR', 'SAR 4500000'],
      ['السعر ٤٫٥ مليون ريال سعودي', 'SAR 4500000'],
      ['السعر ٤٬٥٠٠٬٠٠٠ ريال سعودي', 'SAR 4500000'],
      ['السعر ٨٥٠ ألفاً ريال سعودي', 'SAR 850000'],
      ['السعر المطلوب هو ٤٥٠٬٠٠٠ ريال سعودي', 'SAR 450000'],
      ['للبيع بـ 4.5 مليون ر.س', 'SAR 4500000'],
      ['إيجار 45,000 ريال سعودي سنوياً', 'SAR 45000'],
      ['4.5 millions SAR', 'SAR 4500000'],
      ['4.5mln SAR', 'SAR 4500000'],
      ['4.5 mln SAR', 'SAR 4500000'],
      ['4.5mSAR', 'SAR 4500000'],
      ['Asking 4.5mUSD', 'USD 4500000'],
      ['SAR 150m', 'SAR 150000000'],
      ['SAR 2.05M', 'SAR 2050000'],
      ['SAR 1500 thousand', 'SAR 1500000'],
      ['Asking OMR 1,175,000.125', 'OMR 1175000.125'],
      ['Price: SAR 12,345.6789', 'SAR 12345.6789'],
      ['AED 1000000000', 'AED 1000000000'],
      ['SAR 4,500,000.', 'SAR 4500000'],
      ['Price:\nAED 450,000', 'AED 450000'],
      ['Sale price SAR 450,000', 'SAR 450000'],
      ['for sale SAR 4,500,000', 'SAR 4500000'],
      ['SAR 4.5m negotiable', 'SAR 4500000'],
      ['Price SAR 4.5m firm', 'SAR 4500000'],
      ['#rent SAR 85k per year', 'SAR 85000'],
      ['Rent AED 2,000 per month', 'AED 2000'],
      ['Asking ４．５m SAR', 'SAR 4500000'],
      ['Price 1.2 million US dollars', 'USD 1200000'],
    ]) {
      assert.equal(hint(caption), want, caption);
    }
  });

  it('reads currencies written as codes, symbols and words, and refuses others', () => {
    for (const [caption, want] of [
      ['السعر ٤٥٠٬٠٠٠ ريال عماني', 'OMR 450000'],
      ['السعر ٤٥٠٬٠٠٠ ريال عماني', 'OMR 450000'],
      ['السعر ٤٥٠٬٠٠٠ بالريال العماني', 'OMR 450000'],
      ['Price: 1,185,000 Omani Riyal', 'OMR 1185000'],
      ['Price RO 185k', 'OMR 185000'],
      ['السعر ٤٥٠٬٠٠٠ ريال سعودي', 'SAR 450000'],
      ['SR 4,500,000', 'SAR 4500000'],
      ['Price 4.5m Saudi riyals', 'SAR 4500000'],
      ['Asking €1,450,000', 'EUR 1450000'],
      ['Asking 450 k€', 'EUR 450000'],
      ['Asking US$450,000', 'USD 450000'],
      ['السعر 2,400,000 درهم إماراتي', 'AED 2400000'],
      ['1,200,000 UAE dirhams', 'AED 1200000'],
    ]) {
      assert.equal(hint(caption), want, caption);
    }
    for (const caption of [
      'Asking QAR 450,000', 'Doha QR 2m', 'السعر ٤٥٠٬٠٠٠ ريال قطري', 'Asking 450,000 Qatari riyals', 'Price 2m Riyal Qatari',
      'Asking £450,000', 'Price 850,000 pounds', 'Price TL 8.5m', 'السعر 450,000 دينار', 'Price 150,000 dinars', 'KD 1.2m',
      'Price: 450,000 Canadian dollars', 'Price: 450,000 CAD', 'السعر ٤٥٠ ألف درهم مغربي', 'SAR 4.5m, AED', 'Price 4.5m AED SAR',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('reads no price when the caption holds anything but the price', () => {
    for (const caption of [
      // a second figure
      'was 3,000,000 now SAR 4,500,000', 'Villa 450 m2 SAR 4,500,000', 'SAR 4,500,000 4 bedrooms', 'Price SAR 4,500,000\n4 bedrooms',
      'SAR 4,500,000 call 0555226302', '2.5m - 3m', 'Price 4,500,000 (USD 1,200,000)', 'Apartment 4.5M x 2 payments', 'SAR 4 500 000',
      'SAR 4,500, 000', 'السعر مليون و200 ألف', 'السعر 3 مليون ونص', 'السعر ٤ مليون ريال إلا ربع',
      // a unit
      'Villa 450 m2', 'Villa 450m2', 'Villa 450 m²', 'Villa 450 m^2', 'Villa 450 m 2', 'Land 12,000 sqm', 'Land 12,000 sq ft', 'Land 12,000\nsqm',
      'أرض 12000 م2', 'أرض ١٢٠٠٠ م²', 'أرض 12000 متر مربع', 'أرض 12000 م', 'أرض 12000 مـ2', 'أرض 12000 \u200Fم2', 'Land 12,000 hectares',
      'Land 1.2m sqm', '4.5m2', '15 km from the corniche', 'SAR 3,500/m2', '3,500 SAR per sqm', '3,500 SAR — per sqm', 'SAR 3,500/mtr',
      '3500 ريال للمتر', '3500 ريال / م2', 'Rent AED 12,000 / m', 'AED 2,100 psf', '400,000 Saudi riyals per square foot',
      // a label or any other word
      'Area: 12,000', 'المساحة: ١٢٠٠٠', 'سعر المتر: ٣٥٠٠ ريال', 'Price per sqm SAR 3,500', 'Deposit 50,000', '#Deposit 50,000', '#area 12,000',
      'العربون 100 ألف', 'Service charge SAR 12,000', 'Annual service fee: SAR 50,000', 'Booking fee AED 20,000', 'Deposit amount SAR 50,000',
      'Monthly installment 15,000 SAR', 'أقساط شهرية تبدأ من 3,500 ريال', 'دفعة مقدمة 50,000 ريال', 'AED 50,000 refundable deposit',
      'AED 50,000 off the asking price', 'Was SAR 5m', 'السعر كان ٤٫٥ مليون ريال', 'Previous sale price: AED 450,000',
      'Offer rejected: SAR 450,000', 'Price on request in AED. WhatsApp me at 500000000', 'السعر عند التواصل، التقييم ٤٫٥ مليون ريال',
      'Height 3m', 'Frontage 25m', 'street 20m', 'Villa on 30m street', 'Distance to beach 50m', 'يبعد عن البحر 50m', 'Only 50k down',
      'Villa for sale in Obhur 4.5m', 'Dubai villa $1.2m', 'Unit A-12 SAR 3.2m', 'السعر بدون عمولة 4,500,000 ريال',
      'Price list 2026 (AED)', 'Off-plan, delivery 2027, prices in SAR', 'Al Rawdah, Jeddah 23434', 'الرمز البريدي ٢٣٤٣٤، الأسعار بالريال',
      'Villa with 12,000 visitors', 'Villa with a million-dollar view, asking 4.5m',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('never reads a phone or id number, a year, a malformed figure or a sign', () => {
    for (const caption of [
      'call 0555226302', '0555226302', '+966 55 522 6302', '7200012345', '555226302', 'ترخيص 7200012345', '2027', 'AED 2000',
      'SAR 4,5000', 'SAR 4500,000', 'SAR 4.500.000', 'SAR 4,500.000', 'Price: .5 million SAR', 'Offer AED −450,000', 'Offer AED -450,000',
      'Price SAR 450,000 (old); now ５０００００', '10 mins', '15 km', 'Villa 450 m', 'Land 12,000 m', 'SAR 1' + '0'.repeat(303) + 'm',
    ]) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
  });

  it('reads the price command\'s amount the same way', () => {
    assert.equal(parseCommand('price BONA-W001 4500000').amount, 4500000);
    assert.equal(parseCommand('price BONA-W001 4.5m').amount, 4500000);
    assert.equal(parseCommand('price BONA-W001 4.5 million').amount, 4500000);
    assert.equal(parseCommand('price BONA-W001 SAR 4,500,000').amount, 4500000);
    assert.equal(parseCommand('price BONA-W001 US$1.2m').currency, 'USD');
    assert.equal(parseCommand('price BONA-W001 onrequest').onRequest, true);
    assert.equal(parseCommand('price BONA-W001 4,500,000 SAR per sqm').cmd, 'error');
    assert.equal(parseCommand('price BONA-W001 450 m2').cmd, 'error');
  });

  // r13 review (Codex)
  it('round 13: symbols and scripts that are not ours, footnote digits, digit hashtags', () => {
    assert.equal(hint('Price US$450,000'), 'USD 450000');
    for (const caption of ['450,000 SAR€', '#international ฿4,500,000', '#international 4,500,000 บาท', '📏 30 m', 'SAR 450000¹', '#250000', 'Villa 450 m²']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a hashtag holding a digit may label or be the figure: no caption price (r14)
    assert.equal(parsePriceHint('#2BR 4.5m'), null);
  });

  // r13 review (Claude)
  it('round 13 (Claude): a period without a rent word, other dollars, signs, huge multiples', () => {
    for (const caption of ['3,500 ريال شهرياً فقط', 'Net SAR 450,000 per year', 'A$ 1.2m', 'HK$ 1.2m', '-SAR 50,000', '4,500 مليون', 'Price 15,000m SAR']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const [caption, want] of [['#rent SAR 120,000 per year', 'SAR 120000'], ['Rent AED 5,000 monthly', 'AED 5000'], ['إيجار 4,500 ريال سعودي في الشهر', 'SAR 4500']]) {
      assert.equal(hint(caption), want, caption);
    }
    assert.equal(parseCaption('4.5m').price, null); // r25: a caption price writes its currency
    assert.equal(parseCaption('SAR 4.5m').price.currency, 'SAR');
    assert.equal(parseCaption('إيجار 4,500 ريال سعودي في الشهر').period, 'month');
  });

  // r14 review (Codex)
  it('round 14: sale and rent together, digit hashtags, spaced m, a riyal with no country', () => {
    for (const caption of ['For sale\nNet rent: AED 45,000 per year', 'AED 50,000 #1stPayment', '#2BR,USD 1.2m', '#2BR 4.5m', '#sale 25 m', 'Villa 4.5 m']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a riyal with no country may be Saudi or Omani: no caption price (r16); with its country it is read
    assert.equal(parseCaption('السعر ١٩٠٬٠٠٠ ريال').price, null);
    assert.deepEqual(parseCaption('السعر ١٩٠٬٠٠٠ ريال سعودي').price, { amount: 190000, currency: 'SAR' });
    assert.deepEqual(parseCaption('السعر ١٩٠٬٠٠٠ ريال عماني').price, { amount: 190000, currency: 'OMR' });
    assert.equal(hint('#sale SAR 25m'), 'SAR 25000000');
  });

  // r30 review (Codex)
  it('round 30: a flag keeps its place, so no period is read across it', () => {
    for (const caption of ['Rent: *AED 5,000* *yearly #rental only*', 'Rent: AED 60,000 *monthly #rental only*', 'Rent SAR 4,500 #rent per month', 'Rent SAR 4,500 per month #rent']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parsePriceHint('#rent SAR 4,500 per month')?.period, 'month');
    assert.deepEqual(parseCaption('SAR 4.5m #sale').price, { amount: 4500000, currency: 'SAR' });
    assert.deepEqual(parseCaption('#test SAR 4.5m').price, { amount: 4500000, currency: 'SAR' });
    // a private-use character could pass for the flag mark
    assert.equal(parsePriceHint('Rent SAR 4,500 \uE000 per month'), null);
  });

  // r29 review (Codex)
  it('round 29: after the period only a closing qualifier may follow', () => {
    for (const caption of ['Rent: *AED 5,000* *yearly rental only*', 'Rent AED 5,000 monthly rent', 'للإيجار ٤٬٥٠٠ ريال سعودي شهرياً للإيجار', 'Rent SAR 4,500 per month for sale']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const [caption, period] of [['Rent SAR 4,500 per month only', 'month'], ['للإيجار ٤٥ ألف ريال سعودي سنوياً قابل للتفاوض', 'year'], ['Rent *AED 5,000* *monthly*', 'month'], ['Rent AED 60k/yr, negotiable', 'year']]) {
      assert.equal(parsePriceHint(caption)?.period, period, caption);
    }
  });

  // r28 review (Codex, Claude)
  it('round 28: a bare period noun is no billing period; every line separator ends the line', () => {
    // "سنة فقط" on the figure's line may be a one-year lease; a noun reads only after per / a / في / "/"
    for (const caption of ['للإيجار ٤٬٥٠٠ ريال سعودي *سنة فقط*', 'للإيجار ٤٬٥٠٠ ريال سعودي سنة', 'rent 4,500 SAR month', 'Rent SAR 45,000 year', 'إيجار 4,500 ريال سعودي شهر']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const [caption, period] of [['Rent SAR 4,500 per month', 'month'], ['Rent SAR 45,000 a year', 'year'], ['للإيجار ٤٥ ألف ريال سعودي في السنة', 'year'],
      ['للإيجار ٤٬٥٠٠ ريال سعودي / شهر', 'month'], ['للإيجار ٤٥ ألف ريال سعودي سنوياً', 'year'], ['Rent AED 60k/yr', 'year'], ['rent SAR 45,000 per annum', 'year'], ['Rent AED 5,000 monthly', 'month']]) {
      assert.equal(parsePriceHint(caption)?.period, period, caption);
    }
  });

  // r27 review (Codex)
  it('round 27: the period stands on the figure\'s line, past no full stop, comma or colon', () => {
    for (const caption of ['للإيجار ٤٥٬٠٠٠ ريال سعودي.\n*شهر فقط*', 'Rent AED 60,000.\n*Monthly only*', 'Rent SAR 4,500\nper month', 'Rent SAR 4,500, per month',
      'Rent SAR 4,500: monthly', 'Asking 12000\nk SAR', 'للإيجار ٤٬٥٠٠ ريال سعودي\n*سنة فقط*', 'للإيجار ٤٬٥٠٠ ريال سعودي\nسنة فقط']) {
      assert.equal(parsePriceHint(caption), null, JSON.stringify(caption));
    }
    // every line separator is a line break
    for (const sep of ['\r', '\u2028', '\u2029', '\u0085', '\v', '\f']) {
      assert.equal(parsePriceHint('للإيجار ٤٬٥٠٠ ريال سعودي' + sep + 'سنة فقط'), null, JSON.stringify(sep));
    }
    // a line break elsewhere is white space
    assert.deepEqual([parsePriceHint('#rent\nSAR 4,500 per month')?.amount, parsePriceHint('#rent\nSAR 4,500 per month')?.period], [4500, 'month']);
    assert.equal(hint('Price:\nSAR 4.5m'), 'SAR 4500000');
    assert.equal(parsePriceHint('Rent *SAR 4,500* per month')?.period, 'month');
  });

  // r26 review (Codex)
  it('round 26: no bracket before the period, bold marks, a glued "US $", and the period reader is linear', () => {
    assert.equal(parsePriceHint('للإيجار ٤٬٥٠٠ ريال سعودي\n(سنة فقط)'), null);
    assert.equal(parsePriceHint('Rent SAR 4,500 (per month)'), null);
    const bold = parsePriceHint('Rent *AED 5,000* per month');
    assert.deepEqual([bold?.amount, bold?.currency, bold?.period], [5000, 'AED', 'month']);
    assert.equal(parsePriceHint('RentUS $45,000'), null);
    assert.equal(parseCommand('price BONA-W001 RentUS $45,000').cmd, 'error');
    assert.equal(hint('US $45,000'), 'USD 45000');
    // the period reader ran in exponential time on repeated currency marks (2.7 s for 30 "€")
    for (const s of ['Rent 4,500 ' + '€'.repeat(3000), 'Rent 4,500 ' + 'US $'.repeat(3000), 'Rent 4,500 ' + 'ريال سعودي '.repeat(3000), 'Rent 4,500 ' + '/ '.repeat(3000) + 'month']) {
      const t0 = Date.now();
      parsePriceHint(s);
      assert.ok(Date.now() - t0 < 500, `${JSON.stringify(s.slice(0, 16))}… took ${Date.now() - t0} ms`);
    }
  });

  // r25 review (Codex, Claude)
  it('round 25: a caption price writes its currency, its period follows the figure, digit hashtags before flags', () => {
    // no currency written: the brochure reading's may be a fallback (a London brochure read as SAR)
    for (const caption of ['4.5m', '#international ١٫٢٥ مليون', '450000', 'Price 4.5m firm', '#rent 85k per year']) assert.equal(parsePriceHint(caption), null, caption);
    assert.equal(parseCommand('price BONA-W001 4.5m').amount, 4500000); // the command keeps the listing's currency
    // the period stands right after the figure and its currency; before it, or a second one, it is the lease's
    for (const caption of ['للإيجار سنة فقط\nالمطلوب ٤٬٥٠٠ ريال سعودي', 'إيجار شهر 4,500 ريال سعودي', 'Rent €4,500 for a year', 'Rent SAR 4,500 per month for a year', 'Rent per year SAR 45,000']) {
      assert.equal(parsePriceHint(caption), null, JSON.stringify(caption));
    }
    for (const [caption, period] of [['Rent SAR 4,500 per month', 'month'], ['Rent 4,500 SAR / month', 'month'], ['#rent AED 60k/yr', 'year'], ['للإيجار ٤٥ ألف ريال سعودي سنوياً', 'year'], ['Rent SAR 45,000 a year', 'year'], ['rent SAR 4,500 per annum', 'year']]) {
      assert.equal(parsePriceHint(caption)?.period, period, caption);
    }
    // a hashtag holding a digit is no price, the digits after a flag included
    for (const caption of ['#sale١٢٣٤٥', '#sale12345', '#rent٤٥٠٠٠ SAR per year']) assert.equal(parsePriceHint(caption), null, caption);
    // (Claude) a word glued to a flag is read for rent and sale: no price where the readers disagree
    for (const caption of ['#hiddenｒｅｎｔ SAR 45,000 per year', '#hiddenｓａｌｅ SAR 4.5m', '#hidden\u200Esale Rent AED 60,000 per year']) {
      assert.equal(parseCaption(caption).price, null, JSON.stringify(caption));
    }
  });

  // r24 review (Codex)
  it('round 24: "total" and "cash" are no words; flags come out of the raw caption only', () => {
    for (const caption of ['Rent: AED 60,000 total (cash monthly)', 'Price SAR 4.5m cash', 'Total SAR 4.5m', 'السعر ٤٫٥ مليون ريال سعودي كاش']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a tag that only the cleaning makes a flag is a word: no price (parseCaption sees no category there)
    for (const caption of ['#inter\u200Enational €450k', '#ｉｎｔｅｒｎａｔｉｏｎａｌ €450k', '#ｔｅｓｔ SAR 4.5m', '#\u200Ftest SAR 4.5m', '#tـest SAR 4.5m']) {
      assert.equal(parsePriceHint(caption), null, JSON.stringify(caption));
    }
    // a fullwidth rent tag is the word "rent" to the price reader and no category to parseCaption: no caption price
    assert.equal(parseCaption('#ｒｅｎｔ AED 45k per year').price, null);
    // a flag the caption reader reads is no word, a direction mark after it included
    assert.equal(hint('#international €450k'), 'EUR 450000');
    assert.equal(hint('#rent\u200E AED 45k per year'), 'AED 45000');
    assert.equal(parseCaption('#rent\u200E AED 45k per year').category, 'rent');
  });

  // r23 review (Codex)
  it('round 23: "بيع" alone (sale or sold) is no word; parseCaption reads as main does', () => {
    for (const caption of ['#international بيع بسعر €450k', 'بيع بسعر ٤٥٠ ألف ريال سعودي', 'بيع SAR 450,000']) assert.equal(parsePriceHint(caption), null, caption);
    assert.deepEqual(parseCaption('للبيع SAR 450,000').price, { amount: 450000, currency: 'SAR' });
    assert.equal(parseCaption('#international for sale SAR 4.5m').category, 'international');
    // no fold in parseCaption: a fullwidth period word or dash changes nothing there (main's reading)
    assert.equal(parseCaption('Rent not per ｍｏｎｔｈ').period, null);
    assert.equal(parseCaption('#test－ AED 450k').dryRun, true); // the tag stops at the fullwidth dash, as on main
    assert.equal(parseCaption('#test－ AED 450k').price, null);
  });

  // r22 review (Codex, Claude)
  it('round 22: a bare figure of one comma group, the em dash, a fullwidth flag', () => {
    // a caption cannot know the listing's currency, so a bare "175,125" may be OMR 175.125: no caption price
    for (const caption of ['Rent 175,125 per month', '450,000', 'Price: 450,000', 'Rent AED (— 4,500) per month']) assert.equal(parsePriceHint(caption), null, caption);
    for (const [caption, want] of [['SAR 450k', 'SAR 450000'], ['450000 SAR', 'SAR 450000'], ['SAR 450,000', 'SAR 450000'], ['SAR 4,500,000', 'SAR 4500000']]) assert.equal(hint(caption), want, caption);
    // the price command names its listing: a bare "450,000" passes, and setPrice decides (listing.test.mjs)
    assert.equal(parseCommand('price BONA-W001 450,000').oneGroup, true);
    assert.equal('oneGroup' in parseCommand('price BONA-W001 SAR 450,000'), false);
    // a fullwidth "＃" is a flag parseCaption does not read (main reads none either): no caption price beside it (r23)
    assert.equal(parsePriceHint('＃test AED 450k'), null);
    assert.equal(parseCaption('＃test AED 450k').price, null);
  });

  // r21 review (Codex)
  it('round 21: a minus sign anywhere, one comma group in euros or Omani rials', () => {
    for (const caption of ['Rent AED: (- 4,500) per month', 'AED-450,000', 'Price-4,500,000', 'SAR-4.5m', 'SAR – 4.5m', 'for-sale SAR 4.5m',
      'Rent RO175,125 per month', 'Asking €450,000', 'OMR 185,000', '€4,500']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parseCommand('price BONA-W001 AED-450,000').cmd, 'error');
    // no dash of any kind (r22); two comma groups, or SAR / AED / USD, are thousands
    assert.equal(parsePriceHint('Price — SAR 4.5m'), null);
    // (Claude r21) three decimals before a thousand may be dot grouping
    for (const caption of ['€15.500k', 'SAR 15.500 thousand', 'للبيع 15.500 ألف ريال سعودي']) assert.equal(parsePriceHint(caption), null, caption);
    assert.equal(parseCommand('price BONA-W001 €15.500k').cmd, 'error');
    assert.equal(hint('SAR 15.5k'), 'SAR 15500');
    assert.equal(hint('€1,450,000'), 'EUR 1450000');
    assert.equal(hint('OMR 1,185,000'), 'OMR 1185000');
    assert.equal(hint('€450k'), 'EUR 450000');
    assert.equal(hint('AED 450,000'), 'AED 450000');
  });

  // r20 review (Codex, Claude)
  it('round 20: a grouped figure with a multiplier, a sign before any currency, a fraction and the period', () => {
    for (const caption of ['€15,500k', '1,200k', 'SAR 1,500 mln', '-US dollars 450,000', '-ر.س 450,000', '- SAR 50,000', 'SAR -450,000']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(parseCommand('price BONA-W001 €15,500k').cmd, 'error');
    assert.equal(hint('€850k'), 'EUR 850000');
    assert.equal(hint('Price - SAR 450,000'), null);
    assert.equal(parseCaption('Rent AED ½m per month').period, null);
  });

  // r19 review (Codex)
  it('round 19: "mil" is no multiplier, any digit counts for the period rule, a sign before "US $"', () => {
    for (const caption of ['€450 mil', 'SAR 4.5 mil', '-US $450,000', '- US $450,000']) assert.equal(parsePriceHint(caption), null, caption);
    assert.equal(parseCommand('price BONA-W001 €450 mil').cmd, 'error');
    assert.equal(hint('SAR 4.5 mln'), 'SAR 4500000');
    const c = parseCaption('Rent $３，０００ per month');
    assert.deepEqual([c.price, c.period], [null, null]);
    assert.deepEqual([parseCaption('إيجار $٣٬٠٠٠ شهريا').price, parseCaption('إيجار $٣٬٠٠٠ شهريا').period], [null, null]);
  });

  // r18 review (Claude)
  it('round 18 (Claude): a figure that is no caption price sets no period; US $ and أميركي', () => {
    for (const caption of ['Rent $3,000 per month', 'للإيجار بسعر 4 الاف شهريا', 'Rent SAR 4,500 per month?']) {
      const c = parseCaption(caption);
      assert.deepEqual([c.price, c.category, c.period], [null, 'rent', null], caption);
    }
    // with no figure at all, main's period hints still speak
    assert.equal(parseCaption('#rent per month').period, 'month');
    assert.equal(hint('US $1.2m'), 'USD 1200000');
    assert.equal(hint('السعر 1,200,000 دولار أميركي'), 'USD 1200000');
    assert.equal(hint('السعر 1,200,000 دولار امريكي'), 'USD 1200000');
    assert.equal(hint('١٫٢ مليون دولارا أميركيا'), 'USD 1200000');
    assert.equal(parsePriceHint('BUS $1.2m'), null);
  });

  // r18 review (Codex)
  it('round 18: "is" and "lease" are no words, a group never starts with 0', () => {
    for (const caption of ['Is rent €4,500 a month', 'Price is SAR 4.5m', 'Rent €4,500 (yearly lease)', 'For sale €0,850m', 'SAR 0,850,000', '0,850 SAR']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(hint('For sale €850k'), 'EUR 850000');
    assert.equal(hint('For sale €0.85m'), 'EUR 850000');
    assert.equal(hint('SAR 850,000'), 'SAR 850000');
  });

  // r17 review (Claude)
  it('round 17 (Claude): a spaced "m" on 100 or more, the period hints are main\'s', () => {
    assert.equal(parsePriceHint('Price SAR 950 m'), null);
    assert.equal(hint('SAR 4.5 m'), 'SAR 4500000');
    assert.equal(hint('SAR 950m'), 'SAR 950000000');
    // no caption price: main's period hints ("/ month" needs no space before it), so this stays the
    // brochure's period, not a month
    assert.equal(parseCaption('Rent: annual lease / month-to-month option available').period, null);
    // a caption price reads its own period whatever the spacing
    assert.equal(parseCaption('Rent AED 5,000 / month').period, 'month');
  });

  // r17 review (Codex)
  it('round 17: a dollar with no country, a question', () => {
    // "$" and "dollars" alone may be US, Canadian, Australian …: no caption price (as a bare riyal or dirham)
    for (const caption of ['#international For sale $850,000', '$1.2m', 'Asking $450,000', 'Price$450,000', '1.2m dollars', 'السعر 1,200,000 دولار']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    for (const [caption, want] of [['US$ 850,000', 'USD 850000'], ['USD 1.2m', 'USD 1200000'], ['1.2m US dollars', 'USD 1200000'], ['السعر 1,200,000 دولار أمريكي', 'USD 1200000']]) {
      assert.equal(hint(caption), want, caption);
    }
    assert.equal(parseCommand('price BONA-W001 $1.2m').cmd, 'error');
    // a question states no price
    for (const caption of ['Is rent €4,500 a month?', 'SAR 4.5m?', 'السعر ٤٫٥ مليون ريال سعودي؟']) assert.equal(parsePriceHint(caption), null, caption);
  });

  // r16 review (Claude)
  it('round 16 (Claude): a rent caption must say its period; rent and sale words on the cleaned text', () => {
    for (const caption of ['Rent SAR 45,000', 'Rent SAR 60,000', 'للإيجار 45,000 ريال سعودي', '#rent 60,000', 'بيع للإِيجار EUR 450k']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a tatweel in the rent word: the price reader sees a rent, the category reader does not, so no price
    assert.equal(parseCaption('للإيـجار 45,000 ريال سعودي سنوياً').price, null);
    assert.deepEqual(parseCaption('للإيجار 45,000 ريال سعودي سنوياً').price, { amount: 45000, currency: 'SAR' });
    // the price command keeps the listing's category and period: a bare figure only
    for (const command of ['price BONA-W001 rent 45,000', 'price BONA-W001 4.5m for sale', 'price BONA-W001 للبيع 4.5m']) {
      assert.equal(parseCommand(command).cmd, 'error', command);
    }
    assert.equal(parseCommand('price BONA-W001 45,000').amount, 45000);
  });

  // r16 review (Codex)
  it('round 16: a riyal or dirham with no country, letters on a "$", "a", vowel marks, a sale word with no category', () => {
    // a riyal or dirham with no country may be Saudi or Omani, Emirati or Moroccan: no caption price
    for (const caption of ['السعر ١٩٠٬٠٠٠ ريال', '4.5m riyals', 'السعر ١٬٢٠٠٬٠٠٠ درهم', 'Dhs 1.2m', '1.2m DH', '#international السعر ١٬٢٠٠٬٠٠٠ درهم']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(hint('السعر ١٩٠٬٠٠٠ ريال سعودي'), 'SAR 190000');
    assert.equal(hint('السعر ١٩٠٬٠٠٠ ريال عماني'), 'OMR 190000');
    assert.equal(hint('السعر ١٬٢٠٠٬٠٠٠ درهم إماراتي'), 'AED 1200000');
    assert.equal(hint('AED 1.2m'), 'AED 1200000');
    // "$A", "/a": "a" is no word on its own ("a month", "a year" are)
    for (const caption of ['For sale $A1.2m', 'Rent €45,000/a', 'Rent SAR 4,500 a']) assert.equal(parsePriceHint(caption), null, caption);
    assert.equal(parseCaption('rent SAR 1,200 a month').period, 'month');
    assert.equal(parseCaption('Rent SAR 45,000 a year').period, 'year');
    assert.equal(parseCommand('price BONA-W001 EUR 45,000/a rent').cmd, 'error');
    // a vowel mark can make one word another ("بِيعَ", was sold): only the tanween of "شهرياً" goes
    assert.equal(parsePriceHint('بِيعَ بسعر ٤٥٠٬٠٠٠ ريال سعودي'), null);
    assert.equal(parseCaption('إيجار 4,500 ريال سعودي شهرياً').period, 'month');
    // a sale word the category reader does not see ("بيع") sets no caption price
    assert.equal(parseCaption('بيع SAR 450,000').price, null);
    assert.deepEqual(parseCaption('للبيع SAR 450,000').price, { amount: 450000, currency: 'SAR' });
    // "/mo", "/yr"
    assert.deepEqual([parseCaption('Rent AED 5,000/mo').price?.amount, parseCaption('Rent AED 5,000/mo').period], [5000, 'month']);
    assert.equal(parseCaption('Rent AED 60,000/yr').period, 'year');
  });

  // r15 review (Codex)
  it('round 15: other dollars, a rent only one reader sees, qualifiers, a riyal, the command floor', () => {
    for (const caption of ['Price: AUS$ 450,000', 'CAD$ 450,000', 'is$450,000', '~SAR 4.5m~', 'SAR 4.5m+', '≈ SAR 4.5m', '#سِعر450000', '#سعر450000']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(hint('Price US$450,000'), 'USD 450000');
    assert.equal(hint('US$ 450,000'), 'USD 450000');
    const c = parseCaption('#rent_monthly AED 5,000');
    assert.deepEqual([c.price, c.period], [null, null]);
    // the price command names its listing, so a rent's figure under 10,000 is accepted there
    assert.deepEqual(parseCommand('price BONA-W001 5,000 AED'), { cmd: 'price', id: 'BONA-W001', amount: 5000, currency: 'AED', onRequest: false });
    assert.equal(parseCommand('price BONA-W001 190,000 ريال').cmd, 'error');
    assert.deepEqual(parseCommand('price BONA-W001 190,000'), { cmd: 'price', id: 'BONA-W001', amount: 190000, currency: null, oneGroup: true, onRequest: false });
  });

  // r14 review (Claude)
  it('round 14 (Claude): the period comes from the price caption itself', () => {
    for (const [caption, period] of [['Rent SAR 4,500 /month', 'month'], ['Rent 4,500 SAR / month', 'month'], ['rent 4,500 SAR monthly', 'month'],
      ['إيجار 4,500 ريال سعودي في الشهر', 'month'], ['إيجار 4,500 ريال سعودي شهرياً', 'month'], ['إيجار 4,500 ريال سعودي / شهر', 'month'],
      ['#rent SAR 60,000 yearly', 'year']]) {
      const c = parseCaption(caption);
      assert.ok(c.price, caption);
      assert.deepEqual([c.category, c.period], ['rent', period], caption);
    }
    for (const caption of ['Rent SAR 4,500 a month for a year', 'SAR 9,000,000 k', 'السعر 1500 ريال', 'SAR 1,500']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // no caption price: the period hints are main's, so a sentence about months stays the yearly default
    for (const caption of ['#rent Monthly payments possible', '#rent Available in a month', 'للإيجار جاهز الشهر القادم']) {
      const c = parseCaption(caption);
      assert.deepEqual([c.price, c.category, c.period], [null, 'rent', null], caption);
    }
    // the price command cannot set a period: one written is refused
    assert.equal(parseCommand('price BONA-W001 SAR 4,500 monthly rent').cmd, 'error');
    // nor a category (r16): a rent or sale word is refused too
    assert.equal(parseCommand('price BONA-W001 SAR 4,500 rent').cmd, 'error');
  });

  it('reads "/ month" after a space; a lease is no caption price and no category', () => {
    assert.equal(parseCaption('Rent AED 5,000 / month').period, 'month');
    // r15 (Claude): "lease" in a sale caption ("125-year lease") must not make it a rent, so it is no
    // category word; the price reader sees a rent the category reader does not, so no caption price
    for (const caption of ['Lease AED 5,000 monthly', 'Lease AED 2,000 per month', 'Rent45,000']) {
      const c = parseCaption(caption);
      assert.deepEqual([c.price, c.category], [null, null], caption);
    }
    for (const caption of ['London flat for sale, 125-year lease', 'Villa for sale, tenant lease until 2027']) {
      assert.equal(parseCaption(caption).category, 'buy', caption);
    }
    assert.equal(parseCaption('#international apartment, 99 year lease').category, 'international');
    // no caption price: a rent caption's period is still main's yearly default
    assert.equal(parseCaption('#rent villa').period, null);
  });

  it('reads monthly and yearly as the rent period', () => {
    assert.equal(parseCaption('Rent AED 5,000 monthly').period, 'month');
    assert.equal(parseCaption('#rent SAR 120,000 yearly').period, 'year');
    // two figures: no caption price, and no period main's hints read, so the brochure's stands (not a month)
    assert.equal(parseCaption('For rent: AED 45,000 annually\nParking AED 1,200 monthly').period, null);
  });

  it('runs in linear time on long captions', () => {
    const t0 = performance.now();
    for (const s of ['1 '.repeat(20000), ' '.repeat(100000) + '4.5m', 'Price AED 450,000' + '\r\n'.repeat(5000) + 'x', 'ً'.repeat(60000) + ' 4.5m',
      ('Area: ').repeat(5000) + '4.5m', '$'.repeat(5000) + ' Price: 450,000', '450,000 ' + 'SAR '.repeat(5000), 'SAR'.repeat(3000) + ' 4.5m',
      'price '.repeat(10000) + '4.5m']) parsePriceHint(s);
    assert.ok(performance.now() - t0 < 1000);
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
    // no currency written: none passed, so the listing keeps its own (an AED listing stays in AED)
    assert.deepEqual(parseCommand('price BONA-W003 4500000'), { cmd: 'price', id: 'BONA-W003', amount: 4500000, currency: null, onRequest: false });
    assert.deepEqual(parseCommand('price BONA-W003 SAR 4,500,000'), { cmd: 'price', id: 'BONA-W003', amount: 4500000, currency: 'SAR', onRequest: false });
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
