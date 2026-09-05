#!/usr/bin/env node
/* Local stand-in for the concierge API (spec §3) — development only, never part of the site build.
 *
 *   node scripts/dev/concierge-stub.mjs [--port 4102]
 *   npm run preview   # then open http://localhost:4321/?concierge_api=http://localhost:4102
 *
 * Canned but contract-shaped: a greeting, a reply that carries one `show_listing` Card built from
 * src/data/listings.json, a `navigate` action for "show me houses", a `whatsapp` action, a fake call
 * token (so the Call tab exercises its failure path) and a call-context endpoint.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const listings = JSON.parse(readFileSync(join(repo, 'src/data/listings.json'), 'utf8'));

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.PORT || 4102);

const started = Date.now();
const sessions = new Map();
const calls = new Map();

/* ------------------------------------------------------------------ helpers */

const money = (n) => new Intl.NumberFormat('en-US').format(n);

function priceText(p, locale) {
  if (!p || p.onRequest || p.amount == null) return locale === 'ar' ? 'السعر عند الطلب' : 'Price on request';
  const cur = p.currency === 'SAR' ? (locale === 'ar' ? 'ر.س' : 'SAR') : p.currency;
  const core = locale === 'ar' ? `${money(p.amount)} ${cur}` : `${cur} ${money(p.amount)}`;
  const from = p.from ? (locale === 'ar' ? 'ابتداءً من ' : 'From ') : '';
  const per = p.period ? (locale === 'ar' ? (p.period === 'year' ? ' / سنوياً' : ' / شهرياً') : ` / ${p.period}`) : '';
  return `${from}${core}${per}`;
}

/** Card shape from the spec: { id, slug, title, district, price, beds, baths, areaSqm, image, url }. */
function card(l) {
  return {
    id: l.id,
    slug: l.slug,
    title: l.title,
    district: l.location.district,
    price: { en: priceText(l.price, 'en'), ar: priceText(l.price, 'ar') },
    beds: l.specs?.beds ?? null,
    baths: l.specs?.baths ?? null,
    areaSqm: l.specs?.areaSqm ?? l.specs?.plotSqm ?? null,
    image: l.images?.[0] ? { src: l.images[0].src, thumb: l.images[0].thumb ?? l.images[0].src } : null,
    url: { en: `/properties/${l.slug}/`, ar: `/ar/properties/${l.slug}/` },
  };
}

const kindOf = (l) => l.kind || (['apartment', 'penthouse'].includes(l.type) ? 'apartment' : ['land'].includes(l.type) ? 'land' : ['building'].includes(l.type) ? 'building' : 'house');
const pick = (kind) => listings.find(l => kindOf(l) === kind && l.status === 'available') || listings[0];

const path = (locale, p) => (locale === 'ar' ? `/ar${p}` : p);

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(payload);
}

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 16384) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

/* -------------------------------------------------------------------- replies */

function reply(text, locale) {
  const q = (text || '').toLowerCase();
  const has = (...words) => words.some(w => q.includes(w));

  const wantsApartment = has('apartment', 'penthouse', 'شقة', 'شقق', 'بنتهاوس');

  if (!wantsApartment && has('house', 'villa', 'منزل', 'منازل', 'فيلا', 'فلل')) {
    return {
      messages: [{ role: 'agent', text: locale === 'ar' ? 'بكل سرور. سأفتح لك صفحة المنازل التي نمثّلها الآن.' : 'With pleasure. Let me open the houses we are representing.' }],
      actions: [{ type: 'navigate', path: path(locale, '/properties/houses/') }],
    };
  }

  if (has('person', 'human', 'someone', 'whatsapp', 'شخص', 'واتساب', 'أحد')) {
    return {
      messages: [{ role: 'agent', text: locale === 'ar' ? 'بالطبع. راسل أحد شركاء الدار مباشرة على واتساب وسيردّ عليك شخصياً.' : 'Of course. Write to a principal directly on WhatsApp and they will reply personally.' }],
      actions: [{ type: 'whatsapp', message: locale === 'ar' ? 'مرحباً بونا، أرغب في التحدّث مع أحد الشركاء.' : 'Hello Bona, I would like to speak with a principal.' }],
    };
  }

  const l = pick(wantsApartment ? 'apartment' : 'house');
  const district = l.location.district[locale] || l.location.district.en;
  return {
    messages: [{
      role: 'agent',
      text: locale === 'ar'
        ? `هذا أقرب ما لدينا لطلبك — ${district}. أخبرني إن أعجبك وسأرتّب لك معاينة.`
        : `This is the closest thing we hold to what you describe — ${district}. Tell me if it appeals and I will arrange a viewing.`,
    }],
    actions: [{ type: 'show_listing', listing: card(l) }],
  };
}

/* --------------------------------------------------------------------- routes */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return send(res, 204, {});
  console.log(`${req.method} ${route}`);

  if (route === '/health') {
    return send(res, 200, { ok: true, service: 'bona-api-stub', version: '0.0.0-stub', uptimeS: Math.round((Date.now() - started) / 1000), retell: 'stub', inventory: listings.length });
  }

  if (route === '/v1/chat/session' && req.method === 'POST') {
    const { locale = 'en' } = await readBody(req);
    const sessionId = `sess_stub_${Math.random().toString(36).slice(2, 10)}`;
    sessions.set(sessionId, { locale, at: Date.now() });
    await new Promise(r => setTimeout(r, 250));
    return send(res, 200, {
      sessionId,
      greeting: locale === 'ar'
        ? 'مرحباً، أنا دانة من بونا. كيف أقدر أساعدك اليوم؟'
        : "Hello, I'm Dana from Bona. How can I help you today?",
    });
  }

  if (route === '/v1/chat/message' && req.method === 'POST') {
    const { sessionId, text = '', locale = 'en' } = await readBody(req);
    if (!sessionId || !sessions.has(sessionId)) return send(res, 400, { error: 'unknown session' });
    await new Promise(r => setTimeout(r, 600));
    return send(res, 200, reply(text, locale));
  }

  if (route === '/v1/chat/end' && req.method === 'POST') {
    const { sessionId } = await readBody(req);
    sessions.delete(sessionId);
    return send(res, 200, { ok: true });
  }

  if (route === '/v1/call/token' && req.method === 'POST') {
    const { locale = 'en' } = await readBody(req);
    const callId = `call_stub_${Math.random().toString(36).slice(2, 10)}`;
    calls.set(callId, { locale, at: Date.now() });
    await new Promise(r => setTimeout(r, 300));
    // Deliberately not a real Retell token: the widget must fail gracefully into its phone/WhatsApp fallback.
    return send(res, 200, { accessToken: `stub-access-token-${callId}`, callId });
  }

  const ctx = route.match(/^\/v1\/call\/([^/]+)\/context$/);
  if (ctx) {
    const cards = [pick('house'), pick('apartment')].filter(Boolean).map(card);
    return send(res, 200, { listings: cards, updatedAt: new Date().toISOString() });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bona concierge stub on http://127.0.0.1:${PORT}  (${listings.length} listings)`);
  console.log(`point the widget at it:  http://localhost:4321/?concierge_api=http://127.0.0.1:${PORT}`);
});
