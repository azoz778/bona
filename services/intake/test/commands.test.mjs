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
  const hint = (c) => { const p = parsePriceHint(c); return p && `${p.currency} ${p.amount}`; };

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

  // The rule this PR settles on: a caption that is nothing but a price, or no caption price at all.
  it('reads a caption that is nothing but a price, however it is written', () => {
    for (const [caption, want] of [
      ['#rent 120,000 per year', 'SAR 120000'],
      ['#test 4.5m', 'SAR 4500000'],
      ['4500000', 'SAR 4500000'],
      ['السعر ٤٫٥ مليون ريال', 'SAR 4500000'],
      ['السعر ٤٬٥٠٠٬٠٠٠ ريال', 'SAR 4500000'],
      ['السعر ٨٥٠ ألفاً ريال', 'SAR 850000'],
      ['السعر المطلوب هو ٤٥٠٬٠٠٠', 'SAR 450000'],
      ['للبيع بـ 4.5 مليون', 'SAR 4500000'],
      ['إيجار 45,000 ريال سنوياً', 'SAR 45000'],
      ['4.5 millions SAR', 'SAR 4500000'],
      ['4.5mil SAR', 'SAR 4500000'],
      ['4.5 mln', 'SAR 4500000'],
      ['4.5mSAR', 'SAR 4500000'],
      ['Asking 4.5mUSD', 'USD 4500000'],
      ['SAR 150m', 'SAR 150000000'],
      ['SAR 2.05M', 'SAR 2050000'],
      ['SAR 1,500 thousand', 'SAR 1500000'],
      ['Asking OMR 175,000.125', 'OMR 175000.125'],
      ['Price: SAR 12,345.6789', 'SAR 12345.6789'],
      ['AED 1000000000', 'AED 1000000000'],
      ['SAR 4,500,000.', 'SAR 4500000'],
      ['Price:\nAED 450,000', 'AED 450000'],
      ['Price-4,500,000', 'SAR 4500000'],
      ['SAR-4.5m', 'SAR 4500000'],
      ['Sale price is 450,000', 'SAR 450000'],
      ['for sale 4,500,000', 'SAR 4500000'],
      ['4.5m negotiable', 'SAR 4500000'],
      ['Price 4.5m firm', 'SAR 4500000'],
      ['#rent 85k per year', 'SAR 85000'],
      ['Rent AED 2,000 per month', 'AED 2000'],
      ['Asking ４．５m SAR', 'SAR 4500000'],
      ['Asking 12,000\nk SAR', 'SAR 12000000'],
      ['Price 1.2 million dollars', 'USD 1200000'],
    ]) {
      assert.equal(hint(caption), want, caption);
    }
  });

  it('reads currencies written as codes, symbols and words, and refuses others', () => {
    for (const [caption, want] of [
      ['السعر ٤٥٠٬٠٠٠ ريال عماني', 'OMR 450000'],
      ['السعر ٤٥٠٬٠٠٠ ريال عُماني', 'OMR 450000'],
      ['السعر ٤٥٠٬٠٠٠ بالريال العماني', 'OMR 450000'],
      ['Price: 185,000 Omani Riyal', 'OMR 185000'],
      ['Price RO 185k', 'OMR 185000'],
      ['السعر ٤٥٠٬٠٠٠ ريال سعودي', 'SAR 450000'],
      ['SR 4,500,000', 'SAR 4500000'],
      ['Price 4.5m Saudi riyals', 'SAR 4500000'],
      ['Asking €450,000', 'EUR 450000'],
      ['Asking 450 k€', 'EUR 450000'],
      ['Asking $450,000', 'USD 450000'],
      ['السعر 2,400,000 درهم', 'AED 2400000'],
      ['1,200,000 dirhams', 'AED 1200000'],
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
    assert.equal(parseCommand('price BONA-W001 $1.2m').currency, 'USD');
    assert.equal(parseCommand('price BONA-W001 onrequest').onRequest, true);
    assert.equal(parseCommand('price BONA-W001 4,500,000 SAR per sqm').cmd, 'error');
    assert.equal(parseCommand('price BONA-W001 450 m2').cmd, 'error');
  });

  // r13 review (Codex)
  it('round 13: symbols and scripts that are not ours, footnote digits, digit hashtags', () => {
    assert.equal(hint('Price$450,000'), 'USD 450000');
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
    for (const [caption, want] of [['#rent 120,000 per year', 'SAR 120000'], ['Rent AED 5,000 monthly', 'AED 5000'], ['إيجار الشهر 4,500 ريال', 'SAR 4500']]) {
      assert.equal(hint(caption), want, caption);
    }
    assert.equal(parseCaption('4.5m').price.currency, null);
    assert.equal(parseCaption('SAR 4.5m').price.currency, 'SAR');
    assert.equal(parseCaption('إيجار الشهر 4,500 ريال').period, 'month');
  });

  // r14 review (Codex)
  it('round 14: sale and rent together, digit hashtags, spaced m, a riyal with no country', () => {
    for (const caption of ['For sale\nNet rent: AED 45,000 per year', 'AED 50,000 #1stPayment', '#2BR,USD 1.2m', '#2BR 4.5m', '#sale 25 m', 'Villa 4.5 m']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    // a riyal with no country is read as SAR but not passed on: the brochure's currency (e.g. OMR) stands
    assert.deepEqual(parseCaption('السعر ١٩٠٬٠٠٠ ريال').price, { amount: 190000, currency: null });
    assert.deepEqual(parseCaption('السعر ١٩٠٬٠٠٠ ريال سعودي').price, { amount: 190000, currency: 'SAR' });
    assert.deepEqual(parseCaption('السعر ١٩٠٬٠٠٠ ريال عماني').price, { amount: 190000, currency: 'OMR' });
    assert.equal(hint('#sale 25m'), 'SAR 25000000');
  });

  // r14 review (Claude)
  it('round 14 (Claude): the period comes from the price caption itself', () => {
    for (const [caption, period] of [['Rent SAR 4,500 /month', 'month'], ['Rent 4,500 SAR / month', 'month'], ['rent 4,500 SAR month', 'month'],
      ['إيجار 4,500 ريال شهر', 'month'], ['إيجار شهر 4,500 ريال', 'month'], ['إيجار الشهر 4,500 ريال', 'month'], ['Lease AED 2,000 per month', 'month'],
      ['#rent SAR 60,000 yearly', 'year'], ['Rent SAR 60,000', 'year']]) {
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
      assert.deepEqual([c.price, c.category, c.period], [null, 'rent', 'year'], caption);
    }
    // the price command cannot set a period: one written is refused
    assert.equal(parseCommand('price BONA-W001 SAR 4,500 monthly rent').cmd, 'error');
    assert.equal(parseCommand('price BONA-W001 SAR 4,500 rent').amount, 4500);
  });

  it('reads "/ month" after a space, and lease as rent', () => {
    assert.equal(parseCaption('Rent AED 5,000 / month').period, 'month');
    const lease = parseCaption('Lease AED 5,000 monthly');
    assert.equal(lease.category, 'rent');
    assert.equal(lease.period, 'month');
  });

  it('reads monthly and yearly as the rent period', () => {
    assert.equal(parseCaption('Rent AED 5,000 monthly').period, 'month');
    assert.equal(parseCaption('#rent 120,000 yearly').period, 'year');
    assert.equal(parseCaption('For rent: AED 45,000 annually\nParking AED 1,200 monthly').period, 'year');
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
