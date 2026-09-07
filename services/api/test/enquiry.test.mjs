import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnquiry, enquiryIds } from '../lib/enquiry.mjs';

const ANON = '9f1c'.repeat(8);
const good = (over = {}) => ({
  form: 'listing', name: 'Sara Ahmed', phone: '+966 50 000 0000', interest: 'villa', type: 'buy', budget: '8m', location: 'Al Shati',
  message: 'Is it still available?\n\nThanks', listing_id: 'BONA-W003', page: '/properties/bona-w003/', locale: 'ar',
  event_id: 'mf3k2a1b-form0001', attr: { anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', first: { utm_source: 'meta' }, last: { utm_source: 'meta' } },
  consent: { analytics: true, ads: true }, ...over,
});

test('a well-formed enquiry validates and normalises', () => {
  const r = validateEnquiry(good());
  assert.equal(r.ok, true);
  const q = r.enquiry;
  assert.equal(q.form, 'listing');
  assert.equal(q.name, 'Sara Ahmed');
  assert.equal(q.phone, '966500000000');
  assert.equal(q.message, 'Is it still available?\n\nThanks');
  assert.equal(q.listing_id, 'BONA-W003');
  assert.equal(q.locale, 'ar');
  assert.equal(q.event_id, 'mf3k2a1b-form0001');
  assert.deepEqual(q.ids, { anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', listing_id: 'BONA-W003' });
  assert.equal(q.attr.first.utm_source, 'meta');
  assert.deepEqual(q.consent, { analytics: true, ads: true });
});

test('name and phone are the two hard requirements', () => {
  assert.equal(validateEnquiry(good({ name: 'S' })).ok, false);
  assert.equal(validateEnquiry(good({ name: '  ' })).ok, false);
  assert.equal(validateEnquiry(good({ name: undefined })).ok, false);
  assert.equal(validateEnquiry(good({ phone: '12' })).ok, false);
  assert.equal(validateEnquiry(good({ phone: 'call me' })).ok, false);
  assert.equal(validateEnquiry(good({ phone: '+966 50 000 0000 ext 5' })).ok, false);
  assert.equal(validateEnquiry(good({ phone: '1'.repeat(16) })).ok, false);
  assert.equal(validateEnquiry(null).ok, false);
  assert.equal(validateEnquiry(good({ phone: '٠٥٠٠٠٠٠٠٠٠' })).enquiry.phone, '966500000000', 'Arabic digits are fine');
  assert.equal(validateEnquiry(good({ phone: '(050) 000-0000' })).enquiry.phone, '966500000000', 'punctuation is fine');
  assert.equal(validateEnquiry(good({ phone: '+971501234567' })).enquiry.phone, '971501234567');
  const r = validateEnquiry(good({ phone: '12' }));
  assert.equal(r.error, 'bad_request');
  assert.match(r.message, /phone/);
});

test('everything else is optional, defaulted, capped, and never a reason to refuse', () => {
  const r = validateEnquiry({ name: 'Omar', phone: '0500000001', form: 'other', listing_id: 'TK-1', event_id: 'nope', attr: 'x', locale: 'fr', message: 'a'.repeat(3000), interest: 'b'.repeat(500) });
  assert.equal(r.ok, true);
  const q = r.enquiry;
  assert.equal(q.form, 'contact');
  assert.equal(q.listing_id, null);
  assert.match(q.event_id, /^ev-[0-9a-z]+-[0-9a-f]{4}$/, 'a missing or bad event id is minted here');
  assert.equal(q.locale, 'en');
  assert.equal(q.message.length, 2000);
  assert.equal(q.interest.length, 300);
  assert.deepEqual(q.ids, { anon_id: null, session_id: null, ref: null, listing_id: null });
  assert.equal(q.attr.first, null);
  assert.deepEqual(q.consent, { analytics: false, ads: false });
  assert.equal(q.type, null);
});

test('the ids are found wherever the form put them', () => {
  assert.deepEqual(enquiryIds({ anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'k7q2xr' }), { anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', listing_id: null });
  assert.deepEqual(enquiryIds({ attr: { anon_id: ANON, session: { id: 'mf3k2a-7b1c', ref: 'K7Q2XR' } } }), { anon_id: ANON, session_id: 'mf3k2a-7b1c', ref: 'K7Q2XR', listing_id: null });
  assert.deepEqual(enquiryIds({ attr: { anon_id: 'bad', session_id: 'x' } }), { anon_id: null, session_id: null, ref: null, listing_id: null });
  assert.equal(validateEnquiry(good({ listing_id: undefined, attr: { listing_id: 'bona-w004' } })).enquiry.listing_id, 'BONA-W004', 'the bundle can name the listing too');
});
