/* localStorage wrapper. Every access is guarded: private windows, blocked
   site data and quota errors all degrade to "works for this page view". */

export const KEYS = {
  leads: 'bona.leads.v1',
  content: 'bona.content.v1',
  checklist: 'bona.checklist.v1',
  checks: 'bona.checks.v1',
} as const;

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function storageAvailable(): boolean {
  try {
    const probe = '__bona_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}
