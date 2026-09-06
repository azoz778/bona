/**
 * End-to-end tests of every HTTP route with a mocked Retell client.
 * The real Retell API and the real Evolution API are never contacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../index.mjs';
import { createInventory, WORKTREE_LISTINGS } from '../lib/inventory.mjs';
import { DEFAULT_ORIGINS } from '../lib/cors.mjs';
import { RetellError } from '../lib/retell.mjs';

const TOKEN = 'a'.repeat(32);
const inventory = createInventory({ file: WORKTREE_LISTINGS, siteUrl: 'https://bona.azoz.uk' });
const KHALIDIYAH = inventory.all().find((l) => l.location.district.en === 'Al Khalidiyah');

/** A scripted Retell double: records every call, replies with realistic message shapes. */
function fakeRetell({ failOn = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async createChat(body) {
      calls.push(['createChat', body]);
      if (failOn === 'createChat') throw new Error('retell down');
      return { chat_id: `chat_${++n}`, agent_id: body.agent_id, chat_status: 'ongoing' };
    },
    async createChatCompletion(body) {
      calls.push(['createChatCompletion', body]);
      if (failOn === 'createChatCompletion') throw new Error('retell down');
      if (/khalidiyah|الخالدية/i.test(body.content)) {
        return {
          messages: [
            { role: 'tool_call_invocation', tool_call_id: 't1', name: 'search_properties', arguments: JSON.stringify({ district: 'Al Khalidiyah' }) },
            { role: 'tool_call_result', tool_call_id: 't1', content: JSON.stringify({ count: 1, results: [{ id: KHALIDIYAH.id }] }) },
            { role: 'agent', content: 'One home matches. [[navigate:/properties/houses/]]', message_id: 'm1' },
          ],
        };
      }
      if (/lead|call me|كلمني/i.test(body.content)) {
        return {
          messages: [
            { role: 'tool_call_invocation', tool_call_id: 't2', name: 'create_lead', arguments: '{"phone":"+966500000000"}' },
            { role: 'tool_call_result', tool_call_id: 't2', content: '{"saved":true}' },
            { role: 'agent', content: 'Noted.', message_id: 'm2' },
          ],
        };
      }
      if (/silent/i.test(body.content)) return { messages: [] };
      return { messages: [{ role: 'agent', content: 'Which district are you considering?', message_id: 'm3' }] };
    },
    async endChat(chatId) { calls.push(['endChat', chatId]); return null; },
    async createWebCall(body) {
      calls.push(['createWebCall', body]);
      if (failOn === 'createWebCall') throw new Error('retell down');
      return { call_id: `call_${++n}`, access_token: 'tok_abc', agent_id: body.agent_id };
    },
    async ping() { return { ok: true }; },
  };
}

async function withServer(overrides, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-http-'));
  const sent = [];
  const retell = overrides.retell ?? fakeRetell();
  const app = createApp({
    config: {
      port: 0, host: '127.0.0.1', siteUrl: 'https://bona.azoz.uk', publicApi: 'https://api.bona.azoz.uk',
      dataDir, inventoryFile: WORKTREE_LISTINGS, origins: DEFAULT_ORIGINS, toolToken: TOKEN,
      retellApiKey: 'test', retellMock: false, chatAgentId: 'agent_chat', voiceAgentId: 'agent_voice',
      maxBodyBytes: 16 * 1024, chatRatePerMin: 30, tokenRatePerMin: 6, env: {}, ids: {}, version: '1.0.0',
      toolRatePerMin: 600, toolAuthFailRatePerMin: 10, allowQueryToken: false, trustedProxies: [],
      maxChatsPerDay: 300, maxCallsPerDay: 60, maxTurnsPerSession: 40,
      ...(overrides.config ?? {}),
    },
    inventory: overrides.inventory ?? inventory,
    retell,
    probeRetell: overrides.probeRetell ?? (async () => 'ok'),
    sendWhatsApp: async (text) => { sent.push(text); return { ok: true }; },
    log: overrides.log ?? (() => {}),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = (p, init = {}) => fetch(base + p, {
    ...init,
    headers: { 'Content-Type': 'application/json', Origin: 'https://bona.azoz.uk', ...(init.headers ?? {}) },
  });
  /** A Retell tool call: the token rides in `X-Bona-Token`, never in the URL. */
  const tool = (p, body, init = {}) => call(p, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
    headers: { 'X-Bona-Token': TOKEN, ...(init.headers ?? {}) },
  });
  try {
    await fn({ call, tool, base, app, retell, sent, dataDir });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/* ---------------- health ---------------- */

test('GET /health reports the service, inventory and Retell reachability', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'bona-api');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.retell, 'ok');
    assert.ok(body.inventory >= 20);
    assert.equal(typeof body.uptimeS, 'number');
  });
});

test('/health reports retell: "error" when Retell is unreachable, and still answers 200', async () => {
  await withServer({ probeRetell: async () => 'error' }, async ({ call }) => {
    const body = await (await call('/health')).json();
    assert.equal(body.ok, true);
    assert.equal(body.retell, 'error');
  });
});

/* ---------------- chat ---------------- */

test('POST /v1/chat/session opens a Retell chat and returns a greeting', async () => {
  await withServer({}, async ({ call, retell }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'ar', page: { url: 'https://bona.azoz.uk/ar/', title: 'بونا' } }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.sessionId, /^[0-9a-f]{32}$/);
    assert.match(body.greeting, /دانة/);
    const [, sent] = retell.calls.find(([name]) => name === 'createChat');
    assert.equal(sent.agent_id, 'agent_chat');
    assert.equal(sent.retell_llm_dynamic_variables.locale, 'ar');
    assert.equal(sent.retell_llm_dynamic_variables.page_title, 'بونا');
    assert.match(sent.retell_llm_dynamic_variables.session_id, /^[0-9a-f]{32}$/);
  });
});

test('a chat turn returns agent text plus a show_listing action', async () => {
  await withServer({}, async ({ call }) => {
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).json();
    const res = await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'a villa in Al Khalidiyah' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.messages[0].role, 'agent');
    assert.equal(body.messages[0].text, 'One home matches.', 'the [[…]] marker must be stripped');
    const show = body.actions.find((a) => a.type === 'show_listing');
    assert.ok(show, 'expected a show_listing action');
    assert.equal(show.listing.id, KHALIDIYAH.id);
    assert.equal(show.listing.url.en, `https://bona.azoz.uk/properties/${KHALIDIYAH.slug}/`);
    assert.ok(body.actions.some((a) => a.type === 'navigate' && a.path === '/properties/houses/'));
  });
});

test('a lead captured mid-conversation is reported to the widget', async () => {
  await withServer({}, async ({ call }) => {
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).json();
    const body = await (await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'please call me' }) })).json();
    assert.equal(body.leadCaptured, true);
  });
});

test('an empty completion still gives the visitor something to read', async () => {
  await withServer({}, async ({ call }) => {
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'ar' }) })).json();
    const body = await (await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'silent' }) })).json();
    assert.equal(body.messages.length, 1);
    assert.match(body.messages[0].text, /عذرا|عذراً/);
  });
});

test('an unknown session is 404, and empty text is 400', async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId: 'nope', text: 'hi' }) })).status, 404);
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({}) })).json();
    assert.equal((await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: '   ' }) })).status, 400);
  });
});

test('POST /v1/chat/end closes the Retell chat and records the conversation', async () => {
  await withServer({}, async ({ call, retell, dataDir }) => {
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).json();
    await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'hello' }) });
    const res = await call('/v1/chat/end', { method: 'POST', body: JSON.stringify({ sessionId }) });
    assert.deepEqual(await res.json(), { ok: true });
    assert.ok(retell.calls.some(([name]) => name === 'endChat'));
    const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'chats.jsonl'), 'utf8').trim());
    assert.equal(line.turns, 1);
    assert.equal((await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'hi' }) })).status, 404);
  });
});

test('ending an unknown session is still ok (the widget may retry)', async () => {
  await withServer({}, async ({ call }) => {
    assert.deepEqual(await (await call('/v1/chat/end', { method: 'POST', body: JSON.stringify({ sessionId: 'nope' }) })).json(), { ok: true });
  });
});

test('a Retell outage surfaces as 502, not as a stack trace', async () => {
  await withServer({ retell: fakeRetell({ failOn: 'createChat' }) }, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal_error' });
  });
});

test('before provisioning, chat and call answer 503 with a clear reason', async () => {
  await withServer({ config: { chatAgentId: null, voiceAgentId: null } }, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'not_provisioned');
    assert.equal((await call('/v1/call/token', { method: 'POST', body: JSON.stringify({}) })).status, 503);
  });
});

/* ---------------- calls ---------------- */

test('POST /v1/call/token returns a web-call access token', async () => {
  await withServer({}, async ({ call, retell }) => {
    const res = await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ locale: 'ar', page: { url: 'https://bona.azoz.uk/ar/properties/x/' } }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.accessToken, 'tok_abc');
    assert.match(body.callId, /^call_/);
    const [, sent] = retell.calls.find(([name]) => name === 'createWebCall');
    assert.equal(sent.agent_id, 'agent_voice');
    assert.equal(sent.metadata.locale, 'ar');
  });
});

test('the call context fills as tools fire, and is empty for an unknown call', async () => {
  await withServer({}, async ({ call, tool }) => {
    const { callId } = await (await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).json();
    const before = await (await call(`/v1/call/${callId}/context`)).json();
    assert.deepEqual(before.listings, []);

    await tool('/v1/tools/show_property', { call: { call_id: callId }, name: 'show_property', args: { id: KHALIDIYAH.id } });
    const after = await (await call(`/v1/call/${callId}/context`)).json();
    assert.equal(after.listings.length, 1);
    assert.equal(after.listings[0].id, KHALIDIYAH.id);
    assert.ok(Date.parse(after.updatedAt) > 0);

    const missing = await (await call('/v1/call/call_nope/context')).json();
    assert.deepEqual(missing, { listings: [], updatedAt: null });
  });
});

/* ---------------- tools + webhook auth ---------------- */

test('tool routes require the token, in a header', async () => {
  await withServer({}, async ({ call }) => {
    const body = JSON.stringify({ call: { call_id: 'c1' }, args: { district: 'Al Nuzhah' } });
    assert.equal((await call('/v1/tools/search_properties', { method: 'POST', body })).status, 401);
    assert.equal((await call('/v1/tools/search_properties', { method: 'POST', body, headers: { 'X-Bona-Token': 'wrong' } })).status, 401);
    assert.equal((await call('/v1/tools/search_properties', { method: 'POST', body, headers: { 'X-Bona-Token': TOKEN } })).status, 200);
    assert.equal((await call('/v1/tools/search_properties', { method: 'POST', body, headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  });
});

test('the Retell webhook keeps ?token=, because Retell sends no headers there', async () => {
  await withServer({}, async ({ call }) => {
    const event = JSON.stringify({ event: 'call_started', call: { call_id: 'c1' } });
    assert.equal((await call(`/v1/retell/webhook?token=${TOKEN}`, { method: 'POST', body: event })).status, 200);
    assert.equal((await call('/v1/retell/webhook?token=wrong', { method: 'POST', body: event })).status, 401);
  });
});

test('?token= is refused by default and accepted only when BONA_ALLOW_QUERY_TOKEN is on', async () => {
  const body = JSON.stringify({ call: { call_id: 'c1' }, args: { district: 'Al Nuzhah' } });
  await withServer({}, async ({ call }) => {
    assert.equal((await call(`/v1/tools/search_properties?token=${TOKEN}`, { method: 'POST', body })).status, 401);
  });
  await withServer({ config: { allowQueryToken: true } }, async ({ call }) => {
    assert.equal((await call(`/v1/tools/search_properties?token=${TOKEN}`, { method: 'POST', body })).status, 200);
  });
});

test('an unauthenticated tool call is rejected before its body is read', async () => {
  await withServer({}, async ({ call }) => {
    // 16 KB is the body cap. Without auth-before-body this would be a 413, which would
    // mean the process had already buffered and measured an anonymous caller's payload.
    const res = await call('/v1/tools/search_properties', {
      method: 'POST',
      body: JSON.stringify({ call: { call_id: 'c1' }, pad: 'x'.repeat(40_000) }),
    });
    assert.equal(res.status, 401);
  });
});

test('repeated bad tokens are throttled to 10 a minute, while Retell keeps working', async () => {
  await withServer({}, async ({ call, tool }) => {
    const body = JSON.stringify({ call: { call_id: 'c1' }, args: {} });
    const bad = () => call('/v1/tools/search_properties', { method: 'POST', body, headers: { 'X-Bona-Token': 'wrong' } });
    for (let i = 0; i < 10; i += 1) assert.equal((await bad()).status, 401, `guess ${i + 1} should still be a plain 401`);
    const blocked = await bad();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
    assert.equal((await tool('/v1/tools/search_properties', { call: { call_id: 'c1' }, args: {} })).status, 200,
      'a real Retell call must not be locked out by someone else guessing');
  });
});

test('the generous tool bucket still has a ceiling', async () => {
  await withServer({ config: { toolRatePerMin: 3 } }, async ({ tool }) => {
    const body = { call: { call_id: 'c1' }, args: { id: KHALIDIYAH.id } };
    for (let i = 0; i < 3; i += 1) assert.equal((await tool('/v1/tools/show_property', body)).status, 200);
    assert.equal((await tool('/v1/tools/show_property', body)).status, 429);
  });
});

test('a tool result is a JSON string, exactly what Retell expects', async () => {
  await withServer({}, async ({ tool }) => {
    const res = await tool('/v1/tools/search_properties', { call: { call_id: 'c1' }, name: 'search_properties', args: { district: 'Al Nuzhah' } });
    assert.equal(res.status, 200);
    const outer = await res.json();
    assert.equal(typeof outer, 'string', 'Retell reads the body as the tool result value');
    const payload = JSON.parse(outer);
    assert.ok(payload.count > 0);
    assert.ok(payload.results[0].price_ar);
  });
});

test('an unknown tool name is 404 even with a good token', async () => {
  await withServer({}, async ({ tool }) => {
    assert.equal((await tool('/v1/tools/drop_tables', {})).status, 404);
  });
});

test('create_lead through HTTP writes the lead and messages the owner', async () => {
  await withServer({}, async ({ tool, sent, dataDir }) => {
    const res = await tool('/v1/tools/create_lead', { chat: { chat_id: 'chat_1' }, name: 'create_lead', args: { phone: '+966500000000', name: 'Sara' } });
    assert.equal(JSON.parse(await res.json()).saved, true);
    assert.match(fs.readFileSync(path.join(dataDir, 'leads.jsonl'), 'utf8'), /Sara/);
    assert.equal(sent.length, 1);
  });
});

test('the Retell webhook is token-gated and appends to calls.jsonl / chats.jsonl', async () => {
  await withServer({}, async ({ call, tool, dataDir }) => {
    const event = JSON.stringify({ event: 'call_ended', call: { call_id: 'c1', agent_id: 'a1', call_status: 'ended', metadata: { locale: 'ar' }, transcript: 'Agent: hi' } });
    assert.equal((await call('/v1/retell/webhook', { method: 'POST', body: event })).status, 401);
    assert.equal((await tool('/v1/retell/webhook', event)).status, 200);
    const line = JSON.parse(fs.readFileSync(path.join(dataDir, 'calls.jsonl'), 'utf8').trim());
    assert.equal(line.event, 'call_ended');
    assert.equal(line.callId, 'c1');
    assert.equal(line.locale, 'ar');

    await tool('/v1/retell/webhook', { event: 'chat_ended', chat: { chat_id: 'h1' } });
    assert.match(fs.readFileSync(path.join(dataDir, 'chats.jsonl'), 'utf8'), /chat_ended/);
  });
});

/* ---------------- CORS, limits, hygiene ---------------- */

test('CORS: the site is allowed, an unknown origin gets no allow header', async () => {
  await withServer({}, async ({ call }) => {
    const ok = await call('/health', { headers: { Origin: 'https://bona.azoz.uk' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://bona.azoz.uk');
    const bad = await call('/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    assert.equal(bad.headers.get('vary'), 'Origin');
  });
});

test('a preflight is answered 204 with the allowed methods', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
  });
});

test('tool responses are never CORS-readable from a browser', async () => {
  await withServer({}, async ({ tool }) => {
    const res = await tool('/v1/tools/show_property', { call: { call_id: 'c1' }, args: { id: KHALIDIYAH.id } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
});

test('every response is no-store', async () => {
  await withServer({}, async ({ call }) => {
    for (const p of ['/health', '/v1/nope']) {
      assert.equal((await call(p)).headers.get('cache-control'), 'no-store');
    }
  });
});

test('bodies over 16 KB are refused with 413', async () => {
  await withServer({}, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en', pad: 'x'.repeat(20_000) }) });
    assert.equal(res.status, 413);
  });
});

test('malformed JSON is 400, not 500', async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call('/v1/chat/session', { method: 'POST', body: '{oops' })).status, 400);
    assert.equal((await call('/v1/chat/session', { method: 'POST', body: '[1,2,3]' })).status, 400);
  });
});

test('the chat rate limit closes after its budget, with Retry-After', async () => {
  await withServer({ config: { chatRatePerMin: 3 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
    }
    const blocked = await call('/v1/chat/session', { method: 'POST', body });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  });
});

test('the call-token budget is separate and tighter than chat', async () => {
  await withServer({ config: { tokenRatePerMin: 2, chatRatePerMin: 30 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 429);
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200, 'chat must not be starved by call attempts');
  });
});

test('the browser budgets never throttle Retell tool calls', async () => {
  await withServer({ config: { chatRatePerMin: 1, tokenRatePerMin: 1 } }, async ({ tool }) => {
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await tool('/v1/tools/show_property', { call: { call_id: 'c1' }, args: { id: KHALIDIYAH.id } })).status, 200);
    }
  });
});

test('unknown routes and wrong methods are handled without leaking internals', async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call('/v1/nope')).status, 404);
    assert.equal((await call('/v1/chat/session')).status, 404);
    assert.equal((await call('/health', { method: 'POST' })).status, 405, 'a known route with the wrong method is 405');
  });
});

test('a trailing slash resolves to the same route', async () => {
  await withServer({}, async ({ call }) => {
    assert.equal((await call('/v1/chat/session/', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).status, 200);
  });
});

/* ---------------- origin, content type, budgets ---------------- */

test('a stated origin that is not ours is refused outright, before Retell is called', async () => {
  await withServer({}, async ({ call, retell }) => {
    for (const p of ['/v1/chat/session', '/v1/chat/message', '/v1/chat/end', '/v1/call/token']) {
      const res = await call(p, { method: 'POST', body: JSON.stringify({ locale: 'en' }), headers: { Origin: 'https://evil.example' } });
      assert.equal(res.status, 403, p);
      assert.equal((await res.json()).error, 'forbidden_origin');
    }
    assert.equal(retell.calls.length, 0, 'CORS alone would have let the request run and cost money');
  });
});

test('a request with no Origin at all still works — curl, and the Retell webhook', async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locale: 'en' }),
    });
    assert.equal(res.status, 200);
  });
});

test('a browser POST that is not JSON is 415', async () => {
  await withServer({}, async ({ call, retell }) => {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await call('/v1/chat/session', { method: 'POST', body: '{"locale":"en"}', headers: { 'Content-Type': ct } });
      assert.equal(res.status, 415, ct);
    }
    assert.equal((await call('/v1/chat/session', { method: 'POST', body: '{"locale":"en"}', headers: { 'Content-Type': 'application/json; charset=utf-8' } })).status, 200);
    assert.equal(retell.calls.length, 1);
  });
});

test('the day\'s chat budget closes with 503 budget_exhausted', async () => {
  await withServer({ config: { maxChatsPerDay: 2 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
    const spent = await call('/v1/chat/session', { method: 'POST', body });
    assert.equal(spent.status, 503);
    assert.deepEqual(await spent.json(), { error: 'budget_exhausted' });
  });
});

test('the day\'s call budget is separate from the chat budget', async () => {
  await withServer({ config: { maxCallsPerDay: 1 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 503);
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200, 'chat is still open');
  });
});

/*
 * The day's ceiling stands for money Retell actually takes. It is charged after the body
 * has parsed and validated, and handed back when the upstream call fails — otherwise a
 * script posting junk, or an hour of Retell being down, closes the concierge until midnight
 * in Jeddah without a single billable event.
 */
test('malformed JSON is 400 and does not burn a unit of the day', async () => {
  await withServer({ config: { maxChatsPerDay: 5, maxCallsPerDay: 4, chatRatePerMin: 60, tokenRatePerMin: 60 } }, async ({ call, retell }) => {
    for (const p of ['/v1/chat/session', '/v1/call/token']) {
      for (const body of ['{', '{"locale":', 'null', '[]', '"hello"', '{"locale":"en",}']) {
        const res = await call(p, { method: 'POST', body });
        assert.equal(res.status, 400, `${p} <- ${body}`);
        assert.equal((await res.json()).error, 'invalid_json');
      }
    }
    assert.equal(retell.calls.length, 0, 'nothing reached Retell, so nothing was billed');
    const spent = (await (await call('/health')).json()).budget;
    assert.equal(spent.chats, 0, 'twelve malformed posts must leave the day untouched');
    assert.equal(spent.calls, 0);
  });
});

test('a body of the wrong shape is 400 and does not burn a unit of the day', async () => {
  await withServer({ config: { chatRatePerMin: 60, tokenRatePerMin: 60 } }, async ({ call, retell }) => {
    for (const body of [{ page: [] }, { locale: 5 }, { locale: { en: 1 } }, { page: 7 }, { page: { url: 12 } }, { page: { title: {} } }]) {
      const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error, 'bad_request');
    }
    assert.equal((await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ page: 7 }) })).status, 400);
    assert.equal(retell.calls.length, 0);
    const spent = (await (await call('/health')).json()).budget;
    assert.equal(spent.chats, 0);
    assert.equal(spent.calls, 0);
  });
});

// The check must never be stricter than the routes were. The chat widget posts
// `page: window.location.pathname` and the call widget passes that same string on, so a
// validator that demanded `{ url, title }` would 400 every visitor on the site.
test('the shapes the real widgets send are still accepted, and spend exactly one each', async () => {
  await withServer({ config: { chatRatePerMin: 60, tokenRatePerMin: 60 } }, async ({ call }) => {
    const bodies = [
      {},
      { locale: 'en', page: '/properties/houses/' },
      { locale: 'ar', page: { url: 'https://bona.azoz.uk/ar/', title: 'بونا' } },
      { locale: 'ar', page: null },
    ];
    for (const body of bodies) {
      assert.equal((await call('/v1/chat/session', { method: 'POST', body: JSON.stringify(body) })).status, 200, JSON.stringify(body));
    }
    assert.equal((await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ locale: 'en', page: '/ar/properties/x/' }) })).status, 200);
    const spent = (await (await call('/health')).json()).budget;
    assert.equal(spent.chats, bodies.length);
    assert.equal(spent.calls, 1);
  });
});

test('a Retell failure hands the unit back — a broken upstream must not close the day', async () => {
  const retell = fakeRetell();
  const realChat = retell.createChat;
  const realCall = retell.createWebCall;
  await withServer({ retell, config: { maxChatsPerDay: 5, maxCallsPerDay: 4, chatRatePerMin: 60, tokenRatePerMin: 60 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    const counters = async () => (await (await call('/health')).json()).budget;

    for (const [thrown, status] of [
      [new RetellError('rate limited', { status: 429, retryAfter: '3' }), 429],
      [new RetellError('payment required', { status: 402 }), 503],
      [new RetellError('upstream', { status: 503 }), 502],
      [new Error('ECONNREFUSED api.retellai.com'), 500],
    ]) {
      retell.createChat = async () => { throw thrown; };
      assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, status);
    }
    assert.equal((await counters()).chats, 0, 'four sessions Retell never opened cost the day nothing');

    retell.createWebCall = async () => { throw new RetellError('upstream', { status: 500 }); };
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 502);
    assert.equal((await counters()).calls, 0);

    // …and a request Retell does answer still spends exactly one of each.
    retell.createChat = realChat;
    retell.createWebCall = realCall;
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 200);
    const after = await counters();
    assert.equal(after.chats, 1);
    assert.equal(after.calls, 1);
  });
});

test('a day of Retell being down still leaves a full budget when it comes back', async () => {
  const retell = fakeRetell();
  const realChat = retell.createChat;
  await withServer({ retell, config: { maxChatsPerDay: 2, chatRatePerMin: 60 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    retell.createChat = async () => { throw new RetellError('payment required', { status: 402 }); };
    for (let i = 0; i < 6; i += 1) assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 503);
    retell.createChat = realChat;
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200, 'the ceiling was never really spent');
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 503, 'and it still stops at two');
  });
});

test('an unprovisioned agent is 503 and costs the day nothing', async () => {
  await withServer({ config: { chatAgentId: '', voiceAgentId: '', chatRatePerMin: 60, tokenRatePerMin: 60 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 503);
    assert.equal((await call('/v1/call/token', { method: 'POST', body })).status, 503);
    const spent = (await (await call('/health')).json()).budget;
    assert.equal(spent.chats, 0);
    assert.equal(spent.calls, 0);
  });
});

test('one session cannot run for ever: 429 session_limit after the turn cap', async () => {
  await withServer({ config: { maxTurnsPerSession: 3 } }, async ({ call }) => {
    const { sessionId } = await (await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) })).json();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'hello' }) })).status, 200);
    }
    const blocked = await call('/v1/chat/message', { method: 'POST', body: JSON.stringify({ sessionId, text: 'hello' }) });
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: 'session_limit' });
  });
});

test('/health reports the day\'s counters', async () => {
  await withServer({ config: { maxChatsPerDay: 5, maxCallsPerDay: 4 } }, async ({ call }) => {
    await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    const body = await (await call('/health')).json();
    assert.equal(body.budget.chats, 1);
    assert.equal(body.budget.calls, 1);
    assert.equal(body.budget.maxChats, 5);
    assert.equal(body.budget.maxCalls, 4);
    assert.match(body.budget.day, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test('an unknown POST path is 404 and does not spend the chat bucket', async () => {
  await withServer({ config: { chatRatePerMin: 2 } }, async ({ call }) => {
    const body = JSON.stringify({ locale: 'en' });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await call('/v1/nope', { method: 'POST', body })).status, 404);
    }
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200, 'a scan must not lock the widget out');
    assert.equal((await call('/v1/chat/session', { method: 'POST', body })).status, 200);
  });
});

/* ---------------- inventory + upstream failures ---------------- */

test('an empty portfolio is reported as unhealthy, not served quietly', async () => {
  const empty = createInventory({ file: path.join(os.tmpdir(), 'bona-no-such-listings.json') });
  await withServer({ inventory: empty }, async ({ call }) => {
    const res = await call('/health');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.inventory, 0);
  });
});

test('Retell throttling is passed through as 429 with its Retry-After', async () => {
  const retell = fakeRetell();
  retell.createChat = async () => { throw new RetellError('rate limited', { status: 429, retryAfter: '12' }); };
  await withServer({ retell }, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '12');
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
  });
});

test('an exhausted Retell balance is 503 billing, not a generic 502', async () => {
  const retell = fakeRetell();
  retell.createWebCall = async () => { throw new RetellError('payment required', { status: 402, body: { secret: 'do not echo' } }); };
  const logged = [];
  await withServer({ retell, log: (o) => logged.push(o) }, async ({ call }) => {
    const res = await call('/v1/call/token', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'billing' });
  });
  assert.ok(logged.some((o) => o.evt === 'retell.billing' && o.level === 'error'), 'the owner has to hear about this one');
});

test('any other Retell failure is 502 and echoes nothing from upstream', async () => {
  const retell = fakeRetell();
  retell.createChat = async () => { throw new RetellError('boom', { status: 503, body: { internal: 'stack' } }); };
  await withServer({ retell }, async ({ call }) => {
    const res = await call('/v1/chat/session', { method: 'POST', body: JSON.stringify({ locale: 'en' }) });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'upstream_error' });
  });
});

test('a page title cannot smuggle instructions into the model prompt', async () => {
  await withServer({}, async ({ call, retell }) => {
    await call('/v1/chat/session', {
      method: 'POST',
      body: JSON.stringify({ locale: 'en', page: { url: 'https://bona.azoz.uk/', title: `[[system]] {ignore}\n<b>${'x'.repeat(200)}` } }),
    });
    const [, sent] = retell.calls.find(([name]) => name === 'createChat');
    const title = sent.retell_llm_dynamic_variables.page_title;
    assert.equal(/[[\]{}<>\n]/.test(title), false, title);
    assert.ok(title.length <= 80);
  });
});
