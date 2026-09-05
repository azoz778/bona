/**
 * Minimal Retell AI REST client (no SDK dependency — every call here is one fetch).
 *
 * Endpoints used, verified against retell-sdk 5.64.0 and docs.retellai.com:
 *   POST   /create-chat                    { agent_id, retell_llm_dynamic_variables?, metadata? }
 *   POST   /create-chat-completion         { chat_id, content } -> { messages: [...] }
 *   PATCH  /end-chat/{chat_id}
 *   POST   /v2/create-web-call             { agent_id, retell_llm_dynamic_variables?, metadata? }
 *   POST   /create-retell-llm  PATCH /update-retell-llm/{llm_id}  GET /get-retell-llm/{llm_id}
 *   POST   /create-agent       PATCH /update-agent/{agent_id}
 *   POST   /create-chat-agent  PATCH /update-chat-agent/{agent_id}
 *   POST   /publish-agent-version/{agent_id}
 *   POST   /create-knowledge-base   (multipart/form-data)   GET /list-knowledge-bases
 *   GET    /list-voices   POST /v2/list-agents
 *
 * `mock: true` (BONA_RETELL_MOCK=1) answers locally so the HTTP layer can be
 * exercised without spending the owner's Retell balance.
 */

export const RETELL_BASE = 'https://api.retellai.com';

export class RetellError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'RetellError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/** True for 4xx other than 429 — a payload/config problem, not a transient one. */
export const isClientError = (err) => {
  const status = Number(err?.status);
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 429;
};

export function createRetellClient({ apiKey, baseUrl = RETELL_BASE, fetchImpl = globalThis.fetch, mock = false, timeoutMs = 30_000 } = {}) {
  if (!mock && !apiKey) throw new Error('RETELL_API_KEY is required (set it in ~/.secrets/retell.env)');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, { body, form, query } = {}) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${apiKey}` };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url.toString(), { method, headers, body: payload, signal: controller.signal });
    } catch (err) {
      throw new RetellError(err?.name === 'AbortError' ? 'Retell request timed out' : `Retell request failed: ${err?.message ?? err}`, { path });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    if (!res.ok) {
      const detail = typeof parsed === 'string' ? parsed : parsed?.message ?? parsed?.error_message ?? JSON.stringify(parsed);
      throw new RetellError(`Retell ${method} ${path} -> ${res.status}: ${String(detail).slice(0, 400)}`, { status: res.status, body: parsed, path });
    }
    return parsed;
  }

  /* ---------------- mock ---------------- */
  const mockState = { chats: new Map(), n: 0 };
  const mockClient = {
    mock: true,
    async createChat({ agent_id = 'agent_mock', retell_llm_dynamic_variables = {}, metadata = {} } = {}) {
      const chat_id = `chat_mock_${++mockState.n}`;
      mockState.chats.set(chat_id, { agent_id, retell_llm_dynamic_variables, metadata });
      return { chat_id, agent_id, chat_status: 'ongoing', retell_llm_dynamic_variables, metadata };
    },
    async createChatCompletion({ chat_id, content }) {
      const locale = mockState.chats.get(chat_id)?.retell_llm_dynamic_variables?.locale ?? 'en';
      const ar = locale === 'ar';
      const wantsSearch = /villa|apartment|فيلا|شقة|khalidiyah|الخالدية|property|عقار/i.test(String(content));
      const messages = [];
      if (wantsSearch) {
        messages.push({
          role: 'tool_call_invocation', tool_call_id: 'tc_mock_1', name: 'search_properties',
          arguments: JSON.stringify({ query: String(content).slice(0, 120) }),
        });
        messages.push({ role: 'tool_call_result', tool_call_id: 'tc_mock_1', content: '{"count":0,"results":[]}', successful: true });
      }
      messages.push({
        role: 'agent',
        content: ar ? 'تمام. أقدر أساعدك أكثر لو عرفت الحي المفضل عندك.' : 'Of course. Which district are you considering?',
        message_id: `msg_mock_${++mockState.n}`,
      });
      return { messages };
    },
    async endChat(chatId) { mockState.chats.delete(chatId); return null; },
    async createWebCall({ agent_id = 'agent_mock', metadata = {} } = {}) {
      return { call_id: `call_mock_${++mockState.n}`, access_token: 'mock-access-token', agent_id, call_status: 'registered', metadata };
    },
    async listAgents() { return []; },
    async ping() { return { ok: true, mock: true }; },
  };

  /* ---------------- live ---------------- */
  const live = {
    mock: false,
    request,
    createChat: (body) => request('POST', '/create-chat', { body }),
    createChatCompletion: (body) => request('POST', '/create-chat-completion', { body }),
    endChat: (chatId) => request('PATCH', `/end-chat/${encodeURIComponent(chatId)}`),
    getChat: (chatId) => request('GET', `/get-chat/${encodeURIComponent(chatId)}`),
    createWebCall: (body) => request('POST', '/v2/create-web-call', { body }),
    getCall: (callId) => request('GET', `/v2/get-call/${encodeURIComponent(callId)}`),

    listAgents: () => request('GET', '/list-agents'),
    getAgent: (agentId) => request('GET', `/get-agent/${encodeURIComponent(agentId)}`),
    createAgent: (body) => request('POST', '/create-agent', { body }),
    updateAgent: (agentId, body) => request('PATCH', `/update-agent/${encodeURIComponent(agentId)}`, { body }),
    getChatAgent: (agentId) => request('GET', `/get-chat-agent/${encodeURIComponent(agentId)}`),
    createChatAgent: (body) => request('POST', '/create-chat-agent', { body }),
    updateChatAgent: (agentId, body) => request('PATCH', `/update-chat-agent/${encodeURIComponent(agentId)}`, { body }),
    publishAgent: (agentId, body = {}) => request('POST', `/publish-agent-version/${encodeURIComponent(agentId)}`, { body }),

    createLlm: (body) => request('POST', '/create-retell-llm', { body }),
    getLlm: (llmId) => request('GET', `/get-retell-llm/${encodeURIComponent(llmId)}`),
    updateLlm: (llmId, body) => request('PATCH', `/update-retell-llm/${encodeURIComponent(llmId)}`, { body }),

    listKnowledgeBases: () => request('GET', '/list-knowledge-bases'),
    getKnowledgeBase: (kbId) => request('GET', `/get-knowledge-base/${encodeURIComponent(kbId)}`),
    /** create-knowledge-base is multipart/form-data; array values repeat the same field name. */
    createKnowledgeBase: ({ knowledge_base_name, knowledge_base_urls = [], enable_auto_refresh = true }) => {
      const form = new FormData();
      form.set('knowledge_base_name', knowledge_base_name);
      form.set('enable_auto_refresh', String(Boolean(enable_auto_refresh)));
      for (const u of knowledge_base_urls) form.append('knowledge_base_urls', u);
      return request('POST', '/create-knowledge-base', { form });
    },
    addKnowledgeBaseSources: (kbId, { knowledge_base_urls = [] }) => {
      const form = new FormData();
      for (const u of knowledge_base_urls) form.append('knowledge_base_urls', u);
      return request('POST', `/add-knowledge-base-sources/${encodeURIComponent(kbId)}`, { form });
    },

    listVoices: () => request('GET', '/list-voices'),
    async ping() { await request('GET', '/list-agents'); return { ok: true }; },
  };

  return mock ? mockClient : live;
}

/** Cached health probe so `/health` never hammers Retell. */
export function createHealthProbe(client, { ttlMs = 60_000, now = () => Date.now() } = {}) {
  let last = { at: 0, status: 'unknown' };
  return async function probe() {
    if (now() - last.at < ttlMs && last.status !== 'unknown') return last.status;
    try {
      await client.ping();
      last = { at: now(), status: 'ok' };
    } catch {
      last = { at: now(), status: 'error' };
    }
    return last.status;
  };
}
