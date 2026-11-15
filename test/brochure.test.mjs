import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listingCard } from '../src/components/concierge/render.ts';
const url = 'https://bona-real-estate.com/listings/trump-tower-jeddah/brochure.pdf';
class El {
 constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; }
 append(...nodes) { this.children.push(...nodes); }
 setAttribute(k,v) { this.attrs[k] = v; }
}
test('concierge has separate accessible brochure and property links in both locales', () => {
 globalThis.document = { createElement: t => new El(t), createElementNS: (_,t) => new El(t) };
 globalThis.window = { location: { origin: 'https://bona-real-estate.com' } };
 for (const locale of ['en', 'ar']) {
  const cfg = { locale, propertiesBase: '/properties/', strings: { view: 'View' } };
  const card = { id: 'BONA-022', slug: 'trump-tower-jeddah', title: { en: 'Trump Tower', ar: 'برج ترامب' }, brochureUrl: url };
  const article = listingCard(card, cfg);
  assert.equal(article.children.length, 2);
  const a = article.children[1]; assert.equal(a.tag, 'a'); assert.equal(a.href, url);
  assert.match(a.textContent, /1003/); assert.match(a.textContent, locale === 'ar' ? /تحميل/ : /Download/);
  assert.match(a.attrs.download, /\.pdf$/);
  assert.equal(listingCard({ ...card, brochureUrl: null }, cfg).children.length, 1);
  assert.equal(listingCard({ ...card, brochureUrl: 'javascript:alert(1)' }, cfg).children.length, 1);
 }
});
test('build preserves the exact supplied Bona PDF', () => {
 const relative = 'listings/trump-tower-jeddah/brochure.pdf';
 const supplied = readFileSync(`public/${relative}`);
 assert.equal(supplied.subarray(0,5).toString(), '%PDF-');
 assert.deepEqual(readFileSync(`dist/${relative}`), supplied);
 const listings = JSON.parse(readFileSync('src/data/listings.json'));
 assert.equal(listings.filter(l => l.id === 'BONA-022').length, 1);
 assert.equal(listings.find(l => l.id === 'BONA-022').brochureUrl, url);
});
