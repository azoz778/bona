/**
 * OpenAI Chat Completions, request and response (brain/DESIGN-brain.md §3.4). Pure: no fetch,
 * no clock, no key; lib/brain.mjs sends what this builds and hands back what it got.
 *
 * The request: `model`, `messages`, strict `tools` with `tool_choice` and
 * `parallel_tool_calls:true` (only when there are tools), `reasoning_effort:'low'`,
 * `store:false`, `prompt_cache_key`, `max_completion_tokens:1200`, `safety_identifier` (the
 * hashed lead id, never the phone or a name), and `response_format` for the classifier. Never
 * `temperature` or `top_p`. [verify each field at T00.7; if gpt-5.6-sol is not served on Chat
 * Completions with tools, this file moves to POST /v1/responses and the turn() contract stays.]
 *
 * The response: the text, the function calls (each with its arguments parsed: a JSON object or
 * the whole response is `bad_response`), a refusal flag, and the usage token counts.
 */
import { createHash } from 'node:crypto';

export const CHAT_PATH = '/chat/completions';
export const MODELS_PATH = '/models';
export const MAX_COMPLETION_TOKENS = 1200;
export const REASONING_EFFORT = 'low';

/** The first 32 hex of sha256('bona:' + id): OpenAI can tie misuse to one end user, never to a phone or a name. */
export function safetyIdentifier(id) {
  return createHash('sha256').update(`bona:${String(id ?? '')}`).digest('hex').slice(0, 32);
}

/** One cached prefix group per route and language. */
export const cacheKey = (route, language) => `bona-${route}-${language}-v1`;

/**
 * @param {{ model: string, messages: object[], tools?: object[], toolChoice?: 'auto'|'none', cacheKey: string,
 *           safetyId?: string, maxTokens?: number, effort?: string, responseFormat?: object }} o
 */
export function requestBody({ model, messages, tools = [], toolChoice = 'auto', cacheKey: key, safetyId, maxTokens = MAX_COMPLETION_TOKENS, effort = REASONING_EFFORT, responseFormat }) {
  const body = { model, messages };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = true;
  }
  body.reasoning_effort = effort;
  body.store = false;
  body.prompt_cache_key = key;
  body.max_completion_tokens = maxTokens;
  if (responseFormat) body.response_format = responseFormat;
  if (safetyId) body.safety_identifier = safetyId;
  return body;
}

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/** Token counts of one response: { in, cached, out, reasoning } (reasoning is part of out). */
export function usageOf(json) {
  const u = json?.usage ?? {};
  return {
    in: count(u.prompt_tokens),
    cached: count(u.prompt_tokens_details?.cached_tokens),
    out: count(u.completion_tokens),
    reasoning: count(u.completion_tokens_details?.reasoning_tokens),
  };
}

const BAD = Object.freeze({ ok: false, code: 'bad_response' });

/**
 * @param {unknown} json  the parsed 200 body
 * @returns {{ ok: true, text: string, toolCalls: {id, name, arguments, args}[], refusal: boolean, finish: string|null,
 *             usage: object, raw: object } | { ok: false, code: 'bad_response' }}
 */
export function parseCompletion(json) {
  const choice = json && typeof json === 'object' && Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = choice?.message;
  if (!msg || typeof msg !== 'object') return BAD;
  const refusal = (typeof msg.refusal === 'string' && msg.refusal.trim() !== '') || choice.finish_reason === 'content_filter';
  const toolCalls = [];
  for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    if (c?.type !== 'function' || typeof c.id !== 'string' || !c.id || typeof c.function?.name !== 'string') return BAD;
    const text = typeof c.function.arguments === 'string' ? c.function.arguments : '';
    let args;
    try { args = text.trim() ? JSON.parse(text) : {}; } catch { return BAD; }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return BAD;
    toolCalls.push({ id: c.id, name: c.function.name, arguments: text, args });
  }
  return {
    ok: true,
    text: typeof msg.content === 'string' ? msg.content.trim() : '',
    toolCalls,
    refusal,
    finish: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: usageOf(json),
    raw: msg,
  };
}

/** The assistant message that asked for tools, as it must be sent back on the next round. */
export function assistantMessage(parsed) {
  return {
    role: 'assistant',
    content: parsed.text ? parsed.text : null,
    tool_calls: parsed.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
  };
}

/** `retry-after-ms` or `retry-after` (seconds) as ms, or null. */
export function retryAfterMs(headers) {
  const get = (k) => (typeof headers?.get === 'function' ? headers.get(k) : headers?.[k]);
  const ms = Number(get('retry-after-ms'));
  if (get('retry-after-ms') != null && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = get('retry-after');
  const s = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(s) && s >= 0 ? Math.round(s * 1000) : null;
}
