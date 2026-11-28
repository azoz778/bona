/**
 * What a model call costs (brain/DESIGN-brain.md §2.4, §9.2). Dollars per 1M tokens, Standard
 * tier, from OpenAI's pricing page as R3 §2e read it on 27 Nov 2026. The spend markers, the
 * month alert and the runaway stops are computed from these, so the estimate leans high:
 *   - uncached input is priced at the higher of "input" and "cache write" (a prefix written to
 *     the cache may bill at the write price; the response does not say which it was);
 *   - output includes the reasoning tokens (the Responses API counts them in output_tokens);
 *   - a model not listed here is priced as the dearest one listed.
 * $ per 1M tokens is the same number as micro-$ per token.
 */

export const PRICES = Object.freeze({
  'gpt-5.6-sol': Object.freeze({ input: 4, cached: 0.4, write: 5, output: 20 }),
  'gpt-6.1-terra': Object.freeze({ input: 1, cached: 0.05, write: 1.25, output: 5 }),
});

const DEAREST = Object.values(PRICES).reduce((a, b) => (Math.max(b.input, b.write) + b.output > Math.max(a.input, a.write) + a.output ? b : a));

export const priceFor = (model) => PRICES[model] ?? DEAREST;

const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/**
 * @param {string} model  the model id the request named
 * @param {{ in?: number, cached?: number, out?: number }|null} usage  tokens of one response
 * @returns {number} whole micro-USD, rounded up
 */
export function costMicroUsd(model, usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const p = priceFor(model);
  // In whole hundredths of a micro-$ per token, so the sum is exact integer arithmetic.
  const cents = (v) => Math.round(v * 100);
  const input = count(usage.in);
  const cached = Math.min(count(usage.cached), input);
  const out = count(usage.out);
  const total = (input - cached) * cents(Math.max(p.input, p.write)) + cached * cents(p.cached) + out * cents(p.output);
  return Math.ceil(total / 100);
}
