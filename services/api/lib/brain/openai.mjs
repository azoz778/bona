/**
 * OpenAI Responses API (POST /v1/responses), request and response (brain/DESIGN-brain.md §3.4; PLAN T00 step 7,
 * T25b). Pure: no fetch, no clock, no key; lib/brain.mjs sends what this builds and hands back what it got.
 *
 * Why not Chat Completions: the T00 step 7 probe (28 Nov) found function tools with any reasoning effort but 'none'
 * refused there (400, param reasoning_effort) for both gpt-5.6-sol and gpt-6.1-terra, and the same request on
 * /v1/responses served, cached and metered. brain.mjs still builds chat-shaped messages; this file maps them.
 *
 * The request: `model`; `instructions` = the first system message (the prompt and the site facts: with the tools,
 * the byte-stable cached prefix); `input` = the rest in order (a later system message, the code-made context note or
 * the repair note, is a `developer` message; history and the client turn are `user` / `assistant` messages; a tool
 * round is the response's own output items, then one `function_call_output` per call, by `call_id`); flat strict
 * function `tools` with `tool_choice` and `parallel_tool_calls:true` (only when there are tools);
 * `reasoning:{effort:'low'}`; `store:false` with `include:['reasoning.encrypted_content']`; `prompt_cache_key`;
 * `max_output_tokens:1200`; `safety_identifier` (the hashed lead id, never the phone or a name); `text.format` for
 * the classifier's JSON. Never `temperature` or `top_p` (the probe: refused).
 *
 * Reasoning items: with store:false the provider keeps nothing, so the reasoning items of a response that asked for
 * tools (each with its encrypted content) go back, as returned and before their function calls, on the next request
 * of the same attempt (the next tool round, the repair call). They live only in that attempt's message list
 * (`assistantMessage`): never in a turn result, a log line, a marker or the next turn, and a backup restart starts
 * without them (they belong to the other model).
 *
 * The response: the text (the LAST assistant message only: a preamble or commentary message before it never reaches
 * the client), the function calls (each with its arguments parsed: a JSON object or the whole response is
 * `bad_response`), a refusal flag, the usage token counts and the output items. Anything but `status:'completed'` is
 * `bad_response`, except an `incomplete` one stopped by the content filter, which is a refusal (never retried on
 * another model), and a `failed` one whose error code puts the fault on OpenAI's side, which is `down` as a 5xx
 * (errors.mjs codeFromFailed). Cut off at max_output_tokens is `bad_response` (the backup model's case).
 */
import { createHash } from 'node:crypto';
import { codeFromFailed } from './errors.mjs';

export const RESPONSES_PATH = '/responses';
export const MODELS_PATH = '/models';
/** The output cap of one request (reasoning tokens included), sent as `max_output_tokens`. */
export const MAX_OUTPUT_TOKENS = 1200;
/** The same cap under its Chat Completions name: the T26 eval imports it (PR #102). */
export const MAX_COMPLETION_TOKENS = MAX_OUTPUT_TOKENS;
/** Sent as `reasoning.effort`. */
export const REASONING_EFFORT = 'low';
const INCLUDE = Object.freeze(['reasoning.encrypted_content']);

/** The first 32 hex of sha256('bona:' + id): OpenAI can tie misuse to one end user, never to a phone or a name. */
export function safetyIdentifier(id) {
  return createHash('sha256').update(`bona:${String(id ?? '')}`).digest('hex').slice(0, 32);
}

/** One cached prefix group per route and language. */
export const cacheKey = (route, language) => `bona-${route}-${language}-v1`;

/** A chat-shaped tool (lib/brain/tool-schemas.mjs) as a Responses function tool: the same schema, flat. */
const functionTool = (t) => ({ type: 'function', name: t.function.name, description: t.function.description, strict: t.function.strict, parameters: t.function.parameters });

/** The chat messages brain.mjs builds as Responses input: system[0] → instructions, the rest → input items. */
function inputOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const head = list[0]?.role === 'system' && typeof list[0].content === 'string' ? list[0].content : null;
  const input = [];
  for (const m of head === null ? list : list.slice(1)) {
    if (m.role === 'assistant' && Array.isArray(m.items)) input.push(...m.items);
    else if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: String(m.content ?? '') });
    else if (m.role === 'system') input.push({ role: 'developer', content: m.content });
    else input.push({ role: m.role, content: m.content });
  }
  return { instructions: head, input };
}

/** Chat Completions' `response_format` as the Responses `text.format`. */
function textFormat(rf) {
  if (!rf || typeof rf !== 'object') return null;
  if (rf.type === 'json_schema') {
    const { name, description, strict, schema } = rf.json_schema ?? {};
    return { type: 'json_schema', name, ...(description ? { description } : {}), strict, schema };
  }
  return { type: rf.type };
}

/**
 * @param {{ model: string, messages: object[], tools?: object[], toolChoice?: 'auto'|'none', cacheKey: string,
 *           safetyId?: string, maxTokens?: number, effort?: string, responseFormat?: object }} o
 */
export function requestBody({ model, messages, tools = [], toolChoice = 'auto', cacheKey: key, safetyId, maxTokens = MAX_OUTPUT_TOKENS, effort = REASONING_EFFORT, responseFormat }) {
  const { instructions, input } = inputOf(messages);
  const body = { model };
  if (instructions !== null) body.instructions = instructions;
  body.input = input;
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map(functionTool);
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = true;
  }
  body.reasoning = { effort };
  body.store = false;
  body.include = [...INCLUDE];
  body.prompt_cache_key = key;
  body.max_output_tokens = maxTokens;
  const format = textFormat(responseFormat);
  if (format) body.text = { format };
  if (safetyId) body.safety_identifier = safetyId;
  return body;
}

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/**
 * Token counts of one response: { in, cached, out, reasoning }. `in` includes the cached tokens and `out` the
 * reasoning ones (input_tokens / output_tokens), as prompt_tokens / completion_tokens did, so prices.mjs reads them
 * with the same meaning.
 */
export function usageOf(json) {
  const u = json?.usage ?? {};
  return {
    in: count(u?.input_tokens),
    cached: count(u?.input_tokens_details?.cached_tokens),
    out: count(u?.output_tokens),
    reasoning: count(u?.output_tokens_details?.reasoning_tokens),
  };
}

const BAD = Object.freeze({ ok: false, code: 'bad_response' });

/**
 * @param {unknown} json  the parsed 200 body
 * @returns {{ ok: true, text: string, toolCalls: {id, name, arguments, args}[], refusal: boolean, finish: string,
 *             usage: object, output: object[] } | { ok: false, code: 'bad_response'|'down' }}
 *   `id` of a tool call is its `call_id` (what the function_call_output answers); `output` is the response's items,
 *   for assistantMessage.
 */
export function parseCompletion(json) {
  // A 200 that failed: `down` when OpenAI's own side failed (server_error and kin), else bad_response.
  if (json && typeof json === 'object' && json.status === 'failed') return { ok: false, code: codeFromFailed(json.error) };
  if (!json || typeof json !== 'object' || !Array.isArray(json.output) || json.error != null) return BAD;
  if (json.status === 'incomplete') {
    if (json.incomplete_details?.reason !== 'content_filter') return BAD; // cut off: half an answer is never an answer
    return { ok: true, text: '', toolCalls: [], refusal: true, finish: 'content_filter', usage: usageOf(json), output: [] };
  }
  if (json.status !== 'completed') return BAD;
  let text = '';
  const toolCalls = [];
  let refusal = false;
  for (const item of json.output) {
    if (!item || typeof item !== 'object') return BAD;
    if (item.type === 'message') {
      const parts = [];
      for (const p of Array.isArray(item.content) ? item.content : []) {
        if (p?.type === 'output_text' && typeof p.text === 'string') parts.push(p.text);
        else if (p?.type === 'refusal' && typeof p.refusal === 'string' && p.refusal.trim() !== '') refusal = true;
      }
      text = parts.join(''); // the last message is the answer; an earlier one was a preamble
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name) return BAD;
      const argText = typeof item.arguments === 'string' ? item.arguments : '';
      let args;
      try { args = argText.trim() ? JSON.parse(argText) : {}; } catch { return BAD; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return BAD;
      toolCalls.push({ id: item.call_id, name: item.name, arguments: argText, args });
    }
    // `reasoning` items (and any other) only go back with the tool round (assistantMessage).
  }
  return {
    ok: true,
    text: text.trim(),
    toolCalls,
    refusal,
    finish: toolCalls.length ? 'tool_calls' : 'stop',
    usage: usageOf(json),
    output: json.output,
  };
}

/**
 * The response that asked for tools, as it must go back on the next request of the same attempt: its output items
 * as returned (the reasoning items with their encrypted content, before their function calls). requestBody sends
 * them back; nothing else reads them.
 */
export function assistantMessage(parsed) {
  return { role: 'assistant', items: [...parsed.output] };
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
