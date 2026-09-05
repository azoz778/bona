/* Content calendar: month grid built in the browser from the JSON items the
   page injected, plus per-item status overrides in bona.content.v1
   (keyed by `${date}|${topic.en}`). The item list itself is server-rendered. */
import { KEYS, load, save } from './storage';
import { $, $$, el, copyText, toast, fmt, parseDay } from './dom';
import type { DashData, CalendarItem } from './data';

export const STATUS_CYCLE = ['planned', 'drafted', 'published'] as const;
type Status = typeof STATUS_CYCLE[number];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // Saudi week starts Sunday
const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

function platformCode(p: string): string {
  const s = (p || '').toLowerCase();
  if (s.includes('instagram')) return 'IG';
  if (s.includes('tiktok')) return 'TT';
  if (s.includes('linkedin')) return 'LI';
  if (s.includes('snap')) return 'SC';
  if (s.includes('youtube')) return 'YT';
  if (s.includes('whatsapp')) return 'WA';
  if (s === 'x' || s.includes('twitter')) return 'X';
  return (p || '?').slice(0, 2).toUpperCase();
}

export function initCalendar(data: DashData): void {
  const root = $('#content');
  if (!root) return;
  const items = data.calendar;
  const raw = load<unknown>(KEYS.content, {});
  const overrides: Record<string, Status> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if ((STATUS_CYCLE as readonly string[]).includes(String(v))) overrides[k] = v as Status;
    }
  }
  const effective = (it: CalendarItem): Status =>
    overrides[it.key] ?? ((STATUS_CYCLE as readonly string[]).includes(it.status) ? (it.status as Status) : 'planned');

  const itemNodes = new Map<string, HTMLElement>();
  for (const node of $$('[data-cal-key]', root)) itemNodes.set(node.dataset.calKey ?? '', node);

  function paint(it: CalendarItem): void {
    const node = itemNodes.get(it.key);
    if (!node) return;
    const status = effective(it);
    node.dataset.status = status;
    const label = $('[data-cal-status-label]', node);
    if (label) label.textContent = status;
    const btn = $<HTMLButtonElement>('[data-act="cal-status"]', node);
    if (btn) {
      const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(status) + 1) % STATUS_CYCLE.length];
      btn.setAttribute('aria-label', `Status ${status}. Mark as ${next}`);
      btn.title = `Mark as ${next}`;
    }
  }

  function kpis(): void {
    const today = parseDay(fmt.isoDay(new Date()))!;
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + 7);
    let next7 = 0, published = 0;
    for (const it of items) {
      const st = effective(it);
      if (st === 'published') published++;
      const d = parseDay(it.date);
      if (d && d >= today && d < horizon && st !== 'published') next7++;
    }
    const set = (k: string, v: string) => { const n = $(`[data-kpi="${k}"]`); if (n) n.textContent = v; };
    set('content-next7', fmt.number(next7));
    set('content-published', fmt.number(published));
    set('content-total', `${fmt.number(items.length)} in calendar`);
  }

  // ---- month grid ----
  const grid = $('#cal-grid', root);
  const monthLabel = $('#cal-month-label', root);
  const byDate = new Map<string, CalendarItem[]>();
  for (const it of items) {
    const key = (it.date || '').slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(it);
  }
  const todayKey = fmt.isoDay(new Date());
  let cursor = (() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!items.length || items.some(i => (i.date || '').startsWith(thisMonth))) return new Date(now.getFullYear(), now.getMonth(), 1);
    const upcoming = items.map(i => i.date).filter(d => d >= todayKey).sort()[0] ?? [...items].map(i => i.date).sort()[0];
    const d = parseDay(upcoming) ?? now;
    return new Date(d.getFullYear(), d.getMonth(), 1);
  })();

  function renderGrid(): void {
    if (!grid) return;
    const y = cursor.getFullYear(), m = cursor.getMonth();
    if (monthLabel) monthLabel.textContent = monthFmt.format(cursor);
    const startDow = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const cells: HTMLElement[] = WEEKDAYS.map(w => el('div', { class: 'dash-cal-dow', role: 'columnheader', text: w }));
    for (let i = 0; i < startDow; i++) cells.push(el('div', { class: 'dash-cal-cell dash-cal-cell--pad', 'aria-hidden': 'true' }));
    for (let d = 1; d <= days; d++) {
      const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dayItems = byDate.get(key) ?? [];
      const cell = el('div', { class: `dash-cal-cell${key === todayKey ? ' is-today' : ''}`, role: 'gridcell' }, [
        el('div', { class: 'dash-cal-day dash-num', text: String(d) }),
      ]);
      const shown = dayItems.slice(0, 3);
      for (const it of shown) {
        cell.append(el('a', {
          class: 'dash-chip', href: `#cal-item-${it.index}`, 'data-status': effective(it),
          title: `${it.platform} ${it.format}: ${it.topic}`,
        }, [el('span', { class: 'dash-chip-text', text: `${platformCode(it.platform)} ${it.topic}` })]));
      }
      if (dayItems.length > shown.length) cell.append(el('div', { class: 'dash-muted dash-chip-more', text: `+${dayItems.length - shown.length} more` }));
      cells.push(cell);
    }
    // pad the last week so the lattice stays closed (the 7 header cells keep the modulo aligned)
    while (cells.length % 7 !== 0) cells.push(el('div', { class: 'dash-cal-cell dash-cal-cell--pad', 'aria-hidden': 'true' }));
    grid.replaceChildren(...cells);
  }

  $('#cal-prev', root)?.addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); renderGrid(); });
  $('#cal-next', root)?.addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); renderGrid(); });
  $('#cal-today', root)?.addEventListener('click', () => { const n = new Date(); cursor = new Date(n.getFullYear(), n.getMonth(), 1); renderGrid(); });

  // ---- list interactions ----
  root.addEventListener('click', async ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const node = btn.closest<HTMLElement>('[data-cal-key]');
    if (!node) return;
    const it = items.find(i => i.key === node.dataset.calKey);
    if (btn.dataset.act === 'cal-status' && it) {
      const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(effective(it)) + 1) % STATUS_CYCLE.length];
      overrides[it.key] = next;
      if (!save(KEYS.content, overrides)) toast('Could not save. Browser storage is blocked.');
      paint(it); renderGrid(); kpis();
      toast(`${it.topic}: ${next}`);
    }
    if (btn.dataset.act === 'copy') {
      const lang = btn.dataset.lang ?? 'en';
      const caption = $(`[data-caption="${lang}"]`, node)?.textContent?.trim() ?? '';
      const tags = $('[data-hashtags]', node)?.textContent?.trim() ?? '';
      const text = [caption, tags].filter(Boolean).join('\n\n');
      if (!text) return toast('Nothing to copy for this post.');
      toast((await copyText(text)) ? `Copied ${lang.toUpperCase()} caption and hashtags` : 'Copy failed. Select the text and copy it manually.');
    }
  });

  items.forEach(paint);
  renderGrid();
  kpis();
}
