import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetellClient } from '../lib/retell.mjs';

function stubFetch(json) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  };
  return { seen, fetchImpl };
}

// Retell switched off POST /v2/create-web-call on 2026-10-18 ("Deprecated API usage is no longer supported").
test('createWebCall posts the same body to /v3/create-web-call', async () => {
  const { seen, fetchImpl } = stubFetch({ call_id: 'call_1', access_token: 'tok', transport: 'livekit' });
  const client = createRetellClient({ apiKey: 'k', fetchImpl });
  const body = { agent_id: 'agent_voice', metadata: { locale: 'en' }, retell_llm_dynamic_variables: { locale: 'en' } };
  const res = await client.createWebCall(body);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, '/v3/create-web-call');
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0].init.body), body);
  assert.equal(res.access_token, 'tok');
});
