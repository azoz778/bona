/* Concierge HTTP client. The contract is fixed by the backend workstream (spec §3) — do not change shapes here.
   apiBase is overridable at runtime for QA: ?concierge_api=<url> (sticky for the tab) or window.BONA_CONCIERGE_API. */

export type Loc = 'en' | 'ar';

export interface Card {
  id: string;
  slug: string;
  title: { en: string; ar: string };
  district?: { en: string; ar: string } | null;
  price?: { en: string; ar: string } | null;
  beds?: number | null;
  baths?: number | null;
  areaSqm?: number | null;
  image?: { src?: string | null; thumb?: string | null } | null;
  url?: { en: string; ar: string } | null;
}

export type ChatAction =
  | { type: 'show_listing'; listing: Card }
  | { type: 'navigate'; path: string }
  | { type: 'whatsapp'; message?: string };

export interface ChatSessionResponse { sessionId: string; greeting?: string }
export interface ChatMessageResponse {
  messages?: { role?: string; text?: string }[];
  actions?: ChatAction[];
  leadCaptured?: boolean;
}
export interface CallTokenResponse { accessToken: string; callId: string }
export interface CallContextResponse { listings?: Card[]; updatedAt?: string }

export const API_KEY = 'bona.concierge.api';

/** Query param wins (and sticks for the tab, so it survives the `navigate` action), then the global, then site.json. */
export function resolveApiBase(fallback: string): string {
  let base = '';
  try {
    const q = new URLSearchParams(window.location.search).get('concierge_api');
    if (q) { base = q; try { sessionStorage.setItem(API_KEY, q); } catch {} }
    else base = sessionStorage.getItem(API_KEY) || '';
  } catch { /* private mode */ }
  if (!base) base = (window as unknown as { BONA_CONCIERGE_API?: string }).BONA_CONCIERGE_API || '';
  if (!base) base = fallback || '';
  return base.replace(/\/+$/, '');
}

async function request<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export function postJson<T>(base: string, path: string, body: unknown, timeoutMs = 20000): Promise<T> {
  return request<T>(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs);
}

export function getJson<T>(base: string, path: string, timeoutMs = 6000): Promise<T> {
  return request<T>(`${base}${path}`, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs);
}

/** Fire-and-forget (used to close a chat session on "new conversation"). */
export function postBeacon(base: string, path: string, body: unknown): void {
  try {
    const payload = JSON.stringify(body);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(`${base}${path}`, new Blob([payload], { type: 'application/json' }));
      return;
    }
    void fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  } catch { /* ignore */ }
}
