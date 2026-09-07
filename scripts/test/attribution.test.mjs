/* src/scripts/attribution.js — the first-party half of the tracking stack.
   What matters here is that the eight events the business actually reads reach BOTH places: the
   first-party store (POST /v1/events) and, once consent has loaded them, the vendor tags — under
   one event id, so the server-side fan-out de-duplicates against the pixel rather than doubling it.
   And that a WhatsApp click carries the session's Ref code, which is the only thread tying a
   WhatsApp conversation back to the campaign that paid for the visit. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, anchor, clickOn } from './dom.mjs';

const LISTING = 'BONA-W003';
const API = 'https://api.example.test';

/** Boot attribution.js on a listing page and hand back the harness. */
function onListing(over = {}) {
  const dom = makeWindow({ href: 'https://example.test/properties/x/?utm_source=meta&utm_medium=paid&utm_campaign=villas_sep&fbclid=IwAR1', referrer: 'https://l.instagram.com/', listing: LISTING, ...over });
  dom.run('attribution.js');
  return dom;
}

const posted = (dom) => dom.requests.filter((r) => r.url === `${API}/v1/events`).map((r) => JSON.parse(r.init.body));
const named = (dom, name) => posted(dom).filter((e) => e.event === name);

/** The vendor tags, as tags.js would have left them after an "Accept all". */
function installTags(dom) {
  const calls = { ga: [], meta: [], snap: [], tiktok: [] };
  dom.win.gtag = (...a) => calls.ga.push(a);
  dom.win.fbq = (...a) => calls.meta.push(a);
  dom.win.snaptr = (...a) => calls.snap.push(a);
  dom.win.ttq = { track: (...a) => calls.tiktok.push(a), page: () => {} };
  return calls;
}

/* ---------------- the page view itself ---------------- */

test('a listing page reports page_view and listing_view to the store, with the campaign that brought the visitor', () => {
  const dom = onListing();
  assert.deepEqual(posted(dom).map((e) => e.event), ['page_view', 'listing_view']);

  const [pv, lv] = posted(dom);
  assert.equal(pv.v, 1);
  assert.equal(pv.page, '/properties/x/');
  assert.equal(lv.listing_id, LISTING, 'read from <body data-listing>');
  assert.equal(pv.attr.first.utm_source, 'meta');
  assert.equal(pv.attr.first.utm_campaign, 'villas_sep');
  assert.equal(pv.attr.first.click_ids.fbclid, 'IwAR1');
  assert.match(pv.anon_id, /^[0-9a-f]{32}$/);
  assert.match(pv.ref, /^[A-HJ-NP-Z2-9]{6}$/, 'the Ref code avoids 0/O/1/I so a person can read it aloud');
  assert.deepEqual(pv.consent, { analytics: false, ads: false });
  // Every event of a visit shares one session and one Ref.
  assert.equal(pv.session_id, lv.session_id);
  assert.equal(pv.ref, lv.ref);
});

test('the request is a CORS simple request, so it survives the tab closing', () => {
  const dom = onListing();
  const { init } = dom.requests[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.keepalive, true);
  assert.equal(init.headers['Content-Type'], 'text/plain', 'application/json would force a preflight');
  assert.equal(init.credentials, 'omit');
});

test('with no API configured the site still works and simply records nothing', () => {
  const dom = makeWindow({ listing: LISTING, api: '' });
  assert.doesNotThrow(() => dom.run('attribution.js'));
  assert.deepEqual(dom.requests, []);
  assert.equal(typeof dom.win.bonaTrack, 'function');
});

/* ---------------- the Ref code on a WhatsApp click ---------------- */

test('a WhatsApp link is rewritten at click time to carry the listing and the session Ref', () => {
  const dom = onListing();
  const a = anchor({ 'data-cta': 'listing_whatsapp', 'data-listing': LISTING }, { href: 'https://wa.me/966593296933?text=Hello%2C%20I%20am%20interested' });
  dom.fire('click', clickOn(a));

  const ref = posted(dom)[0].ref;
  const text = decodeURIComponent(new URL(a.href).searchParams.get('text'));
  assert.equal(text, `Hello, I am interested\nRef ${LISTING} · ${ref}`);
  assert.ok(!a.href.includes('+'), 'some WhatsApp clients render a literal + for an encoded space');

  const [click] = named(dom, 'whatsapp_click');
  assert.equal(click.listing_id, LISTING);
  assert.equal(click.props.cta, 'listing_whatsapp');
  assert.equal(click.ref, ref);

  // Clicking again must not stack a second Ref line onto the same message.
  dom.fire('click', clickOn(a));
  const again = decodeURIComponent(new URL(a.href).searchParams.get('text'));
  assert.equal(again.match(/Ref /g).length, 1);
});

test('a WhatsApp link with no prefilled message gets one', () => {
  const dom = onListing({ listing: null, href: 'https://example.test/' });
  const a = anchor({ 'data-cta': 'header_whatsapp' }, { href: 'https://wa.me/966593296933' });
  dom.fire('click', clickOn(a));
  const text = decodeURIComponent(new URL(a.href).searchParams.get('text'));
  assert.match(text, /^Ref BONA · [A-HJ-NP-Z2-9]{6}$/, 'off a listing page the Ref is still minted');
  assert.equal(named(dom, 'whatsapp_click')[0].listing_id, null);
});

/* ---------------- the eight events the business reads ---------------- */

test('every CTA the site marks reaches the store under the right name', () => {
  const dom = onListing();
  const clicks = [
    [anchor({ 'data-cta': 'listing_tel' }, { href: 'tel:+966593296933' }), 'call_click'],
    [anchor({ 'data-track': 'brochure_download', 'data-cta': 'listing_brochure' }), 'brochure_download'],
    [anchor({ 'data-track': 'map_click', 'data-cta': 'listing_map_external', 'data-listing': LISTING }), 'map_click'],
    [anchor({ 'data-track': 'gallery_open', 'data-cta': 'gallery_strip' }), 'gallery_open'],
    [anchor({ 'data-track': 'tour_open', 'data-cta': 'tour_facade' }), 'tour_open'],
  ];
  for (const [el] of clicks) dom.fire('click', clickOn(el));
  dom.win.bonaTrack('concierge_open', { tab: 'chat' });
  dom.win.bonaTrack('form_submit', { form: 'listing' }, { eventId: 'mf3k2a1b-form0001' });

  const seen = posted(dom).map((e) => e.event);
  for (const [, name] of clicks) assert.ok(seen.includes(name), name);
  for (const name of ['page_view', 'listing_view', 'concierge_open', 'form_submit']) assert.ok(seen.includes(name), name);
  assert.equal(named(dom, 'map_click')[0].listing_id, LISTING);
  assert.equal(named(dom, 'call_click')[0].props.cta, 'listing_tel');
});

test('an event id minted elsewhere is reused, so one lead is not counted twice', () => {
  const dom = onListing();
  const tags = installTags(dom);
  // This is what EnquiryForm.astro does: the id it posted to /v1/enquiry is the id the pixels fire Lead with.
  dom.win.bonaTrack('form_submit', { form: 'listing' }, { eventId: 'mf3k2a1b-form0001' });
  assert.equal(named(dom, 'form_submit')[0].event_id, 'mf3k2a1b-form0001');
  const lead = tags.meta.find((c) => c[1] === 'Lead');
  assert.equal(lead[3].eventID, 'mf3k2a1b-form0001', 'the server-side Conversions API call carries the same id');
});

test('a name that is not on the allowlist is refused rather than sent', () => {
  const dom = onListing();
  const before = dom.requests.length;
  assert.equal(dom.win.bonaTrack('buy_now'), null);
  assert.equal(dom.requests.length, before);
});

/* ---------------- the mirror into the vendor tags ---------------- */

test('a WhatsApp click reaches GA4, Meta, Snap and TikTok under one event id', () => {
  const dom = onListing();
  const tags = installTags(dom);
  const a = anchor({ 'data-cta': 'listing_whatsapp', 'data-listing': LISTING }, { href: 'https://wa.me/966593296933' });
  dom.fire('click', clickOn(a));
  const id = named(dom, 'whatsapp_click')[0].event_id;

  const ga = tags.ga.find((c) => c[1] === 'whatsapp_click');
  assert.equal(ga[2].listing_id, LISTING);
  assert.equal(ga[2].cta, 'listing_whatsapp');

  const meta = tags.meta.find((c) => c[1] === 'Contact');
  assert.equal(meta[0], 'track');
  assert.deepEqual([...meta[2].content_ids], [LISTING]);
  assert.equal(meta[3].eventID, id);

  const snap = tags.snap.find((c) => c[1] === 'CUSTOM_EVENT_1');
  assert.equal(snap[2].client_dedup_id, id);

  const tiktok = tags.tiktok.find((c) => c[0] === 'Contact');
  assert.equal(tiktok[2].event_id, id);
});

test('a brochure download is a custom Meta event, not a muddied standard one', () => {
  const dom = onListing();
  const tags = installTags(dom);
  dom.fire('click', clickOn(anchor({ 'data-track': 'brochure_download', 'data-cta': 'listing_brochure' })));
  const meta = tags.meta.find((c) => c[1] === 'BrochureDownload');
  assert.equal(meta[0], 'trackCustom', 'ViewContent is what the owner will optimise listing ads against');
  assert.ok(tags.ga.some((c) => c[1] === 'brochure_download'));
  assert.ok(tags.tiktok.some((c) => c[0] === 'Download'));
});

test('an event with no honest name on a platform is simply not sent there', () => {
  const dom = onListing();
  const tags = installTags(dom);
  dom.win.bonaTrack('concierge_open', { tab: 'chat' });
  assert.ok(tags.ga.some((c) => c[1] === 'concierge_open'), 'GA4 takes our own vocabulary');
  assert.equal(tags.meta.length, 0);
  assert.equal(tags.snap.length, 0);
  assert.equal(tags.tiktok.length, 0);
});

test('a tag that throws cannot take the page with it', () => {
  const dom = onListing();
  dom.win.gtag = () => { throw new Error('blocked'); };
  dom.win.fbq = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => dom.win.bonaTrack('listing_view'));
  assert.ok(named(dom, 'listing_view').length >= 2, 'the first-party record is made regardless');
});

/* ---------------- consent decides where the visitor's state may live ---------------- */

test('without consent the visitor state dies with the tab', () => {
  const dom = onListing();
  assert.equal(dom.win.localStorage.getItem('bona_attr'), null, 'nothing durable before the banner is answered');
  assert.ok(dom.win.sessionStorage.getItem('bona_attr'), 'the session still works, so a Ref code still works');
  assert.equal(dom.win.document.cookie, '', 'and no id cookie is set');
});

test('after an accept the same visitor is remembered, keeping the first touch', () => {
  const dom = onListing();
  const first = posted(dom)[0];
  dom.setConsent(true, true);
  dom.win.bonaAttrPersist();

  const stored = JSON.parse(dom.win.localStorage.getItem('bona_attr'));
  assert.equal(stored.anon_id, first.anon_id, 'the person is not restarted by saying yes');
  assert.equal(stored.first.utm_campaign, 'villas_sep');
  assert.match(dom.win.document.cookie, /^bona_id=[0-9a-f]{32};/);
});
