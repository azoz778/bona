/**
 * Provisioning tests. Nothing here contacts Retell — every client is a double.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  knowledgeBasePayload, knowledgeBaseFreshness, toolsPayload, llmPayload, voiceAgentPayload,
  chatAgentPayload, redactPayload, provision, PROMPT_FILE, PREFERRED_MODEL, FALLBACK_MODEL,
  BEGIN_MESSAGE, KB_NAME, VOICE_AGENT_NAME, CHAT_AGENT_NAME,
} from '../retell/provision.mjs';
import { writeIds } from '../lib/config.mjs';

const TOKEN = 'b'.repeat(32);
/** Derived, never hard-coded: adding a tool must not fail an unrelated assertion. */
const TOOL_COUNT = toolsPayload({ publicApi: 'https://example.invalid', toolToken: TOKEN }).length;
const PUBLIC_API = 'https://bona-api.azoz.uk';
const OLD_SITE = 'https://bona.azoz.uk';
const NEW_SITE = 'https://bona-real-estate.com';
/** What Retell reports back for a knowledge base once it has finished indexing. */
const urlSources = (site) => knowledgeBasePayload({ siteUrl: site }).knowledge_base_urls
  .map((url, i) => ({ type: 'url', source_id: `src_${i}`, url }));
const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-prov-'));
  return { home, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/* ---------------- payloads ---------------- */

test('the knowledge base points at both llms files with auto-refresh on', () => {
  const kb = knowledgeBasePayload({ siteUrl: 'https://bona.azoz.uk/' });
  assert.equal(kb.knowledge_base_name, KB_NAME);
  assert.deepEqual(kb.knowledge_base_urls, ['https://bona.azoz.uk/llms-full.txt', 'https://bona.azoz.uk/llms.txt']);
  assert.equal(kb.enable_auto_refresh, true);
});

test('a knowledge base indexing the configured site reads back as fresh', () => {
  const kb = { knowledge_base_id: 'kb_1', knowledge_base_sources: urlSources(NEW_SITE), status: 'complete' };
  const freshness = knowledgeBaseFreshness(kb, { siteUrl: NEW_SITE });
  assert.equal(freshness.known, true);
  assert.equal(freshness.stale, false);
});

test('a knowledge base left on the old domain reads back as stale', () => {
  const kb = { knowledge_base_id: 'kb_1', knowledge_base_sources: urlSources(OLD_SITE), status: 'complete' };
  const freshness = knowledgeBaseFreshness(kb, { siteUrl: NEW_SITE });
  assert.equal(freshness.stale, true);
  assert.deepEqual(freshness.urls, [`${OLD_SITE}/llms-full.txt`, `${OLD_SITE}/llms.txt`]);
  assert.deepEqual(freshness.wanted, [`${NEW_SITE}/llms-full.txt`, `${NEW_SITE}/llms.txt`]);
});

test('a knowledge base still indexing is unknown, not accused of being stale', () => {
  const freshness = knowledgeBaseFreshness({ knowledge_base_id: 'kb_1', status: 'in_progress' }, { siteUrl: NEW_SITE });
  assert.equal(freshness.known, false);
  assert.equal(freshness.stale, false, 'Retell fills the sources in only when indexing finishes');
});

test('the tool token travels in a header, never in the URL', () => {
  const tools = toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN });
  for (const t of tools) {
    assert.equal(t.headers['X-Bona-Token'], TOKEN, `${t.name} must authenticate itself`);
    assert.equal(t.url.includes('token='), false, `${t.name} leaks the token into logs`);
    assert.equal(t.url.includes(TOKEN), false);
  }
});

test('a dry run prints no secret, header included', () => {
  const printed = JSON.stringify(redactPayload(toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN }), TOKEN));
  assert.equal(printed.includes(TOKEN), false);
  assert.ok(printed.includes('<BONA_TOOL_TOKEN>'));
});

test('every tool is a custom webhook on the public API', () => {
  const tools = toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN });
  assert.deepEqual(tools.map((t) => t.name), ['search_properties', 'show_property', 'search_units', 'create_lead']);
  for (const t of tools) {
    assert.equal(t.type, 'custom');
    assert.equal(t.url, `${PUBLIC_API}/v1/tools/${t.name}`);
    assert.equal(t.parameters.type, 'object');
    assert.ok(t.description.length > 40, `${t.name} needs a description the model can act on`);
    assert.ok(t.timeout_ms >= 1000 && t.timeout_ms <= 600_000);
  }
});

test('only the slow tools talk while they run; all of them speak after', () => {
  // Looked up by name, not by position: adding a tool must not rewrite this test.
  const byName = Object.fromEntries(toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN }).map((t) => [t.name, t]));
  assert.equal(byName.search_properties.speak_during_execution, true, 'a search must not leave silence on a call');
  assert.ok(byName.search_properties.execution_message_description.length > 20);
  assert.equal(byName.search_units.speak_during_execution, true, 'a unit lookup is a search too — do not go quiet mid-call');
  assert.equal(byName.show_property.speak_during_execution, false);
  assert.equal(byName.create_lead.speak_during_execution, false);
  for (const t of Object.values(byName)) assert.equal(t.speak_after_execution, true);
});

test('search_units filters on what a buyer actually asks for', () => {
  const units = toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN }).find((t) => t.name === 'search_units');
  for (const k of ['listing_id', 'beds', 'building', 'floor', 'facing', 'max_price', 'plan']) {
    assert.ok(units.parameters.properties[k], `missing ${k}`);
  }
  assert.deepEqual(units.parameters.properties.plan.enum, ['cash', 'half', 'year', 'twoYear']);
  assert.deepEqual(units.parameters.required, [], 'every filter is optional — the model may just ask what exists');
});

test('create_lead requires a phone number and offers the fields the owner needs', () => {
  const lead = toolsPayload({ publicApi: PUBLIC_API, toolToken: TOKEN }).find((t) => t.name === 'create_lead');
  assert.deepEqual(lead.parameters.required, ['phone']);
  for (const k of ['phone', 'name', 'interest', 'budget', 'timeline', 'notes', 'language']) {
    assert.ok(lead.parameters.properties[k], `missing ${k}`);
  }
});

test('the LLM carries the persona, the begin message, the KB and the tools', () => {
  const llm = llmPayload({ prompt, model: PREFERRED_MODEL, knowledgeBaseIds: ['kb_1'], publicApi: PUBLIC_API, toolToken: TOKEN });
  assert.equal(llm.model, PREFERRED_MODEL);
  assert.equal(llm.start_speaker, 'agent');
  assert.equal(llm.begin_message, BEGIN_MESSAGE);
  assert.match(llm.begin_message, /دانة/);
  assert.match(llm.begin_message, /Dana/);
  assert.deepEqual(llm.knowledge_base_ids, ['kb_1']);
  assert.equal(llm.general_tools.length, TOOL_COUNT);
  assert.equal(llm.general_prompt, prompt);
});

test('the persona states the rules the owner cannot have broken', () => {
  assert.match(prompt, /Never estimate/i);
  assert.match(prompt, /TAQEEM/);
  assert.match(prompt, /Never invent a property/i);
  assert.match(prompt, /1100313556/, 'the FAL licence number');
  assert.match(prompt, /\+966 59 329 6933/);
  assert.match(prompt, /Sunday–Thursday, 10:00–19:00/);
  assert.match(prompt, /AI concierge/i);
  assert.match(prompt, /\{\{locale\}\}/);
  assert.match(prompt, /\{\{page_url\}\}/);
  assert.match(prompt, /\{\{page_title\}\}/);
});

test('the persona never mentions TK', () => {
  const rule = /4\. \*\*Never mention[\s\S]*?only firm you know\./;
  assert.match(prompt, rule, 'the rule forbidding TK must exist');
  const rest = prompt.replace(rule, '');
  assert.equal(/\bTK\b/.test(rest), false, 'TK may appear only inside the rule forbidding it');
});

test('no knowledge base id means the field is omitted rather than sent empty', () => {
  const llm = llmPayload({ prompt, model: FALLBACK_MODEL, knowledgeBaseIds: [], publicApi: PUBLIC_API, toolToken: TOKEN });
  assert.equal('knowledge_base_ids' in llm, false);
});

test('the voice agent matches the spec: Nyla, flash v2.5, AR+EN, 15 min, webhook', () => {
  const agent = voiceAgentPayload({ llmId: 'llm_1', publicApi: PUBLIC_API, toolToken: TOKEN });
  assert.equal(agent.agent_name, VOICE_AGENT_NAME);
  assert.deepEqual(agent.response_engine, { type: 'retell-llm', llm_id: 'llm_1' });
  assert.equal(agent.voice_id, '11labs-Nyla');
  assert.equal(agent.voice_model, 'eleven_flash_v2_5');
  assert.deepEqual(agent.language, ['ar-SA', 'en-US']);
  assert.equal(agent.responsiveness, 1);
  assert.equal(agent.interruption_sensitivity, 0.8);
  assert.equal(agent.enable_backchannel, true);
  assert.equal(agent.end_call_after_silence_ms, 30_000);
  assert.equal(agent.max_call_duration_ms, 900_000);
  assert.equal(agent.webhook_url, `${PUBLIC_API}/v1/retell/webhook?token=${TOKEN}`);
  assert.deepEqual(agent.webhook_events, ['call_started', 'call_ended', 'call_analyzed']);
});

test('the chat agent shares the same LLM and gets chat webhook events', () => {
  const agent = chatAgentPayload({ llmId: 'llm_1', publicApi: PUBLIC_API, toolToken: TOKEN });
  assert.equal(agent.agent_name, CHAT_AGENT_NAME);
  assert.deepEqual(agent.response_engine, { type: 'retell-llm', llm_id: 'llm_1' });
  assert.deepEqual(agent.language, ['ar-SA', 'en-US']);
  assert.deepEqual(agent.webhook_events, ['chat_started', 'chat_ended', 'chat_analyzed']);
});

test('redaction removes the tool token from anything printed', () => {
  const printed = redactPayload(voiceAgentPayload({ llmId: 'l', publicApi: PUBLIC_API, toolToken: TOKEN }), TOKEN);
  assert.ok(!JSON.stringify(printed).includes(TOKEN));
  assert.match(printed.webhook_url, /<BONA_TOOL_TOKEN>/);
});

/* ---------------- runs ---------------- */

function fakeClient({ rejectModels = [], existing = {} } = {}) {
  // `order` is what proves the KB swap is safe: it records the calls as they arrive, so a
  // test can insist the old base is deleted only after the LLM points at the new one.
  const seen = { created: [], updated: [], published: [], deleted: [], order: [] };
  const client = {
    seen,
    async listKnowledgeBases() { return existing.kb ? [existing.kb] : []; },
    async getKnowledgeBase(id) { if (existing.kb?.knowledge_base_id === id) return existing.kb; throw new Error('404'); },
    async createKnowledgeBase(body) { seen.created.push(['kb', body]); seen.order.push('create-kb'); return { knowledge_base_id: 'kb_new', status: 'in_progress' }; },
    async deleteKnowledgeBase(id) { seen.deleted.push(id); seen.order.push('delete-kb'); return null; },
    async createLlm(body) {
      if (rejectModels.includes(body.model)) throw Object.assign(new Error('bad model'), { name: 'RetellError', status: 400 });
      seen.created.push(['llm', body]);
      seen.order.push('create-llm');
      return { llm_id: 'llm_new' };
    },
    async getLlm(id) { if (existing.llmId === id) return { llm_id: id }; throw new Error('404'); },
    async updateLlm(id, body) {
      if (rejectModels.includes(body.model)) throw Object.assign(new Error('bad model'), { name: 'RetellError', status: 400 });
      seen.updated.push(['llm', id, body]);
      seen.order.push('update-llm');
      return { llm_id: id };
    },
    async getAgent(id) { if (existing.voiceAgentId === id) return { agent_id: id }; throw new Error('404'); },
    async createAgent(body) { seen.created.push(['agent', body]); return { agent_id: 'agent_voice_new' }; },
    async updateAgent(id, body) { seen.updated.push(['agent', id, body]); seen.order.push('update-agent'); return { agent_id: id }; },
    async getChatAgent(id) { if (existing.chatAgentId === id) return { agent_id: id }; throw new Error('404'); },
    async createChatAgent(body) { seen.created.push(['chat-agent', body]); return { agent_id: 'agent_chat_new' }; },
    async updateChatAgent(id, body) { seen.updated.push(['chat-agent', id, body]); seen.order.push('update-chat-agent'); return { agent_id: id }; },
    async publishAgent(id) { seen.published.push(id); seen.order.push('publish'); return {}; },
  };
  return client;
}

function run(opts, { home, ids = {}, client }) {
  const idsFile = path.join(home, 'ids.json');
  fs.writeFileSync(idsFile, JSON.stringify(ids));
  return provision({
    argv: opts.argv ?? [],
    env: { BONA_TOOL_TOKEN: TOKEN, BONA_PUBLIC_API: PUBLIC_API, BONA_SITE: 'https://bona.azoz.uk', RETELL_API_KEY: 'k', ...(opts.env ?? {}) },
    idsFile, home, log: opts.log ?? (() => {}), clientFactory: () => client,
  }).then((result) => ({ result, ids: JSON.parse(fs.readFileSync(idsFile, 'utf8')) }));
}

test('--dry-run prints payloads and calls nothing', async () => {
  const { home, cleanup } = tempHome();
  const lines = [];
  const out = await provision({
    argv: ['--dry-run'], home, log: (l) => lines.push(l),
    env: { BONA_TOOL_TOKEN: TOKEN, BONA_PUBLIC_API: PUBLIC_API, BONA_SITE: 'https://bona.azoz.uk' },
    idsFile: path.join(home, 'ids.json'),
    clientFactory: () => { throw new Error('the dry run must not build a client that talks to Retell'); },
  });
  assert.equal(out.dryRun, true);
  const text = lines.join('\n');
  assert.match(text, /create-knowledge-base/);
  assert.match(text, /create-retell-llm/);
  assert.match(text, /create-agent/);
  assert.match(text, /create-chat-agent/);
  assert.ok(!text.includes(TOKEN), 'the dry run must never print the tool token');
  assert.equal(fs.existsSync(path.join(home, 'ids.json')), false, 'a dry run writes no ids');
  cleanup();
});

test('a first run creates all four objects and records their ids', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient();
  const { result, ids } = await run({}, { home, client });
  assert.deepEqual(client.seen.created.map(([k]) => k), ['kb', 'llm', 'agent', 'chat-agent']);
  assert.equal(result.knowledgeBaseId, 'kb_new');
  assert.equal(ids.llmId, 'llm_new');
  assert.equal(ids.voiceAgentId, 'agent_voice_new');
  assert.equal(ids.chatAgentId, 'agent_chat_new');
  assert.equal(ids.model, PREFERRED_MODEL);
  assert.ok(ids.updatedAt);
  cleanup();
});

test('a second run updates in place — no duplicate agents in the Retell account', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient({
    existing: { kb: { knowledge_base_id: 'kb_1', knowledge_base_name: KB_NAME, status: 'complete' }, llmId: 'llm_1', voiceAgentId: 'agent_v', chatAgentId: 'agent_c' },
  });
  const { ids } = await run({}, { home, client, ids: { knowledgeBaseId: 'kb_1', llmId: 'llm_1', voiceAgentId: 'agent_v', chatAgentId: 'agent_c' } });
  assert.deepEqual(client.seen.created, []);
  assert.deepEqual(client.seen.updated.map(([k, id]) => `${k}:${id}`), ['llm:llm_1', 'agent:agent_v', 'chat-agent:agent_c']);
  assert.equal(ids.voiceAgentId, 'agent_v');
  cleanup();
});

test('an id that no longer exists in Retell is recreated, not fatal', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient();
  const { ids } = await run({}, { home, client, ids: { llmId: 'llm_gone', voiceAgentId: 'agent_gone', chatAgentId: 'chat_gone' } });
  assert.equal(ids.llmId, 'llm_new');
  assert.equal(ids.voiceAgentId, 'agent_voice_new');
  cleanup();
});

test('a knowledge base created by hand is adopted by name instead of duplicated', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient({ existing: { kb: { knowledge_base_id: 'kb_manual', knowledge_base_name: KB_NAME, status: 'complete' } } });
  const { ids } = await run({}, { home, client });
  assert.equal(ids.knowledgeBaseId, 'kb_manual');
  assert.ok(!client.seen.created.some(([k]) => k === 'kb'));
  cleanup();
});

/** The live situation this guards: a KB created for bona.azoz.uk, a site now on bona-real-estate.com. */
function movedSite(ids = {}) {
  const kb = { knowledge_base_id: 'kb_old', knowledge_base_name: KB_NAME, status: 'complete', knowledge_base_sources: urlSources(OLD_SITE) };
  return { client: fakeClient({ existing: { kb, llmId: 'llm_1', voiceAgentId: 'agent_v', chatAgentId: 'agent_c' } }),
    ids: { knowledgeBaseId: 'kb_old', llmId: 'llm_1', voiceAgentId: 'agent_v', chatAgentId: 'agent_c', ...ids } };
}

test('without --rebuild-kb a stale knowledge base is reused, warned about, and never deleted', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  const lines = [];
  const { ids } = await run({ env: { BONA_SITE: NEW_SITE }, log: (l) => lines.push(l) }, { home, client, ids: idsIn });
  assert.equal(ids.knowledgeBaseId, 'kb_old', 'the existing base must be left exactly as it was');
  assert.deepEqual(client.seen.deleted, [], 'nothing may be deleted without the flag');
  assert.ok(!client.seen.created.some(([k]) => k === 'kb'));
  const text = lines.join('\n');
  assert.match(text, /bona\.azoz\.uk\/llms-full\.txt/, 'the operator must see which URLs it is stuck on');
  assert.match(text, /--rebuild-kb/, 'the warning must say how to fix it');
  cleanup();
});

test('a knowledge base that already indexes the configured site is not warned about', async () => {
  const { home, cleanup } = tempHome();
  const kb = { knowledge_base_id: 'kb_ok', knowledge_base_name: KB_NAME, status: 'complete', knowledge_base_sources: urlSources(NEW_SITE) };
  const client = fakeClient({ existing: { kb } });
  const lines = [];
  await run({ env: { BONA_SITE: NEW_SITE }, log: (l) => lines.push(l) }, { home, client });
  assert.equal(lines.join('\n').includes('--rebuild-kb'), false, 'a healthy base must not nag');
  cleanup();
});

test('--rebuild-kb re-points the LLM first and deletes the old base only afterwards', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  const { ids } = await run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn });

  const [, kbBody] = client.seen.created.find(([k]) => k === 'kb');
  assert.deepEqual(kbBody.knowledge_base_urls, [`${NEW_SITE}/llms-full.txt`, `${NEW_SITE}/llms.txt`]);
  const [, , llmBody] = client.seen.updated.find(([k]) => k === 'llm');
  assert.deepEqual(llmBody.knowledge_base_ids, ['kb_new'], 'the LLM must be moved to the replacement');
  assert.deepEqual(client.seen.deleted, ['kb_old']);
  assert.ok(
    client.seen.order.indexOf('delete-kb') > client.seen.order.indexOf('update-llm'),
    'deleting first would leave Dana with no knowledge base at all',
  );
  assert.ok(client.seen.order.indexOf('create-kb') < client.seen.order.indexOf('update-llm'));
  assert.equal(ids.knowledgeBaseId, 'kb_new');
  cleanup();
});

test('--rebuild-kb deletes the old base only after the agents serve the new one', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  await run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn });
  // Pointing the LLM at the new base is not the same as Dana serving it: when a new LLM has
  // to be created, the agents keep answering from the old one until they are updated.
  for (const step of ['update-agent', 'update-chat-agent']) {
    assert.ok(
      client.seen.order.indexOf('delete-kb') > client.seen.order.indexOf(step),
      `delete-kb must come after ${step}, or a live agent can be left reading from nothing`,
    );
  }
  cleanup();
});

test('--rebuild-kb --publish retires the old base only after publishing', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  await run({ argv: ['--rebuild-kb', '--publish'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn });
  assert.ok(
    client.seen.order.indexOf('delete-kb') > client.seen.order.lastIndexOf('publish'),
    'where published versions are the live surface, the agent only moves at publish time',
  );
  cleanup();
});

test('--rebuild-kb --publish keeps the old base when a publish fails', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  client.publishAgent = async () => { throw new Error('Retell refused to publish'); };
  // The run itself still succeeds — a failed publish is not fatal — but the base must survive,
  // because the live published agent is still the one reading from it.
  await run({ argv: ['--rebuild-kb', '--publish'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn });
  assert.deepEqual(client.seen.deleted, [], 'a live published agent may still be serving the old base');
  cleanup();
});

test('--rebuild-kb keeps the old knowledge base when an agent update fails', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  client.updateAgent = async () => { throw new Error('Retell rejected the agent payload'); };
  client.createAgent = async () => { throw new Error('Retell rejected the agent payload'); };
  await assert.rejects(() => run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn }), /rejected/);
  assert.deepEqual(client.seen.deleted, [], 'an agent still on the old LLM must keep the base that LLM reads');
  cleanup();
});

test('--rebuild-kb keeps the old knowledge base when re-pointing the LLM fails', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  client.updateLlm = async () => { throw new Error('Retell request timed out'); };
  await assert.rejects(() => run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE } }, { home, client, ids: idsIn }), /timed out/);
  assert.deepEqual(client.seen.deleted, [], 'a half-finished swap must not destroy the base Dana is still using');
  cleanup();
});

test('a failed delete is reported but does not fail the run', async () => {
  const { home, cleanup } = tempHome();
  const { client, ids: idsIn } = movedSite();
  client.deleteKnowledgeBase = async () => { throw new Error('403 forbidden'); };
  const lines = [];
  const { ids } = await run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE }, log: (l) => lines.push(l) }, { home, client, ids: idsIn });
  assert.equal(ids.knowledgeBaseId, 'kb_new', 'the new base is live either way');
  assert.match(lines.join('\n'), /could not delete the old knowledge base kb_old/);
  cleanup();
});

test('--rebuild-kb on an account with no knowledge base simply creates one', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient();
  const { ids } = await run({ argv: ['--rebuild-kb'], env: { BONA_SITE: NEW_SITE } }, { home, client });
  assert.equal(ids.knowledgeBaseId, 'kb_new');
  assert.deepEqual(client.seen.deleted, []);
  cleanup();
});

test('--dry-run --rebuild-kb prints the swap in order and still calls nothing', async () => {
  const { home, cleanup } = tempHome();
  const idsFile = path.join(home, 'ids.json');
  fs.writeFileSync(idsFile, JSON.stringify({ knowledgeBaseId: 'kb_old', llmId: 'llm_1' }));
  const lines = [];
  const out = await provision({
    argv: ['--dry-run', '--rebuild-kb'], home, log: (l) => lines.push(l), idsFile,
    env: { BONA_TOOL_TOKEN: TOKEN, BONA_PUBLIC_API: PUBLIC_API, BONA_SITE: NEW_SITE },
    clientFactory: () => { throw new Error('the dry run must not build a client that talks to Retell'); },
  });
  assert.equal(out.rebuildKb, true);
  const text = lines.join('\n');
  assert.match(text, /delete-knowledge-base\/kb_old/);
  assert.match(text, /update-retell-llm\/llm_1/);
  assert.ok(
    text.indexOf('delete-knowledge-base') > text.indexOf('update-retell-llm'),
    'the printed plan must show the delete happening last',
  );
  assert.match(text, new RegExp(`${NEW_SITE.replace('.', '\\.')}/llms-full\\.txt`));
  cleanup();
});

test('a model Retell rejects falls back to gpt-4.1', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient({ rejectModels: [PREFERRED_MODEL] });
  const { ids } = await run({}, { home, client });
  assert.equal(ids.model, FALLBACK_MODEL);
  const [, llmBody] = client.seen.created.find(([k]) => k === 'llm');
  assert.equal(llmBody.model, FALLBACK_MODEL);
  cleanup();
});

test('BONA_RETELL_SEPARATE_CHAT_AGENT=0 reuses the voice agent for chat', async () => {
  const { home, cleanup } = tempHome();
  const client = fakeClient();
  const { ids } = await run({ env: { BONA_RETELL_SEPARATE_CHAT_AGENT: '0' } }, { home, client });
  assert.equal(ids.chatAgentId, ids.voiceAgentId);
  assert.ok(!client.seen.created.some(([k]) => k === 'chat-agent'));
  cleanup();
});

test('--publish publishes both agents; without it they stay drafts', async () => {
  const { home, cleanup } = tempHome();
  const draft = fakeClient();
  await run({}, { home, client: draft });
  assert.deepEqual(draft.seen.published, []);

  const published = fakeClient();
  await run({ argv: ['--publish'] }, { home, client: published });
  assert.deepEqual(published.seen.published, ['agent_voice_new', 'agent_chat_new']);
  cleanup();
});

test('--ensure-env only creates the secrets file, 0600, and stops', async () => {
  const { home, cleanup } = tempHome();
  const out = await provision({
    argv: ['--ensure-env'], home, log: () => {}, env: {},
    clientFactory: () => { throw new Error('must not build a client'); },
  });
  assert.equal(out.ensuredEnvOnly, true);
  const file = path.join(home, '.secrets', 'bona-services.env');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /BONA_TOOL_TOKEN=[0-9a-f]{32}/);
  assert.match(body, /BONA_PUBLIC_API=https:\/\/api\.bona-real-estate\.com/);
  cleanup();
});

test('provisioning without a tool token refuses to build unauthenticated webhooks', async () => {
  const { home, cleanup } = tempHome();
  await assert.rejects(
    () => provision({ argv: [], home, log: () => {}, env: { BONA_TOOL_TOKEN: '', RETELL_API_KEY: 'k' }, idsFile: path.join(home, 'ids.json'), clientFactory: () => fakeClient() }),
    /BONA_TOOL_TOKEN/,
  );
  cleanup();
});

test('writeIds only rewrites the file when an id actually changed', () => {
  const { home, cleanup } = tempHome();
  const file = path.join(home, 'ids.json');
  const record = { llmId: 'llm_1', voiceAgentId: 'agent_1', chatAgentId: 'agent_2' };

  const first = writeIds(record, file);
  assert.equal(first.changed, true);
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt;
  assert.ok(stamp);

  const again = writeIds({ ...record }, file);
  assert.equal(again.changed, false, 're-running provisioning must not dirty the worktree');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).updatedAt, stamp);

  const reordered = writeIds({ chatAgentId: 'agent_2', voiceAgentId: 'agent_1', llmId: 'llm_1' }, file);
  assert.equal(reordered.changed, false, 'key order is not a change');

  const moved = writeIds({ ...record, voiceAgentId: 'agent_9' }, file);
  assert.equal(moved.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).voiceAgentId, 'agent_9');
  cleanup();
});
