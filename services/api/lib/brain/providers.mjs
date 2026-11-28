/**
 * The AI providers the brain may call (brain/DESIGN-brain.md §2.1, §11.3). Pinned: each one is
 * named on the privacy page before the code may call it, so adding a provider is always a
 * privacy release first (scripts/test/privacy-policy.test.mjs reads PROVIDERS from this file).
 * Never DeepSeek, xAI, Hermes, Retell or any subscription login.
 *
 * A base URL is accepted only when it is https, on a host listed for a provider in PROVIDERS,
 * on the default port and without credentials in it; anything else is no provider, and the
 * brain stays unconfigured rather than send the key there.
 */

export const PROVIDERS = Object.freeze(['openai']);

/** The API hosts each provider answers on. */
export const PROVIDER_HOSTS = Object.freeze({ openai: Object.freeze(['api.openai.com']) });

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * @param {unknown} baseUrl
 * @returns {string|null} the provider id the URL belongs to, or null
 */
export function providerFor(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl) return null;
  let url;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return PROVIDERS.find((p) => PROVIDER_HOSTS[p]?.includes(host)) ?? null;
}
