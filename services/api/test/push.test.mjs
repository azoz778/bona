import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  generateVapidKeys, vapidKeys, vapidJwt, pushEndpoint, subscriptionKeys, createPusher,
  PUSH_TTL_S, JWT_TTL_S, JWT_REUSE_MS, MAX_ENDPOINT_LEN,
} from '../lib/push.mjs';

const NOW = 1_790_600_000_000;
const b64u = (b) => Buffer.from(b).toString('base64url');

test('a generated pair is a 65-byte P-256 point and a 32-byte scalar that load back as a pair', () => {
  const k = generateVapidKeys();
  const pub = Buffer.from(k.publicKey, 'base64url');
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 4);
  assert.equal(Buffer.from(k.privateKey, 'base64url').length, 32);
  assert.doesNotMatch(k.publicKey + k.privateKey, /[+/=]/, 'base64url without padding');
  const loaded = vapidKeys(k);
  assert.equal(loaded.publicKey, k.publicKey);
  assert.equal(loaded.key.asymmetricKeyType, 'ec');
});

test('keys that are missing, malformed or not one pair are refused, never half-used', () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.equal(vapidKeys(null), null);
  assert.equal(vapidKeys({}), null);
  assert.equal(vapidKeys({ publicKey: a.publicKey }), null);
  assert.equal(vapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey }), null, 'a public key from another pair');
  assert.equal(vapidKeys({ publicKey: a.publicKey.slice(2), privateKey: a.privateKey }), null);
  assert.equal(vapidKeys({ publicKey: 'not base64!', privateKey: a.privateKey }), null);
  assert.equal(vapidKeys({ publicKey: a.publicKey, privateKey: b64u(Buffer.alloc(32)) }), null, 'a zero scalar is no key');
});

test('every generated pair is a 43-char scalar that loads: a leading zero byte is padded, not dropped (1 in 256)', () => {
  for (let i = 0; i < 3000; i += 1) {
    const k = generateVapidKeys();
    assert.equal(k.privateKey.length, 43, `pair ${i}`);
    assert.ok(vapidKeys(k), `pair ${i} loads`);
  }
});

test('a scalar already written short (its leading zero byte dropped) still loads, as the same key as its padded form', () => {
  let scalar;
  let ecdh;
  for (;;) {
    scalar = Buffer.concat([Buffer.alloc(1), crypto.randomBytes(31)]);
    ecdh = crypto.createECDH('prime256v1');
    try { ecdh.setPrivateKey(scalar); break; } catch { /* outside the range: draw again */ }
  }
  const publicKey = b64u(ecdh.getPublicKey(null, 'uncompressed'));
  const short = vapidKeys({ publicKey, privateKey: b64u(scalar.subarray(1)) });
  const padded = vapidKeys({ publicKey, privateKey: b64u(scalar) });
  assert.ok(short, 'the 31-byte form loads');
  assert.ok(padded);
  assert.equal(short.publicKey, padded.publicKey);
  assert.deepEqual(short.key.export({ format: 'jwk' }), padded.key.export({ format: 'jwk' }));
  assert.equal(vapidKeys({ publicKey, privateKey: b64u(Buffer.alloc(1)) }), null, 'a short zero is still no key');
});

test('the JWT is ES256 over the push service origin, 12 h, signed raw r‖s, and verifies with the public key', () => {
  const k = vapidKeys(generateVapidKeys());
  const jwt = vapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'https://bona-real-estate.com', key: k.key, nowMs: NOW });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: Math.floor(NOW / 1000) + JWT_TTL_S, sub: 'https://bona-real-estate.com' });
  const sig = Buffer.from(s, 'base64url');
  assert.equal(sig.length, 64);
  const pub = Buffer.from(k.publicKey, 'base64url');
  const verifyKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, sig));
  assert.doesNotMatch(jwt, /[+/=]/);
});

test('only a real push service endpoint is accepted (the server POSTs to it)', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b-xyz',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXutnMhyq0',
    'https://api.push.apple.com/x',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
  ]) assert.equal(pushEndpoint(ok), new URL(ok).href, ok);
  assert.equal(pushEndpoint('https://FCM.googleapis.com:443/fcm/send/x'), 'https://fcm.googleapis.com/fcm/send/x');
  for (const bad of [
    'http://fcm.googleapis.com/fcm/send/a', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com.evil.example/x',
    'https://notify.windows.com/x', 'https://push.apple.com/x', 'https://user@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x',
    'https://..push.apple.com/x', 'https://fcm.googleapis.com./x', 'https://evil.example\\@fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'javascript:alert(1)', '', null, 42, { href: 'https://fcm.googleapis.com/x' },
    `https://fcm.googleapis.com/${'a'.repeat(MAX_ENDPOINT_LEN)}`,
  ]) assert.equal(pushEndpoint(bad), null, String(bad).slice(0, 60));
});

test('subscription keys: a 65-byte uncompressed point and a 16-byte secret, as base64url', () => {
  const point = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]);
  const auth = crypto.randomBytes(16);
  assert.deepEqual(subscriptionKeys({ p256dh: b64u(point), auth: b64u(auth) }), { p256dh: b64u(point), auth: b64u(auth) });
  assert.deepEqual(subscriptionKeys({ p256dh: b64u(point) + '=', auth: b64u(auth) + '==' }), { p256dh: b64u(point), auth: b64u(auth) });
  assert.equal(subscriptionKeys({ p256dh: b64u(point.subarray(1)), auth: b64u(auth) }), null);
  assert.equal(subscriptionKeys({ p256dh: b64u(point), auth: b64u(auth.subarray(1)) }), null);
  assert.equal(subscriptionKeys({ p256dh: b64u(Buffer.concat([Buffer.from([2]), point.subarray(1)])), auth: b64u(auth) }), null, 'not uncompressed');
  assert.equal(subscriptionKeys({ p256dh: 'x'.repeat(5000), auth: b64u(auth) }), null);
  assert.equal(subscriptionKeys(null), null);
});

function fakeFetch(answer = () => ({ status: 201 })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const a = answer(calls.length, url);
    if (a instanceof Error) throw a;
    return { status: a.status, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { calls, fetchImpl };
}

test('a push is an empty POST with TTL, high urgency and the VAPID authorization, nothing else', async () => {
  const keys = vapidKeys(generateVapidKeys());
  const f = fakeFetch();
  const pusher = createPusher({ keys, subject: 'https://bona-real-estate.com', fetchImpl: f.fetchImpl, now: () => NOW });
  assert.equal(pusher.publicKey, keys.publicKey);
  const out = await pusher.send('https://fcm.googleapis.com/fcm/send/abc');
  assert.deepEqual(out, { status: 201 });
  const [{ url, init }] = f.calls;
  assert.equal(url, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.TTL, String(PUSH_TTL_S));
  assert.equal(init.headers.Urgency, 'high');
  assert.match(init.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
  assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'TTL', 'Urgency']);
  assert.ok(init.signal, 'a timeout rides on every request');
});

test('one JWT per push service origin, reused for an hour, then made again', async () => {
  const keys = vapidKeys(generateVapidKeys());
  let clock = NOW;
  const f = fakeFetch();
  const pusher = createPusher({ keys, subject: 'https://bona-real-estate.com', fetchImpl: f.fetchImpl, now: () => clock });
  const jwtOf = (i) => /t=([^,]+),/.exec(f.calls[i].init.headers.Authorization)[1];
  const audOf = (i) => JSON.parse(Buffer.from(jwtOf(i).split('.')[1], 'base64url')).aud;
  await pusher.send('https://fcm.googleapis.com/fcm/send/a');
  await pusher.send('https://fcm.googleapis.com/fcm/send/b');
  await pusher.send('https://web.push.apple.com/c');
  assert.equal(jwtOf(0), jwtOf(1));
  assert.equal(audOf(2), 'https://web.push.apple.com');
  clock += JWT_REUSE_MS + 1;
  await pusher.send('https://fcm.googleapis.com/fcm/send/a');
  assert.notEqual(jwtOf(3), jwtOf(0));
});

test('send never rejects: a timeout and a network failure come back as kinds, never messages', async () => {
  const keys = vapidKeys(generateVapidKeys());
  const timeout = createPusher({ keys, subject: 's', fetchImpl: fakeFetch(() => Object.assign(new Error('x'), { name: 'TimeoutError' })).fetchImpl });
  assert.deepEqual(await timeout.send('https://fcm.googleapis.com/x'), { error: 'timeout' });
  const abort = createPusher({ keys, subject: 's', fetchImpl: fakeFetch(() => Object.assign(new Error('x'), { name: 'AbortError' })).fetchImpl });
  assert.deepEqual(await abort.send('https://fcm.googleapis.com/x'), { error: 'timeout' });
  const down = createPusher({ keys, subject: 's', fetchImpl: fakeFetch(() => new Error('getaddrinfo EAI_AGAIN fcm.googleapis.com')).fetchImpl });
  assert.deepEqual(await down.send('https://fcm.googleapis.com/x'), { error: 'network' });
  const gone = createPusher({ keys, subject: 's', fetchImpl: fakeFetch(() => ({ status: 410 })).fetchImpl });
  assert.deepEqual(await gone.send('https://fcm.googleapis.com/x'), { status: 410 });
});

test('send re-checks its endpoint and never fetches a bad one', async () => {
  const f = fakeFetch();
  const pusher = createPusher({ keys: vapidKeys(generateVapidKeys()), subject: 's', fetchImpl: f.fetchImpl });
  assert.deepEqual(await pusher.send('http://127.0.0.1/x'), { error: 'bad_endpoint' });
  assert.equal(f.calls.length, 0);
});
