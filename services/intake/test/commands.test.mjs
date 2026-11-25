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
    assert.equal(hint('SAR 950,000 120 units'), 'SAR 950000');
    assert.equal(hint('SAR 4 500 000'), 'SAR 4500000');
    assert.equal(hint('SAR 4,500,000.'), 'SAR 4500000');
    assert.equal(hint('SAR 4,500,000.00'), 'SAR 4500000');
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

  it('never reads the m of a street width as millions', () => {
    assert.equal(hint('Villa 600 m2 on a 20m street, SAR 3,200,000'), 'SAR 3200000');
    assert.equal(hint('Villa on a 20 m road, 3.2m SAR'), 'SAR 3200000');
  });

  it('knows more ways to write an area', () => {
    for (const caption of [
      'Land 12,000 (sqm)', 'أرض ١٢٠٠٠ أمتار مربعة', 'أرض 12000 م', 'المساحة 12000م', 'Land 12,000 sq yd', 'Land 12,000 ft²',
      'Land 12,000 sq mt', 'Land 12,000 square-meters', 'Land 12,000 meter2', 'أرض 12000 مترا', 'أرض 12000 مـ2', 'أرض 12000 ‏م2',
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
    for (const caption of ['Land 12,000 m', 'SAR 4,500,000 m', 'street 20m', 'شارع 20m', '15,000 km from the city', 'أرض 12000 مترمربع']) {
      assert.equal(parsePriceHint(caption), null, caption);
    }
    assert.equal(hint('Villa on street 20m, 4.5m SAR'), 'SAR 4500000');
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
