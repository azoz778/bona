import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderAqar, priceLine, licenceLine, licenceStatus, trackedUrl, main } from '../portal-export.mjs';

const site = {
  url: 'https://bona.azoz.uk',
  whatsapp: { display: '+966 59 329 6933' },
  licences: { fal: '1100313556' },
  advertiser: { name: { en: 'Abdulaziz Zidan', ar: 'عبدالعزيز زيدان' }, fal: '1100313556' },
};

const villa = {
  id: 'BONA-005',
  slug: 'contemporary-villa-al-khalidiyah',
  status: 'available',
  category: 'buy',
  type: 'villa',
  kind: 'house',
  title: { en: 'Contemporary Villa, Al Khalidiyah', ar: 'فيلا عصرية، الخالدية' },
  location: { district: { en: 'Al Khalidiyah', ar: 'الخالدية' }, city: { en: 'Jeddah', ar: 'جدة' } },
  price: { amount: 6700000, currency: 'SAR', from: false, period: null, onRequest: false },
  specs: { beds: 5, baths: 8, areaSqm: 640, plotSqm: null },
  licence: { adNumber: '7200123456', adExpiry: '2027-05-01' },
};

test('renderAqar: Arabic block first, then English, with every mandatory line', () => {
  const text = renderAqar(villa, site);
  const [ar, en] = text.split('\n\n');
  assert.ok(ar.startsWith('فيلا عصرية، الخالدية\n'), 'Arabic title first');
  assert.ok(ar.includes('فيلا للبيع'));
  assert.ok(ar.includes('السعر: 6,700,000 ر.س'));
  assert.ok(ar.includes('5 غرف · 8 دورات مياه · 640 م²'));
  assert.ok(ar.includes('الموقع: الخالدية، جدة'));
  assert.ok(ar.includes('رخصة الإعلان العقاري: 7200123456 — سارية حتى 2027-05-01'));
  assert.ok(ar.includes('المُعلن: عبدالعزيز زيدان — رخصة فال 1100313556'));
  assert.ok(ar.includes('https://bona.azoz.uk/ar/properties/contemporary-villa-al-khalidiyah/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=BONA-005'));
  assert.ok(en.startsWith('Contemporary Villa, Al Khalidiyah\n'));
  assert.ok(en.includes('Villa For sale'));
  assert.ok(en.includes('Price: SAR 6,700,000'));
  assert.ok(en.includes('Advertising licence: 7200123456 · valid until 2027-05-01'));
  assert.ok(en.includes('Advertiser: Abdulaziz Zidan — FAL licence 1100313556'));
  assert.ok(en.includes('https://bona.azoz.uk/properties/contemporary-villa-al-khalidiyah/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=BONA-005'));
  assert.ok(text.endsWith('\n'));
  assert.equal(text.includes('TK'), false, 'Bona copy never mentions TK');
});

test('price line: on request, from, rent period, foreign currency — never a computed number', () => {
  assert.equal(priceLine({ amount: null, currency: 'SAR', onRequest: true }, 'ar'), 'السعر عند الطلب');
  assert.equal(priceLine({ amount: null, currency: 'SAR', onRequest: false }, 'en'), 'Price on request');
  assert.equal(priceLine({ amount: 4500000, currency: 'SAR', onRequest: true }, 'en'), 'Price on request', 'onRequest wins even with an amount');
  assert.equal(priceLine({ amount: 1700000, currency: 'SAR', from: true }, 'ar'), 'يبدأ من 1,700,000 ر.س');
  assert.equal(priceLine({ amount: 1700000, currency: 'SAR', from: true }, 'en'), 'From SAR 1,700,000');
  assert.equal(priceLine({ amount: 180000, currency: 'SAR', period: 'year' }, 'ar'), '180,000 ر.س سنوياً');
  assert.equal(priceLine({ amount: 180000, currency: 'SAR', period: 'year' }, 'en'), 'SAR 180,000 per year');
  assert.equal(priceLine({ amount: 2500000, currency: 'EUR' }, 'en'), 'EUR 2,500,000');
  assert.equal(priceLine(undefined, 'ar'), 'السعر عند الطلب');
});

test('licence line: ad licence > Wafi > pending; status mirrors it', () => {
  assert.equal(licenceLine({ licence: null }, 'ar'), 'رخصة الإعلان: قيد الإصدار');
  assert.equal(licenceLine({}, 'en'), 'Advertising licence: pending');
  assert.equal(licenceLine({ licence: { wafiNumber: '1234' } }, 'ar'), 'رخصة مشروع وافي: 1234');
  assert.equal(licenceLine({ licence: { wafiNumber: '1234', escrowAccount: 'SA00' } }, 'en'), 'Wafi project licence: 1234 · escrow account SA00');
  assert.equal(licenceLine({ licence: { adNumber: '99', wafiNumber: '1234' } }, 'en'), 'Advertising licence: 99', 'the ad licence wins when both exist');
  assert.equal(licenceStatus({}), 'pending');
  assert.equal(licenceStatus({ licence: { wafiNumber: '1' } }), 'wafi');
  assert.equal(licenceStatus({ licence: { adNumber: '1', adExpiry: '2099-01-01' } }), 'ad-licence');
  assert.equal(licenceStatus({ licence: { adNumber: '1', adExpiry: '2020-01-01' } }), 'expired');
});

test('off-plan unit: category label, project name, Wafi line, on-request price', () => {
  const unit = {
    ...villa,
    id: 'BONA-W003',
    slug: 'al-wareef-townhouse-jeddah',
    category: 'off-plan',
    title: { en: 'Al-Wareef Townhouse, Jeddah', ar: 'تاون هاوس الوريف، جدة' },
    project: { name: { en: 'Wajhat Al-Wareef', ar: 'وجهة الوريف' } },
    price: { amount: null, currency: 'SAR', from: false, period: null, onRequest: true },
    licence: { wafiNumber: '5566' },
  };
  const text = renderAqar(unit, site);
  assert.ok(text.includes('فيلا على الخارطة'));
  assert.ok(text.includes('المشروع: وجهة الوريف'));
  assert.ok(text.includes('السعر: السعر عند الطلب'));
  assert.ok(text.includes('رخصة مشروع وافي: 5566'));
  assert.ok(text.includes('Wafi project licence: 5566'));
  assert.ok(text.includes('utm_content=BONA-W003'));
});

test('the tracked URL is locale-aware and falls back to the advertiser default when site.json has none', () => {
  assert.equal(trackedUrl(villa, { url: 'https://bona.sa/' }, 'ar'), 'https://bona.sa/ar/properties/contemporary-villa-al-khalidiyah/?utm_source=aqar&utm_medium=portal&utm_campaign=listing&utm_content=BONA-005');
  assert.equal(trackedUrl(villa, { url: 'https://bona.sa' }, 'en', 'bayut').includes('utm_source=bayut'), true);
  const text = renderAqar(villa, { url: 'https://bona.azoz.uk', licences: { fal: '1100313556' } });
  assert.ok(text.includes('المُعلن: عبدالعزيز زيدان — رخصة فال 1100313556'));
});

test('main writes one file per available listing and --list prints the licence status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-portal-'));
  const listingsFile = path.join(dir, 'listings.json');
  const siteFile = path.join(dir, 'site.json');
  fs.writeFileSync(listingsFile, JSON.stringify([villa, { ...villa, id: 'BONA-006', slug: 'sold-one', status: 'sold' }, { ...villa, id: 'BONA-007', slug: 'no-licence', licence: null }]));
  fs.writeFileSync(siteFile, JSON.stringify(site));
  const lines = [];
  const res = main(['--out', path.join(dir, 'out')], { listingsFile, siteFile, log: (s) => lines.push(s) });
  assert.deepEqual(res.written.map((f) => path.basename(f)), ['BONA-005.txt', 'BONA-007.txt'], 'sold listings are skipped');
  assert.ok(fs.readFileSync(path.join(dir, 'out/aqar/BONA-007.txt'), 'utf8').includes('قيد الإصدار'));
  assert.match(lines.join('\n'), /2 file\(s\)/);
  assert.match(lines.join('\n'), /1 marked "licence pending"/);

  lines.length = 0;
  main(['--list', '--id', 'bona-007'], { listingsFile, siteFile, log: (s) => lines.push(s) });
  assert.match(lines.join('\n'), /BONA-007\s+available\s+buy\s+pending/);

  assert.throws(() => main(['--id', 'BONA-999'], { listingsFile, siteFile, log: () => {} }), /no listing with id BONA-999/);
  fs.rmSync(dir, { recursive: true, force: true });
});
