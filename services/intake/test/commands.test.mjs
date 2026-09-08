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

  // `brochure <id>` re-runs rebrand_pdf.py against the original PDF still on disk. It is
  // what the owner reaches for after `price` or a title fix: those facts are printed on the
  // brochure's cover, so the PDF goes stale the moment they change.
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
