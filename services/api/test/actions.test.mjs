import test from 'node:test';
import assert from 'node:assert/strict';
import { extractActions, stripMarkers, safePath, plainText } from '../lib/actions.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';

const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const KHALIDIYAH = inventory.all().find((l) => l.location.district.en === 'Al Khalidiyah');

test('agent text becomes a message', () => {
  const out = extractActions([{ role: 'agent', content: 'Of course. Which district?' }], { inventory });
  assert.deepEqual(out.messages, [{ role: 'agent', text: 'Of course. Which district?' }]);
  assert.deepEqual(out.actions, []);
  assert.equal(out.leadCaptured, undefined);
});

test('user, node_transition and other roles never reach the visitor', () => {
  const out = extractActions([
    { role: 'user', content: 'hello' },
    { role: 'node_transition', new_node_name: 'x' },
    { role: 'state_transition', new_state_name: 'y' },
    { role: 'agent', content: 'أهلاً بك.' },
  ], { inventory });
  assert.deepEqual(out.messages, [{ role: 'agent', text: 'أهلاً بك.' }]);
});

test('show_property becomes a show_listing action with a full Card', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'show_property', arguments: JSON.stringify({ id: KHALIDIYAH.id }) },
    { role: 'tool_call_result', tool_call_id: 't1', content: '{"shown":true}' },
    { role: 'agent', content: 'This one sits in Al Khalidiyah.' },
  ], { inventory });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].type, 'show_listing');
  assert.equal(out.actions[0].listing.id, KHALIDIYAH.id);
  assert.equal(out.actions[0].listing.url.ar, `https://bona.azoz.uk/ar/properties/${KHALIDIYAH.slug}/`);
});

test('search_properties results become up to three cards, in result order', () => {
  const rows = inventory.search({ query: 'villa in Al Khalidiyah' }).map((l) => inventory.row(l));
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: '{"district":"Al Khalidiyah"}' },
    { role: 'tool_call_result', tool_call_id: 't1', content: JSON.stringify({ count: rows.length, results: rows }) },
    { role: 'agent', content: 'Two homes match.' },
  ], { inventory });
  assert.equal(out.actions.length, 3);
  assert.equal(out.actions[0].listing.id, rows[0].id);
  assert.ok(out.actions.every((a) => a.type === 'show_listing'));
});

test('a search whose result carried no ids still surfaces cards (voice path)', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: '{"query":"villa in Al Khalidiyah"}' },
    { role: 'tool_call_result', tool_call_id: 't1', content: 'ok' },
    { role: 'agent', content: 'We have two.' },
  ], { inventory });
  assert.ok(out.actions.length > 0);
  assert.equal(out.actions[0].listing.district.en, 'Al Khalidiyah');
});

test('a property that is not in inventory produces no card', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'show_property', arguments: '{"id":"BONA-999"}' },
    { role: 'agent', content: 'Let me check.' },
  ], { inventory });
  assert.deepEqual(out.actions, []);
});

test('create_lead sets leadCaptured', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'create_lead', arguments: '{"phone":"+966500000000"}' },
    { role: 'tool_call_result', tool_call_id: 't1', content: '{"saved":true}' },
    { role: 'agent', content: 'Noted — a principal will call you.' },
  ], { inventory });
  assert.equal(out.leadCaptured, true);
});

test('[[…]] markers are parsed into actions and stripped from the text', () => {
  const out = extractActions([
    { role: 'agent', content: 'Here are our houses. [[navigate:/properties/houses/]]' },
  ], { inventory });
  assert.equal(out.messages[0].text, 'Here are our houses.');
  assert.deepEqual(out.actions, [{ type: 'navigate', path: '/properties/houses/' }]);
});

test('a whatsapp marker becomes a whatsapp action', () => {
  const out = extractActions([{ role: 'agent', content: 'أقدر أوصلك بأحد الشركاء. [[whatsapp:مرحباً، أبغى أكلم أحد من بونا]]' }], { inventory });
  assert.equal(out.actions[0].type, 'whatsapp');
  assert.equal(out.actions[0].message, 'مرحباً، أبغى أكلم أحد من بونا');
  assert.ok(!out.messages[0].text.includes('[['));
});

test('a [[show:…]] marker resolves against inventory', () => {
  const out = extractActions([{ role: 'agent', content: `Take a look. [[show:${KHALIDIYAH.slug}]]` }], { inventory });
  assert.equal(out.actions[0].type, 'show_listing');
  assert.equal(out.actions[0].listing.slug, KHALIDIYAH.slug);
});

test('unknown or malformed markers are stripped, never shown', () => {
  const { text, actions } = stripMarkers('Hello [[weird]] there [[navigate:javascript:alert(1)]] [[]]');
  assert.ok(!text.includes('[['));
  assert.deepEqual(actions, []);
});

test('safePath refuses anything that is not a same-site path', () => {
  assert.equal(safePath('/properties/houses/'), '/properties/houses/');
  assert.equal(safePath('https://bona.azoz.uk/ar/tours/'), '/ar/tours/');
  assert.equal(safePath('//evil.example/x'), null);
  assert.equal(safePath('javascript:alert(1)'), null);
  assert.equal(safePath('/../etc/passwd'), null);
  assert.equal(safePath(''), null);
});

test('cards come before whatsapp and navigate actions', () => {
  const out = extractActions([
    { role: 'agent', content: 'One moment. [[navigate:/properties/]] [[whatsapp:hi]]' },
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'show_property', arguments: JSON.stringify({ id: KHALIDIYAH.id }) },
  ], { inventory });
  assert.deepEqual(out.actions.map((a) => a.type), ['show_listing', 'whatsapp', 'navigate']);
});

test('the same property is never shown twice', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'show_property', arguments: JSON.stringify({ id: KHALIDIYAH.id }) },
    { role: 'tool_call_invocation', tool_call_id: 't2', name: 'show_property', arguments: JSON.stringify({ slug: KHALIDIYAH.slug }) },
  ], { inventory });
  assert.equal(out.actions.length, 1);
});

test('malformed tool arguments do not throw', () => {
  const out = extractActions([
    { role: 'tool_call_invocation', tool_call_id: 't1', name: 'show_property', arguments: '{not json' },
    { role: 'agent', content: 'ok' },
  ], { inventory });
  assert.deepEqual(out.actions, []);
  assert.equal(out.messages[0].text, 'ok');
});

test('an empty completion yields no messages (the route supplies the fallback)', () => {
  assert.deepEqual(extractActions([], { inventory }), { messages: [], actions: [] });
  assert.deepEqual(extractActions(null, { inventory }), { messages: [], actions: [] });
});

test('plainText flattens the markdown Retell models emit into plain text', () => {
  const md = '**فيلا عصرية، الخالدية — BONA-005**\n5 غرف · 8 حمامات\nالسعر: **6,700,000 ريال**\n\n### Why\n- Private pool\n- *Glass* lift\n1. first\nSee [the page](https://bona.azoz.uk/properties/x/).';
  const out = plainText(md);
  assert.equal(out.includes('**'), false);
  assert.equal(out.includes('###'), false);
  assert.match(out, /^فيلا عصرية، الخالدية — BONA-005$/m);
  assert.match(out, /^• Private pool$/m);
  assert.match(out, /^• Glass lift$/m);
  assert.match(out, /^1\. first$/m);
  assert.match(out, /the page \(https:\/\/bona\.azoz\.uk\/properties\/x\/\)/);
  assert.equal(plainText('4 * 5 = 20 and a_b_c stay'), '4 * 5 = 20 and a_b_c stay');
});
