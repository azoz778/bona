/* Live URL checks for the integrations board. Each target is fetched with a
   5 s timeout. A CORS-readable response gives a real status; a no-cors
   (opaque) response only proves the host answered, so it shows as "unknown". */
import { KEYS, load, save } from './storage';
import { $, $$, fmt } from './dom';
import type { DashData } from './data';

type Result = { state: 'live' | 'down' | 'unknown' | 'checking'; note: string };

async function fetchWithTimeout(url: string, mode: RequestMode, ms = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { method: 'GET', mode, cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function check(url: string): Promise<Result> {
  try {
    const res = await fetchWithTimeout(url, 'cors');
    if (res.type === 'opaque') return { state: 'unknown', note: 'reachable, status hidden' };
    return res.ok ? { state: 'live', note: `HTTP ${res.status}` } : { state: 'down', note: `HTTP ${res.status}` };
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { state: 'down', note: 'timed out after 5 s' };
  }
  try {
    const res = await fetchWithTimeout(url, 'no-cors');
    return res.type === 'opaque' ? { state: 'unknown', note: 'reachable, status hidden by CORS' } : { state: 'live', note: `HTTP ${res.status}` };
  } catch (err) {
    return (err as Error)?.name === 'AbortError'
      ? { state: 'down', note: 'timed out after 5 s' }
      : { state: 'down', note: 'no response (DNS, TLS or network)' };
  }
}

export function initChecks(data: DashData): void {
  const root = $('#integrations');
  if (!root) return;
  const rows = $$<HTMLElement>('[data-check-url]', root);
  const timeNode = $('#checks-time', root);
  const button = $<HTMLButtonElement>('[data-action="recheck"]', root);
  if (!rows.length) return;

  const paint = (row: HTMLElement, r: Result) => {
    const pill = $('[data-check-pill]', row);
    const note = $('[data-check-note]', row);
    if (pill) { pill.dataset.state = r.state; pill.textContent = r.state; }
    if (note) note.textContent = r.note;
  };

  // Show the last stored result immediately, then refresh.
  const stored = load<{ at?: string; results?: Record<string, Result> } | null>(KEYS.checks, null);
  if (stored?.results) {
    for (const row of rows) { const r = stored.results[row.dataset.checkUrl ?? '']; if (r) paint(row, r); }
    if (timeNode && stored.at) timeNode.textContent = `Last checked ${fmt.date(stored.at)} ${fmt.time(new Date(stored.at))}`;
  }

  let running = false;
  async function run(): Promise<void> {
    if (running) return;
    running = true;
    if (button) button.disabled = true;
    if (timeNode) timeNode.textContent = 'Checking…';
    for (const row of rows) paint(row, { state: 'checking', note: '' });
    const results: Record<string, Result> = {};
    await Promise.all(rows.map(async row => {
      const url = row.dataset.checkUrl ?? '';
      const r = await check(url);
      results[url] = r;
      paint(row, r);
    }));
    const at = new Date();
    save(KEYS.checks, { at: at.toISOString(), results });
    if (timeNode) timeNode.textContent = `Checked ${fmt.date(at)} at ${fmt.time(at)}`;
    const summary = $('[data-kpi="checks"]');
    if (summary) summary.textContent = `${Object.values(results).filter(r => r.state === 'live').length}/${rows.length} live`;
    if (button) button.disabled = false;
    running = false;
  }

  button?.addEventListener('click', run);
  // Defer so the first paint isn't blocked and the page never waits on the network.
  window.setTimeout(run, 300);
  void data;
}
