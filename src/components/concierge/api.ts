/* Concierge HTTP client. The contract is fixed by the backend workstream (spec §3) — do not change shapes here.

   apiBase override, for QA only (see docs/qa/concierge/README.md):
   - `?concierge_api=<url>` is honoured **only** when the page itself is served from localhost/127.0.0.1 (dev or
     `npm run preview`) *and* the target is a localhost http(s) URL. Anywhere else the parameter is ignored and any
     override left in sessionStorage is dropped, so a crafted production link cannot re-point the widget at a
     stranger's API. It stays sticky for the tab so it survives the `navigate` action.
   - `window.BONA_CONCIERGE_API` still wins on any host, because it can only be set from the console by whoever is
     already sitting at the browser. */

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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The page itself is a dev/preview page — the only place a QA override is allowed to take effect. */
function onLocalPage(): boolean {
  try { return LOCAL_HOSTS.has(window.location.hostname); } catch { return false; }
}

/** A QA override must be a localhost http(s) URL, requested from a localhost page. Anything else is refused. */
function allowedOverride(raw: string): boolean {
  if (!raw || !onLocalPage()) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch { return false; }
}

/** Query param (localhost only, sticky for the tab so it survives the `navigate` action), then the global, then site.json. */
export function resolveApiBase(fallback: string): string {
  let base = '';
  try {
    const q = new URLSearchParams(window.location.search).get('concierge_api');
    const candidate = q ?? sessionStorage.getItem(API_KEY) ?? '';
    if (candidate && allowedOverride(candidate)) {
      base = candidate;
      try { sessionStorage.setItem(API_KEY, candidate); } catch { /* private mode */ }
    } else if (candidate) {
      try { sessionStorage.removeItem(API_KEY); } catch { /* private mode */ }
    }
  } catch { /* private mode */ }
  if (!base) base = (window as unknown as { BONA_CONCIERGE_API?: string }).BONA_CONCIERGE_API || '';
  if (!base) base = fallback || '';
  return base.replace(/\/+$/, '');
}

/** A failed request carries its HTTP status, so callers can tell an expired session (404) from a dead API. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The HTTP status of a rejection, or 0 for a network error / timeout. */
export function statusOf(err: unknown): number {
  return err instanceof ApiError ? err.status : 0;
}

async function request<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new ApiError(res.status);
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
