// Map pins extracted from a brochure's PDF link annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMapUrl, isGeoUrl, pickPin, haversineM } from '../lib/geo.mjs';

test('parseMapUrl reads ?q=lat,lng (the resolved shortlink shape)', () => {
  assert.deepEqual(
    parseMapUrl('https://maps.google.com/maps?q=21.3380000,39.3047778&entry=gps'),
    { lat: 21.338, lng: 39.3047778 },
  );
});

test('parseMapUrl prefers the !3d/!4d place pin over the @ viewport centre', () => {
  // The @ centre is where the map was scrolled to; !3d/!4d is the actual pin.
  const u = "https://www.google.com/maps/place/21%C2%B020'16.8%22N+39%C2%B018'17.2%22E/@21.338,39.3069665,17z/data=!3m1!4b1!4m4!3m3!8m2!3d21.338!4d39.3047778";
  assert.deepEqual(parseMapUrl(u), { lat: 21.338, lng: 39.3047778 });
});

test('parseMapUrl falls back to the @ viewport centre when there is no pin', () => {
  assert.deepEqual(parseMapUrl('https://www.google.com/maps/@21.5,39.2,15z'), { lat: 21.5, lng: 39.2 });
});

test('parseMapUrl returns null for a non-map URL and for junk', () => {
  assert.equal(parseMapUrl('https://example.com/brochure'), null);
  assert.equal(parseMapUrl(''), null);
  assert.equal(parseMapUrl(null), null);
});

test('parseMapUrl rejects out-of-range coordinates', () => {
  assert.equal(parseMapUrl('https://maps.google.com/maps?q=210.0,39.0'), null);
  assert.equal(parseMapUrl('https://maps.google.com/maps?q=21.0,390.0'), null);
});

test('parseMapUrl ignores 0,0 (null island — a placeholder, never a property)', () => {
  assert.equal(parseMapUrl('https://maps.google.com/maps?q=0,0'), null);
});

test('isGeoUrl recognises the shortlink that needs resolving', () => {
  assert.equal(isGeoUrl('https://maps.app.goo.gl/jzoKW1LKeYCGwE1dA?g_st=iw'), true);
  assert.equal(isGeoUrl('https://www.google.com/maps/place/x/@21.3,39.3,17z'), true);
  assert.equal(isGeoUrl('https://instagram.com/developer'), false);
});

test('haversineM measures a short distance', () => {
  // ~157 m apart in Jeddah.
  const d = haversineM({ lat: 21.338, lng: 39.3047778 }, { lat: 21.3394, lng: 39.3047778 });
  assert.ok(d > 140 && d < 175, `expected ~157 m, got ${d}`);
});

// ---- pickPin: the corroboration rule -------------------------------------------------
// A brochure links to landmarks as well as to the property (one Bona brochure links King
// Abdulaziz airport). A lone pin is therefore never trusted: two independent links must
// agree to within PIN_AGREE_M before a pin is published.

test('pickPin accepts two links that agree (the real Wajhat Al-Warf case)', () => {
  const pin = pickPin([
    { lat: 21.338, lng: 39.3047778 },
    { lat: 21.338, lng: 39.3047778 },
  ]);
  // Rounded to 6 dp (~0.1 m) by pickPin — see the rounding test below.
  assert.deepEqual(pin, { lat: 21.338, lng: 39.304778 });
});

test('pickPin rejects a city pin and an airport pin that disagree', () => {
  // Real brochure: Jeddah city centre (10z) + King Abdulaziz airport. Neither is the home.
  assert.equal(pickPin([
    { lat: 21.4498002, lng: 39.540802 },
    { lat: 21.6829375, lng: 39.1666875 },
  ]), null);
});

test('pickPin rejects a single uncorroborated link', () => {
  assert.equal(pickPin([{ lat: 21.338, lng: 39.3047778 }]), null);
});

test('pickPin returns null for no candidates', () => {
  assert.equal(pickPin([]), null);
  assert.equal(pickPin(null), null);
});

test('pickPin picks the agreeing cluster out of a noisy set', () => {
  const pin = pickPin([
    { lat: 21.6829375, lng: 39.1666875 },  // airport, alone
    { lat: 21.338, lng: 39.3047778 },      // property
    { lat: 21.3381, lng: 39.30480 },       // property again, ~12 m off
  ]);
  assert.ok(pin && Math.abs(pin.lat - 21.338) < 0.001 && Math.abs(pin.lng - 39.3048) < 0.001);
});

test('pickPin rounds to 6 decimals (~0.1 m — no false precision)', () => {
  const pin = pickPin([
    { lat: 21.33812345678, lng: 39.30477778123 },
    { lat: 21.33812345678, lng: 39.30477778123 },
  ]);
  assert.equal(String(pin.lat).split('.')[1].length <= 6, true);
  assert.equal(String(pin.lng).split('.')[1].length <= 6, true);
});

// ---- pinFromLinks: the whole path, from PDF annotations to a pin ---------------------
import { pinFromLinks } from '../lib/geo.mjs';

const WARF_SHORT = 'https://maps.app.goo.gl/jzoKW1LKeYCGwE1dA?g_st=iw';
const WARF_PLACE = "https://www.google.com/maps/place/21%C2%B020'16.8%22N+39%C2%B018'17.2%22E/@21.338,39.3069665,17z/data=!3m1!4b1!4m4!3m3!8m2!3d21.338!4d39.3047778";
const resolveWarf = async (u) => (u === WARF_SHORT ? 'https://maps.google.com/maps?q=21.3380000,39.3047778&entry=gps' : u);

test('pinFromLinks resolves the shortlink and corroborates it against the place link', async () => {
  const pin = await pinFromLinks(
    [{ page: 7, uri: WARF_SHORT }, { page: 21, uri: WARF_PLACE }, { page: 22, uri: 'https://faisal-binsaedan.com/' }],
    { resolve: resolveWarf },
  );
  assert.deepEqual(pin, { lat: 21.338, lng: 39.304778 });
});

test('pinFromLinks ignores non-map links entirely', async () => {
  const pin = await pinFromLinks(
    [{ page: 1, uri: 'https://instagram.com/dev' }, { page: 2, uri: 'mailto:x@y.com' }],
    { resolve: async (u) => u },
  );
  assert.equal(pin, null);
});

test('pinFromLinks does not let one URL repeated on many pages corroborate itself', async () => {
  // extract_pdf.py returns a link once per page it appears on. The same link twice is one
  // source of truth, not two, so it must not clear the two-link bar on its own.
  const pin = await pinFromLinks(
    [{ page: 3, uri: WARF_PLACE }, { page: 9, uri: WARF_PLACE }, { page: 14, uri: WARF_PLACE }],
    { resolve: async (u) => u },
  );
  assert.equal(pin, null);
});

test('pinFromLinks survives a shortlink that will not resolve', async () => {
  const pin = await pinFromLinks(
    [{ page: 7, uri: WARF_SHORT }, { page: 21, uri: WARF_PLACE }],
    { resolve: async () => { throw new Error('network down'); } },
  );
  // The place link alone is uncorroborated -> no pin, and no crash.
  assert.equal(pin, null);
});

test('pinFromLinks rejects the airport+city brochure', async () => {
  const pin = await pinFromLinks([
    { page: 2, uri: 'https://www.google.com/maps/place/Jeddah/@21.4498002,39.540802,10z/data=!4m6!3m5!8m2!3d21.5291545!4d39.1610863' },
    { page: 5, uri: 'https://maps.app.goo.gl/aQXgH5RsKWoVevJ89' },
  ], { resolve: async () => 'https://www.google.com/maps/place/KAIA/@21.667086,39.1767274,16z/data=!4m6!3m5!8m2!3d21.6829375!4d39.1666875' });
  assert.equal(pin, null);
});

test('pinFromLinks handles an empty or missing link list', async () => {
  assert.equal(await pinFromLinks([], { resolve: async (u) => u }), null);
  assert.equal(await pinFromLinks(undefined, { resolve: async (u) => u }), null);
});

// ---- corroboration must survive URL cosmetics ---------------------------------------
// Two links only corroborate each other when they are genuinely two links. Google decorates
// the same URL with per-share tracking (g_st, g_ep, entry, lucs, skid), and two different
// shortlinks can resolve to one target — neither is a second opinion.

test('pinFromLinks treats tracking-param variants of one URL as one source', async () => {
  const a = `${WARF_PLACE}?entry=ttu&g_ep=EgoyMDI1MDgwMy4w`;
  const b = `${WARF_PLACE}?entry=tts&g_ep=EgoyMDI2MDEwMS4x&skid=abc`;
  assert.equal(await pinFromLinks([{ page: 1, uri: a }, { page: 2, uri: b }], { resolve: async (u) => u }), null);
});

test('pinFromLinks treats two shortlinks resolving to one target as one source', async () => {
  const target = 'https://maps.google.com/maps?q=21.3380000,39.3047778&entry=gps';
  const pin = await pinFromLinks(
    [{ page: 1, uri: 'https://maps.app.goo.gl/AAAAAAAAAAAAAAAA' }, { page: 2, uri: 'https://maps.app.goo.gl/BBBBBBBBBBBBBBBB' }],
    { resolve: async () => target },
  );
  assert.equal(pin, null);
});

test('pinFromLinks still accepts the real brochure: a shortlink AND a distinct place link', async () => {
  const pin = await pinFromLinks(
    [{ page: 7, uri: WARF_SHORT }, { page: 21, uri: WARF_PLACE }],
    { resolve: resolveWarf },
  );
  assert.deepEqual(pin, { lat: 21.338, lng: 39.304778 });
});
