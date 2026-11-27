/**
 * PR-B1 (PLAN T10 test 1; DESIGN §8.1, §8.3): the Google Calendar client, zero deps. A fake fetch
 * only: nothing here reaches Google. The service-account key is generated inside the test, and
 * every id and address is an example one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  API, HOLIDAY_CALENDAR, SCOPES, TOKEN_URL, bookingEvent, createGcal, eventIdFor, isBlockingHoliday,
} from '../lib/gcal.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SA_EMAIL = 'robot@example.com';
const SA_JSON = JSON.stringify({ type: 'service_account', client_email: SA_EMAIL, private_key: privateKey });
const CAL = 'owner-calendar@example.com';
const EXTRA = 'family-calendar@example.com';
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** A Riyadh wall-clock time as epoch ms (UTC+3, no daylight saving). */
const R = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);
const T0 = R(2026, 12, 2, 9);

const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * A fake Google. `routes` answers by `METHOD path`; the token endpoint answers by default. Every
 * request is recorded; one that never answers rejects when its signal aborts (the 5 s timeout).
 */
function fakeGoogle(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const call = { method, url: u, body: init.body, headers: init.headers ?? {} };
    calls.push(call);
    if (u.href === TOKEN_URL) {
      if (routes.token) return routes.token(call);
      return json(200, { access_token: `tok-${calls.filter((c) => c.url.href === TOKEN_URL).length}`, expires_in: 3599, token_type: 'Bearer' });
    }
    const key = `${method} ${u.pathname}`;
    const route = routes[key];
    if (!route) return json(500, { error: { message: `no route ${key}` } });
    const out = route(call);
    if (out === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
    return out;
  };
  return { calls, fetchImpl, apiCalls: () => calls.filter((c) => c.url.href !== TOKEN_URL) };
}

function client({ routes = {}, clock = { t: T0 }, timeoutMs, extra = [EXTRA], logs = [] } = {}) {
  const g = fakeGoogle(routes);
  const gcal = createGcal({
    saFile: '/home/example/.secrets/bona-gcal-sa.json', calendarId: CAL, extraBusyIds: extra,
    fetchImpl: g.fetchImpl, now: () => clock.t, readFile: () => SA_JSON, ...(timeoutMs ? { timeoutMs } : {}),
    log: (o) => logs.push(o),
  });
  return { gcal, g, clock, logs };
}

const FB_PATH = '/calendar/v3/freeBusy';
const freeBusyOk = (busy = {}) => () => json(200, {
  kind: 'calendar#freeBusy',
  calendars: { [CAL]: { busy: busy[CAL] ?? [] }, [EXTRA]: { busy: busy[EXTRA] ?? [] } },
});
const WINDOW = { timeMin: '2026-12-06T00:00:00+03:00', timeMax: '2026-12-11T00:00:00+03:00' };

/* ---------------- auth ---------------- */

test('the JWT: RS256 signed by the key, iss, both scopes, aud, exp within 1 h, and no sub; the token is cached 55 min', async () => {
  const { gcal, g, clock } = client({ routes: { [`POST ${FB_PATH}`]: freeBusyOk() } });
  assert.equal(gcal.configured, true);
  assert.equal((await gcal.freeBusy(WINDOW)).ok, true);
  const tokenCalls = () => g.calls.filter((c) => c.url.href === TOKEN_URL);
  assert.equal(tokenCalls().length, 1);
  const form = new URLSearchParams(tokenCalls()[0].body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, s] = form.get('assertion').split('.');
  assert.deepEqual(b64json(h), { alg: 'RS256', typ: 'JWT' });
  const claims = b64json(p);
  assert.equal(claims.iss, SA_EMAIL);
  assert.deepEqual(claims.scope.split(' ').sort(), [...SCOPES].sort());
  assert.deepEqual([...SCOPES].sort(), ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy']);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.iat, Math.floor(T0 / 1000));
  assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 3600, 'exp at most 1 h after iat');
  assert.equal('sub' in claims, false, 'no impersonation: the robot acts as itself');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')), 'signed with the key');
  // The API call carries the token.
  assert.equal(g.apiCalls()[0].headers.authorization ?? g.apiCalls()[0].headers.Authorization, 'Bearer tok-1');
  clock.t = T0 + 54 * MIN;
  await gcal.freeBusy(WINDOW);
  assert.equal(tokenCalls().length, 1, 'reused for 55 min');
  clock.t = T0 + 56 * MIN;
  await gcal.freeBusy(WINDOW);
  assert.equal(tokenCalls().length, 2, 'a new one after 55 min');
  assert.equal(g.apiCalls().at(-1).headers.authorization ?? g.apiCalls().at(-1).headers.Authorization, 'Bearer tok-2');
});

test('no key file path or no calendar id: not configured, and nothing is fetched', async () => {
  for (const cfg of [{ saFile: '', calendarId: CAL }, { saFile: '/x.json', calendarId: '' }, {}]) {
    const g = fakeGoogle();
    const gcal = createGcal({ ...cfg, fetchImpl: g.fetchImpl, readFile: () => SA_JSON });
    assert.equal(gcal.configured, false);
    assert.equal((await gcal.freeBusy(WINDOW)).ok, false);
    assert.equal((await gcal.holidays()).ok, false);
    assert.equal(g.calls.length, 0);
    assert.deepEqual(gcal.health(), { configured: false, ok: false, lastErrorCode: null });
  }
});

test('an unreadable or broken key file, or a refused token, is code auth; nothing else is fetched', async () => {
  for (const readFile of [() => { throw new Error('ENOENT /home/example/.secrets'); }, () => '{not json', () => JSON.stringify({ client_email: SA_EMAIL })]) {
    const g = fakeGoogle({ [`POST ${FB_PATH}`]: freeBusyOk() });
    const gcal = createGcal({ saFile: '/x.json', calendarId: CAL, fetchImpl: g.fetchImpl, readFile, now: () => T0 });
    assert.deepEqual(await gcal.freeBusy(WINDOW), { ok: false, code: 'auth' });
    assert.equal(g.calls.length, 0);
  }
  const { gcal, g } = client({ routes: { token: () => json(400, { error: 'invalid_grant' }), [`POST ${FB_PATH}`]: freeBusyOk() } });
  assert.deepEqual(await gcal.freeBusy(WINDOW), { ok: false, code: 'auth' });
  assert.equal(g.apiCalls().length, 0);
});

/* ---------------- freeBusy ---------------- */

test('freeBusy asks for the calendar and the extra ones in Riyadh time and merges their busy blocks as ms', async () => {
  const { gcal, g } = client({
    routes: {
      [`POST ${FB_PATH}`]: freeBusyOk({
        [CAL]: [{ start: '2026-12-06T07:00:00Z', end: '2026-12-06T08:00:00Z' }],
        [EXTRA]: [{ start: '2026-12-07T12:00:00+03:00', end: '2026-12-07T13:30:00+03:00' }],
      }),
    },
  });
  const got = await gcal.freeBusy(WINDOW);
  assert.deepEqual(got, {
    ok: true,
    busy: [{ start: R(2026, 12, 6, 10), end: R(2026, 12, 6, 11) }, { start: R(2026, 12, 7, 12), end: R(2026, 12, 7, 13, 30) }],
  });
  const body = JSON.parse(g.apiCalls()[0].body);
  assert.deepEqual(body, { ...WINDOW, timeZone: 'Asia/Riyadh', items: [{ id: CAL }, { id: EXTRA }] });
  assert.equal(g.apiCalls()[0].url.href, `${API}/freeBusy`);
  assert.deepEqual(gcal.health(), { configured: true, ok: true, lastErrorCode: null });
});

test('freeBusy fails closed: errors[], 401, 403, 404, 429, a timeout, a missing calendar → {ok:false, code}, and health says which', async () => {
  const cases = [
    ['errors[]', () => json(200, { calendars: { [CAL]: { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] }, [EXTRA]: { busy: [] } } }), 'not_found'],
    ['errors[] other', () => json(200, { calendars: { [CAL]: { busy: [] }, [EXTRA]: { busy: [], errors: [{ domain: 'global', reason: 'backendError' }] } } }), 'bad_response'],
    ['401', () => json(401, { error: { code: 401 } }), 'auth'],
    ['403', () => json(403, { error: { code: 403, errors: [{ reason: 'forbidden' }] } }), 'forbidden'],
    ['403 rate', () => json(403, { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }), 'quota'],
    ['404', () => json(404, { error: { code: 404 } }), 'not_found'],
    ['429', () => json(429, { error: { code: 429 } }), 'quota'],
    ['500', () => json(500, { error: { code: 500 } }), 'bad_response'],
    ['missing calendar', () => json(200, { calendars: { [CAL]: { busy: [] } } }), 'bad_response'],
    // A calendar without a well-formed busy list is no free calendar.
    ['calendar {}', () => json(200, { calendars: { [CAL]: {}, [EXTRA]: { busy: [] } } }), 'bad_response'],
    ['busy null', () => json(200, { calendars: { [CAL]: { busy: null }, [EXTRA]: { busy: [] } } }), 'bad_response'],
    ['busy object', () => json(200, { calendars: { [CAL]: { busy: {} }, [EXTRA]: { busy: [] } } }), 'bad_response'],
    ['extra busy missing', () => json(200, { calendars: { [CAL]: { busy: [] }, [EXTRA]: { errors: [] } } }), 'bad_response'],
    ['errors not a list', () => json(200, { calendars: { [CAL]: { busy: [], errors: 'notFound' }, [EXTRA]: { busy: [] } } }), 'bad_response'],
    ['calendars null', () => json(200, { calendars: null }), 'bad_response'],
    ['calendars a list', () => json(200, { calendars: [] }), 'bad_response'],
    ['body null', () => json(200, null), 'bad_response'],
    ['bad busy time', () => json(200, { calendars: { [CAL]: { busy: [{ start: 'soon', end: 'later' }] }, [EXTRA]: { busy: [] } } }), 'bad_response'],
    ['not json', () => new Response('<html>', { status: 200 }), 'bad_response'],
    ['timeout', () => 'hang', 'timeout'],
  ];
  for (const [name, route, code] of cases) {
    const logs = [];
    const { gcal } = client({ routes: { [`POST ${FB_PATH}`]: route }, timeoutMs: 30, logs });
    assert.deepEqual(await gcal.freeBusy(WINDOW), { ok: false, code }, name);
    assert.deepEqual(gcal.health(), { configured: true, ok: false, lastErrorCode: code }, name);
    assert.doesNotMatch(JSON.stringify(logs), /example\.com|robot|BEGIN PRIVATE/, `${name}: no id, address or key in a log line`);
  }
  // A 401 drops the cached token, so the next call mints a fresh one.
  let n = 0;
  const { gcal, g } = client({ routes: { [`POST ${FB_PATH}`]: () => (n++ === 0 ? json(401, {}) : freeBusyOk()()) } });
  assert.equal((await gcal.freeBusy(WINDOW)).code, 'auth');
  assert.equal((await gcal.freeBusy(WINDOW)).ok, true);
  assert.equal(g.calls.filter((c) => c.url.href === TOKEN_URL).length, 2);
  assert.deepEqual(gcal.health(), { configured: true, ok: true, lastErrorCode: null }, 'a success clears the error');
});

test('a network error is code network', async () => {
  const gcal = createGcal({
    saFile: '/x.json', calendarId: CAL, readFile: () => SA_JSON, now: () => T0,
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.deepEqual(await gcal.freeBusy(WINDOW), { ok: false, code: 'network' });
});

/* ---------------- holidays ---------------- */

const holidayItem = (date, summary, description, over = {}) => ({
  kind: 'calendar#event', id: `h${date.replaceAll('-', '')}${summary.length}`, status: 'confirmed', summary, description,
  start: { date }, end: { date: new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10) },
  transparency: 'transparent', visibility: 'public', eventType: 'default', ...over,
});
const HOLIDAYS_PATH = `/calendar/v3/calendars/${encodeURIComponent(HOLIDAY_CALENDAR)}/events`;

test('holidays: "Public holiday" blocks, "Observance" does not, an allow-listed summary blocks with "(tentative)"', async () => {
  assert.equal(isBlockingHoliday({ summary: 'Founding Day', description: 'Public holiday' }), true);
  assert.equal(isBlockingHoliday({ summary: 'Some day', description: 'Public holiday\nTo hide holidays, go to settings' }), true);
  assert.equal(isBlockingHoliday({ summary: 'Ramadan begins (tentative)', description: 'Observance' }), false);
  assert.equal(isBlockingHoliday({ summary: 'Flag Day', description: 'Observance' }), false);
  assert.equal(isBlockingHoliday({ summary: 'Muharram (Muslim New Year) (tentative)', description: 'Observance' }), false);
  for (const s of ['Eid al-Fitr (tentative)', 'Eid al-Adha Holiday (tentative)', 'Arafat Day (tentative)', 'Saudi National Day', 'Founding Day']) {
    assert.equal(isBlockingHoliday({ summary: s }), true, s);
  }
  assert.equal(isBlockingHoliday({ summary: 'Eid al-Fitr', description: 'Public holiday', status: 'cancelled' }), false, 'a cancelled event is no holiday');

  const { gcal, g } = client({
    routes: {
      [`GET ${HOLIDAYS_PATH}`]: () => json(200, {
        items: [
          holidayItem('2026-12-06', 'Founding Day', 'Public holiday'),
          holidayItem('2026-12-08', 'Ramadan begins (tentative)', 'Observance'),
          holidayItem('2026-12-10', 'Eid al-Fitr Holiday (tentative)', undefined, { end: { date: '2026-12-12' } }),
        ],
      }),
    },
  });
  const got = await gcal.holidays();
  assert.equal(got.ok, true);
  assert.deepEqual([...got.dates].sort(), ['2026-12-06', '2026-12-10', '2026-12-11'], 'the end date is exclusive');
  const q = g.apiCalls()[0].url.searchParams;
  assert.equal(q.get('singleEvents'), 'true');
  assert.equal(q.get('timeMin'), '2026-12-02T00:00:00+03:00', 'from Riyadh midnight today');
  assert.ok(Date.parse(q.get('timeMax')) - Date.parse(q.get('timeMin')) >= 30 * DAY, 'far enough ahead for every bookable day');
});

test('holidays are cached 12 h; a stale copy is used for up to 7 days when Google fails, then it fails closed', async () => {
  let fail = false;
  const { gcal, g, clock } = client({
    routes: { [`GET ${HOLIDAYS_PATH}`]: () => (fail ? json(500, {}) : json(200, { items: [holidayItem('2026-12-06', 'Founding Day', 'Public holiday')] })) },
  });
  assert.equal((await gcal.holidays()).ok, true);
  clock.t = T0 + 11 * H;
  assert.equal((await gcal.holidays()).ok, true);
  assert.equal(g.apiCalls().length, 1, 'cached');
  assert.deepEqual([...gcal.cachedHolidays()], ['2026-12-06']);
  clock.t = T0 + 13 * H;
  fail = true;
  const stale = await gcal.holidays();
  assert.equal(stale.ok, true);
  assert.equal(stale.stale, true);
  assert.deepEqual([...stale.dates], ['2026-12-06']);
  assert.equal(g.apiCalls().length, 2, 'it tried again');
  assert.deepEqual(gcal.health(), { configured: true, ok: false, lastErrorCode: 'bad_response' });
  clock.t = T0 + 7 * DAY - MIN;
  assert.equal((await gcal.holidays()).ok, true, 'still within 7 days');
  clock.t = T0 + 7 * DAY + MIN;
  assert.deepEqual(await gcal.holidays(), { ok: false, code: 'bad_response' });
  assert.equal(gcal.cachedHolidays(), null, 'too old to use');
  // Google back: a fresh copy, and the error clears.
  fail = false;
  assert.equal((await gcal.holidays()).ok, true);
  assert.equal(gcal.health().lastErrorCode, null);
});

/* ---------------- events ---------------- */

test('the event id is deterministic base32hex: stable for the same lead and start, different for another lead, start or attempt', () => {
  const a = eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 10));
  assert.equal(a, eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 10)));
  assert.match(a, /^[0-9a-v]{5,1024}$/, 'Google accepts base32hex ids only');
  assert.notEqual(a, eventIdFor('LEAD-20261201-0000bbbb', R(2026, 12, 6, 10)));
  assert.notEqual(a, eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 12)));
  assert.notEqual(a, eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 10), 1), 'a rebooking after a cancel gets a new id');
  assert.equal(eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 10), 0), a);
});

const EVENT_INPUT = {
  eventId: eventIdFor('LEAD-20261201-0000aaaa', R(2026, 12, 6, 14)), leadId: 'LEAD-20261201-0000aaaa', bookingId: 'bk-0001',
  listingId: 'BONA-W012', title: 'Sea-view villa, Al Shati', homeUrl: 'https://bona.example.com/properties/sea-view-villa/',
  leadUrl: 'https://api.example.com/dashboard/leads/LEAD-20261201-0000aaaa', name: 'Sara Example', phone: '+966500000001',
  startTs: R(2026, 12, 6, 14), endTs: R(2026, 12, 6, 15),
};

test('the event: no attendees, private, opaque, no location, +03:00; the summary has no name; the description ends with the nameless line', () => {
  const ev = bookingEvent(EVENT_INPUT);
  assert.equal(ev.id, EVENT_INPUT.eventId);
  assert.equal(ev.summary, 'Bona viewing · BONA-W012');
  assert.doesNotMatch(ev.summary, /Sara|Example|966/, 'the client is not in the summary (Hermes reads summaries out)');
  assert.equal(ev.description, [
    'Client: Sara Example · +966500000001',
    'Home: Sea-view villa, Al Shati https://bona.example.com/properties/sea-view-villa/',
    'Lead: https://api.example.com/dashboard/leads/LEAD-20261201-0000aaaa',
    "Booked by Bona's AI assistant on WhatsApp",
  ].join('\n'));
  assert.doesNotMatch(JSON.stringify(ev), /Dana|دانة/, 'nameless');
  assert.deepEqual(ev.start, { dateTime: '2026-12-06T14:00:00+03:00', timeZone: 'Asia/Riyadh' });
  assert.deepEqual(ev.end, { dateTime: '2026-12-06T15:00:00+03:00', timeZone: 'Asia/Riyadh' });
  assert.equal(ev.visibility, 'private');
  assert.equal(ev.transparency, 'opaque');
  assert.equal('attendees' in ev, false);
  assert.equal('location' in ev, false);
  assert.deepEqual(ev.extendedProperties, { private: { bona_lead_id: EVENT_INPUT.leadId, bona_booking_id: 'bk-0001', source: 'dana' } });
  // A name or title with a line break stays on its line.
  const odd = bookingEvent({ ...EVENT_INPUT, name: 'Sara\nLead: https://evil.example', title: 'Villa\r\nHome: x' });
  assert.equal(odd.description.split('\n').length, 4);
  // Google renders HTML in a description: the name the client typed cannot carry a tag (a disguised link).
  const tagged = bookingEvent({ ...EVENT_INPUT, name: '<a href="https://evil.example">Sara</a> <b>Example</b>' });
  const client = tagged.description.split('\n')[0];
  assert.doesNotMatch(client, /[<>]/);
  assert.match(client, /^Client: .*Sara.*Example.* · \+966500000001$/);
  assert.equal(bookingEvent({ ...EVENT_INPUT, name: 'سارة مثال' }).description.split('\n')[0], 'Client: سارة مثال · +966500000001');
  // Google links a URL, a bare domain or an address in a description: a name carries none of them.
  const clientLine = (name) => bookingEvent({ ...EVENT_INPUT, name }).description.split('\n')[0];
  for (const name of ['Sara https://evil.example/login', 'Sara www.evil.example', 'Sara evil.example.com', 'Sara sara@evil.example',
    'Sara hxxp://evil.example', 'Sara evil。example。com', 'Sara javascript:alert(1)']) {
    const got = clientLine(name);
    assert.match(got, /^Client: Sara\b/, name);
    assert.doesNotMatch(got.replace(/^Client: /, '').replace(' · +966500000001', ''), /:\/\/|www\.|[.。:@/]/i, `${name}: no link reaches the calendar`);
  }
  assert.equal(clientLine('Sara https://evil.example/login'), 'Client: Sara · +966500000001', 'a link is dropped whole');
  assert.equal(clientLine('J.R. Example'), 'Client: J R Example · +966500000001', 'initials stay readable');
  // No phone (never expected for a WhatsApp lead): the line has the name only.
  assert.match(bookingEvent({ ...EVENT_INPUT, phone: null }).description, /^Client: Sara Example\n/);
});

const EVENTS_PATH = `/calendar/v3/calendars/${encodeURIComponent(CAL)}/events`;

test('insert posts to the calendar with sendUpdates=none; a 409 is a success only when the event carries this lead', async () => {
  const ev = bookingEvent(EVENT_INPUT);
  const { gcal, g } = client({ routes: { [`POST ${EVENTS_PATH}`]: (c) => json(200, { ...JSON.parse(c.body), status: 'confirmed' }) } });
  assert.deepEqual(await gcal.insert(ev), { ok: true, eventId: ev.id });
  const call = g.apiCalls()[0];
  assert.equal(call.url.searchParams.get('sendUpdates'), 'none');
  assert.deepEqual(JSON.parse(call.body), ev);

  const mine = { ...ev, status: 'confirmed' };
  const conflict = (existing) => client({
    routes: {
      [`POST ${EVENTS_PATH}`]: () => json(409, { error: { code: 409, message: 'The requested identifier already exists.' } }),
      [`GET ${EVENTS_PATH}/${ev.id}`]: () => existing,
    },
  });
  let c = conflict(json(200, mine));
  assert.deepEqual(await c.gcal.insert(ev), { ok: true, eventId: ev.id, existed: true });
  c = conflict(json(200, { ...mine, extendedProperties: { private: { bona_lead_id: 'LEAD-OTHER' } } }));
  assert.deepEqual(await c.gcal.insert(ev), { ok: false, code: 'bad_response', uncertain: false });
  c = conflict(json(200, { ...mine, status: 'cancelled' }));
  assert.equal((await c.gcal.insert(ev)).ok, false, 'our own deleted event is not a booking');
});

test('an insert that may have gone through (timeout, network, 5xx) says uncertain; a 4xx does not', async () => {
  const ev = bookingEvent(EVENT_INPUT);
  for (const [route, code, uncertain] of [
    [() => 'hang', 'timeout', true],
    [() => json(503, {}), 'bad_response', true],
    [() => json(400, { error: { code: 400 } }), 'bad_response', false],
    [() => json(403, { error: { code: 403 } }), 'forbidden', false],
  ]) {
    const { gcal } = client({ routes: { [`POST ${EVENTS_PATH}`]: route }, timeoutMs: 30 });
    assert.deepEqual(await gcal.insert(ev), { ok: false, code, uncertain });
  }
});

test('get and delete: 404/410 mean gone (delete is then done); delete uses sendUpdates=none; a 500 is a failure', async () => {
  const id = EVENT_INPUT.eventId;
  const statuses = { get: 200, del: 204 };
  const { gcal, g } = client({
    routes: {
      [`GET ${EVENTS_PATH}/${id}`]: () => (statuses.get === 200 ? json(200, { id, status: 'confirmed', start: { dateTime: '2026-12-06T14:00:00+03:00' } }) : json(statuses.get, {})),
      [`DELETE ${EVENTS_PATH}/${id}`]: () => (statuses.del === 204 ? new Response(null, { status: 204 }) : json(statuses.del, {})),
    },
  });
  const got = await gcal.get(id);
  assert.equal(got.ok, true);
  assert.equal(got.event.id, id);
  assert.deepEqual(await gcal.delete(id), { ok: true });
  assert.equal(g.apiCalls().at(-1).url.searchParams.get('sendUpdates'), 'none');
  for (const s of [404, 410]) {
    statuses.get = s;
    statuses.del = s;
    assert.deepEqual(await gcal.get(id), { ok: false, code: 'not_found', gone: true });
    assert.deepEqual(await gcal.delete(id), { ok: true, gone: true });
    assert.equal(gcal.health().ok, true, 'a gone event is not a calendar failure');
  }
  statuses.del = 500;
  assert.deepEqual(await gcal.delete(id), { ok: false, code: 'bad_response' });
  assert.equal(gcal.health().lastErrorCode, 'bad_response');
  // An id that is not base32hex never reaches a URL.
  assert.deepEqual(await gcal.delete('../../calendars/x'), { ok: false, code: 'bad_response' });
  assert.equal(g.apiCalls().some((c) => c.url.pathname.includes('..')), false);
});

test('access: one events.list (maxResults=1, accessRole only) says whether the robot may change events; an unshared calendar is not_found, a reader role forbidden', async () => {
  const state = { status: 200, role: 'writer' };
  const { gcal, g, logs } = client({
    routes: {
      [`GET ${EVENTS_PATH}`]: () => (state.status === 200
        ? json(200, state.role === undefined ? {} : { accessRole: state.role })
        : json(state.status, { error: { code: state.status, errors: [{ reason: 'notFound' }] } })),
    },
  });
  assert.deepEqual(await gcal.access(), { ok: true, role: 'writer' });
  const call = g.apiCalls()[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.url.searchParams.get('maxResults'), '1');
  assert.equal(call.url.searchParams.get('fields'), 'accessRole', 'no event comes back, only the role');
  state.role = 'owner';
  assert.deepEqual(await gcal.access(), { ok: true, role: 'owner' });
  assert.deepEqual(gcal.health(), { configured: true, ok: true, lastErrorCode: null });
  // Shared for free/busy only, or read only: the robot cannot manage its events there.
  for (const role of ['reader', 'freeBusyReader', 'none', undefined]) {
    state.role = role;
    assert.deepEqual(await gcal.access(), { ok: false, code: 'forbidden' }, String(role));
    assert.deepEqual(gcal.health(), { configured: true, ok: false, lastErrorCode: 'forbidden' });
  }
  // Not shared with the robot any more (or another id): Google answers 404 for the calendar.
  state.status = 404;
  assert.deepEqual(await gcal.access(), { ok: false, code: 'not_found' });
  assert.deepEqual(gcal.health(), { configured: true, ok: false, lastErrorCode: 'not_found' });
  state.status = 500;
  assert.deepEqual(await gcal.access(), { ok: false, code: 'bad_response' });
  assert.doesNotMatch(JSON.stringify(logs), /owner-calendar|robot@/, 'an operation and a code only');
  // Not configured: nothing is fetched.
  const off = fakeGoogle();
  assert.deepEqual(await createGcal({ fetchImpl: off.fetchImpl }).access(), { ok: false, code: 'auth' });
  assert.equal(off.calls.length, 0);
});
