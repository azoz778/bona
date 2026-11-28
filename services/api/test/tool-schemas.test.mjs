/**
 * PR-B4 (PLAN T13 tests 3 and 4; DESIGN §4.3-4.4; brain/DESIGN-brain.md §3.1, §6.2): the tools the
 * brain offers per route, as OpenAI strict functions, and the prompt rules that go with them. These
 * replace PR-BR's seed test, which pinned today's three WhatsApp tools word for word to the Retell
 * payload (retell/provision.mjs whatsappToolsPayload, which stays frozen for the legacy agent until
 * T27). Both files are behaviour: bona-api loads them at start (PLAN §0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TOOL_SCHEMAS, ROUTE_TOOLS, toolsFor, routeToolNames, schemaArgNames } from '../lib/brain/tool-schemas.mjs';
import { TOOL_NAMES } from '../lib/tools.mjs';
import { loadPrompts, systemPrompt } from '../lib/brain/prompt.mjs';
import { identity } from '../lib/persona.mjs';

const WA = ['search_properties', 'search_units', 'listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs', 'request_human'];
const MAIL = ['search_properties', 'search_units', 'listing_details', 'save_needs', 'request_human'];
const NEW = ['listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs'];
const KINDS = ['person', 'offer', 'complaint', 'contract', 'selling', 'viewing', 'other', 'stop', 'privacy', 'deletion'];
const RETELL_ONLY = ['"url"', '"headers"', 'timeout_ms', 'speak_', 'execution_message', 'X-Bona-Token'];

test('the WhatsApp route offers exactly the nine tools; the email route the five read-and-save ones; web nothing yet (T28)', () => {
  assert.deepEqual(routeToolNames('wa'), WA);
  assert.deepEqual(toolsFor('wa').map((t) => t.function.name), WA);
  assert.deepEqual(routeToolNames('mail'), MAIL);
  assert.deepEqual(toolsFor('mail').map((t) => t.function.name), MAIL);
  assert.deepEqual(routeToolNames('web'), []);
  assert.deepEqual(toolsFor('web'), []);
  assert.deepEqual(routeToolNames('sms'), []);
  assert.deepEqual(Object.keys(ROUTE_TOOLS).sort(), ['mail', 'wa']);
  assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...WA].sort(), 'one schema per offered tool, nothing else');
  for (const n of NEW) assert.ok(TOOL_NAMES.includes(n), `${n} has a handler name (TOOL_NAMES)`);
  // The handler map has create_lead and show_property too: never offered to the brain.
  for (const n of ['create_lead', 'show_property']) assert.equal(WA.includes(n) || MAIL.includes(n), false, n);
  assert.deepEqual(toolsFor('wa', ['search_properties', 'create_lead', 'show_property']).map((t) => t.function.name), ['search_properties'], 'only offered and known');
  assert.deepEqual(toolsFor('mail', ['book_viewing', 'save_needs']).map((t) => t.function.name), ['save_needs'], 'no booking by email');
});

test('every schema is a strict function: every property required, optional ones nullable, no additional properties, keys sorted, no Retell-only field', () => {
  for (const route of ['wa', 'mail']) {
    for (const tool of toolsFor(route)) {
      const name = tool.function.name;
      const src = TOOL_SCHEMAS[name].parameters;
      assert.equal(tool.type, 'function');
      assert.equal(tool.function.strict, true, name);
      assert.equal(typeof tool.function.description, 'string');
      assert.ok(tool.function.description.length > 40, `${name} has a real description`);
      const p = tool.function.parameters;
      assert.equal(p.type, 'object');
      assert.equal(p.additionalProperties, false, `${name}: additionalProperties false`);
      assert.deepEqual(Object.keys(p.properties), Object.keys(src.properties).sort(), `${name}: keys sorted`);
      assert.deepEqual(p.required, Object.keys(p.properties), `${name}: strict, every property required`);
      for (const [k, spec] of Object.entries(p.properties)) {
        const optional = !(src.required ?? []).includes(k);
        assert.deepEqual(spec.type, optional ? [src.properties[k].type, 'null'] : src.properties[k].type, `${name}.${k}`);
        assert.equal(typeof spec.description, 'string', `${name}.${k} is described`);
      }
      const json = JSON.stringify(tool);
      for (const f of RETELL_ONLY) assert.equal(json.includes(f), false, `${name}: no ${f}`);
      assert.deepEqual(schemaArgNames(name), Object.keys(src.properties));
    }
  }
  assert.equal(JSON.stringify(toolsFor('wa')), JSON.stringify(toolsFor('wa')), 'byte-stable (one cached prefix)');
});

test('the new tools take the arguments DESIGN §4.3 names, and only those', () => {
  const props = (n) => Object.keys(TOOL_SCHEMAS[n].parameters.properties).sort();
  const req = (n) => [...(TOOL_SCHEMAS[n].parameters.required ?? [])].sort();
  assert.deepEqual(props('listing_details'), ['listing_id']);
  assert.deepEqual(req('listing_details'), ['listing_id']);
  assert.deepEqual(props('viewing_slots'), ['listing_id']);
  assert.deepEqual(req('viewing_slots'), ['listing_id']);
  assert.deepEqual(props('book_viewing'), ['listing_id', 'name', 'slot_id']);
  assert.deepEqual(req('book_viewing'), ['listing_id', 'slot_id'], 'the name is optional (the lead may have one)');
  assert.deepEqual(props('send_brochure'), ['listing_id']);
  assert.deepEqual(props('send_location'), ['listing_id']);
  assert.deepEqual(props('save_needs'), ['budget', 'district', 'interest', 'listing_id', 'name', 'property_type', 'timeline']);
  assert.deepEqual(req('save_needs'), [], 'everything is optional: only what the client said');
});

test("request_human gains `kind` (DESIGN §4.3's ten values, required) and drops 'see or visit': viewings are booked, not handed over", () => {
  const rh = TOOL_SCHEMAS.request_human;
  assert.deepEqual(rh.parameters.properties.kind.enum, KINDS);
  assert.ok(rh.parameters.required.includes('kind'), 'the model always says which kind (dana-wa reads it from the raw call)');
  assert.ok(rh.parameters.required.includes('reason'));
  assert.doesNotMatch(rh.description, /see or visit/i);
  assert.doesNotMatch(rh.description, /\bvisit\b/i);
  for (const k of ['stop', 'privacy', 'delet']) assert.match(rh.description + rh.parameters.properties.kind.description, new RegExp(k, 'i'), k);
  const strict = toolsFor('wa').find((t) => t.function.name === 'request_human').function.parameters.properties.kind;
  assert.deepEqual(strict.type, 'string', 'required: not nullable');
  assert.deepEqual(strict.enum, KINDS);
});

test("search_units describes the published per-bedroom 'from' summary: no exact per-unit price, no unit reference, no payment-plan filter", () => {
  const su = TOOL_SCHEMAS.search_units;
  assert.doesNotMatch(su.description, /exact price/i);
  assert.doesNotMatch(su.description, /B\d{2}-\d+/, 'no unit reference shape');
  assert.doesNotMatch(su.description, /\bWHICH units\b|per-unit stock list/i);
  assert.match(su.description, /from/i);
  assert.match(su.description, /bedroom/i);
  assert.match(su.description, /not published/i);
  assert.deepEqual(Object.keys(su.parameters.properties), ['listing_id'], 'the handler ignores filters (DESIGN §4.5): none is offered, plan least of all');
  assert.equal(JSON.stringify(su).includes('twoYear'), false);
});

test('no schema text names the assistant or promises a confirmed booking', () => {
  const all = JSON.stringify(TOOL_SCHEMAS);
  assert.doesNotMatch(all, /(?<![\p{L}])(?:dana|دانة)(?![\p{L}])/iu);
  assert.match(TOOL_SCHEMAS.book_viewing.description, /never (?:say|state)[^.]*(?:booked|confirmed)/i);
  assert.match(TOOL_SCHEMAS.book_viewing.description, /the system sends the confirmation/i);
});

/* ---------------- the prompt (PLAN T13 test 4; DESIGN §4.4) ---------------- */

const { assistant } = loadPrompts();
const render = (o) => systemPrompt({ template: assistant, route: 'wa', siteFacts: 'FACTS', identity: identity(o) });

test('prompts/assistant.md: the booking, brochure, location, needs and hand-over rules of DESIGN §4.4 are present', () => {
  const wa = render();
  const phrases = [
    // the tools
    'listing_details', 'viewing_slots', 'book_viewing', 'send_brochure', 'send_location', 'save_needs',
    // the booking flow (only the code's confirmation states a time)
    'offer 3 or 4 of its dated slots in one message', 'ask for it in that same message',
    'never say it is booked or confirmed', 'the system sends the confirmation', 'request_human with kind viewing',
    // save_needs, then "noted" is allowed (old :31 reversed)
    'سجّلت طلبك',
    // stop / privacy / deletion → request_human(kind)
    'kind stop, privacy or deletion',
    // after a hand-over
    'keep answering published facts if asked, but not the topic you handed over',
    // hours (old :112)
    'You answer at any hour', 'viewings are Sunday to Thursday, 10:00–19:00',
    // the knowledge (old :115-116)
    'the site facts and listing_details',
    // DESIGN §4.4 "Add"
    'Do not introduce yourself', 'the first reply at most two sentences plus one question', 'at most one question',
  ];
  for (const s of phrases) assert.ok(wa.includes(s), `missing: ${s}`);
  // The voice-note and call lines (DESIGN §4.1).
  assert.match(wa, /A voice note, photo or file you cannot open: the first time, kindly ask them to type it; the second time, hand over/);
  assert.match(wa, /A call, or a message that only says \[message\]: say you cannot take calls here and ask them to write/);
});

test('prompts/assistant.md: the old :31 and :75 lines are gone (no "never say noted"; see/visit is viewing_slots, not a hand-over)', () => {
  assert.doesNotMatch(assistant, /never say you have "?noted/i);
  assert.doesNotMatch(assistant, /asks to see or visit a home/i);
  assert.doesNotMatch(assistant, /or to book anything/i);
  assert.doesNotMatch(assistant, /no promised viewing time/i, 'a viewing time is the booking flow now, stated by code only');
  // see/visit sits in the viewing line, which names viewing_slots.
  const visit = assistant.split('\n').filter((l) => /see or visit/i.test(l));
  assert.ok(visit.length >= 1 && visit.every((l) => l.includes('viewing_slots')), 'see or visit → viewing_slots');
});

test('prompts/assistant.md: nameless (only the identity line says "never call yourself Dana"), the identity has no personal name, the Jeddah register stays', () => {
  const NAME_RE = /(?<![\p{L}])(?:dana|دانة)(?![\p{L}])/iu;
  assert.doesNotMatch(assistant, NAME_RE, 'the template itself has no name at all');
  const wa = render();
  assert.doesNotMatch(wa.replace('never call yourself Dana or دانة', ''), NAME_RE);
  assert.match(wa, /You have no personal name; never give yourself one/);
  for (const s of ['إيش', 'أبغى', 'دحين', 'كمان', 'تمام', 'طيب', 'أبشر', 'من عيوني', 'Jeddah Hijazi', 'speak of yourself in the feminine']) assert.ok(wa.includes(s), s);
  assert.doesNotMatch(wa, /\{\{/);
  const lines = assistant.trim().split('\n').length;
  assert.ok(lines >= 30 && lines <= 70, `~50 lines, not ${lines}`);
  assert.ok(fs.existsSync(new URL('../prompts/assistant.md', import.meta.url)));
});

test('the viewing lines ask for the name when the record has no PLAUSIBLE name, as viewing_slots answers ask_name (Codex r4 P1)', () => {
  const wa = render();
  assert.match(wa, /if the client record has no plausible name for them \(viewing_slots says ask_name\), ask for it in that same message/);
  assert.match(TOOL_SCHEMAS.viewing_slots.description, /ask_name/);
});

test('the viewing line asks for the name on need_name and hands over only for another refusal (Codex r5 P2: the prompt agreed with the tool)', () => {
  const wa = render();
  assert.match(wa, /If book_viewing answers need_name, ask for their name and call it again; this is no hand-over\./);
  assert.match(wa, /If the client has not picked a slot yet, ask which one suits them\./);
  assert.match(wa, /Only when viewing_slots or book_viewing refuse for any other reason, call request_human with kind viewing\./);
  assert.doesNotMatch(wa, /If viewing_slots or book_viewing cannot book it, call request_human/);
});
