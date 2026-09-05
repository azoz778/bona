/* Launch checklist ticks, persisted in bona.checklist.v1 as { [id]: true }. */
import { KEYS, load, save } from './storage';
import { $, $$ } from './dom';
import { toast } from './dom';

export function initChecklist(): void {
  const root = $('#checklist');
  if (!root) return;
  const boxes = $$<HTMLInputElement>('input[type="checkbox"][data-check-id]', root);
  const raw = load<unknown>(KEYS.checklist, {});
  const state: Record<string, true> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === true) state[k] = true;
  }

  function paint(): void {
    let done = 0;
    const groups = new Map<string, { done: number; total: number }>();
    for (const box of boxes) {
      const id = box.dataset.checkId ?? '';
      box.checked = !!state[id];
      const li = box.closest<HTMLElement>('[data-check-item]');
      if (li) li.dataset.done = box.checked ? 'true' : 'false';
      const g = box.dataset.group ?? '';
      const entry = groups.get(g) ?? { done: 0, total: 0 };
      entry.total++;
      if (box.checked) { entry.done++; done++; }
      groups.set(g, entry);
    }
    const total = boxes.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const fill = $('#checklist-fill', root);
    if (fill) fill.style.width = `${pct}%`;
    const meter = $('#checklist-meter', root);
    if (meter) { meter.setAttribute('aria-valuenow', String(done)); meter.setAttribute('aria-valuemax', String(total)); }
    const count = $('#checklist-count', root);
    if (count) count.textContent = `${done} of ${total} done`;
    const pctNode = $('#checklist-pct', root);
    if (pctNode) pctNode.textContent = `${pct}%`;
    const kpi = $('[data-kpi="checklist"]');
    if (kpi) kpi.textContent = `${done}/${total}`;
    for (const [g, e] of groups) {
      const n = $(`[data-group-count="${CSS.escape(g)}"]`, root);
      if (n) n.textContent = `${e.done}/${e.total}`;
    }
  }

  root.addEventListener('change', ev => {
    const box = ev.target as HTMLInputElement;
    if (!box.matches('input[type="checkbox"][data-check-id]')) return;
    const id = box.dataset.checkId ?? '';
    if (box.checked) state[id] = true; else delete state[id];
    if (!save(KEYS.checklist, state)) toast('Could not save. Browser storage is blocked.');
    paint();
  });

  $('[data-action="checklist-reset"]', root)?.addEventListener('click', () => {
    if (!Object.keys(state).length) return;
    if (!window.confirm('Clear every tick on the launch checklist?')) return;
    for (const k of Object.keys(state)) delete state[k];
    save(KEYS.checklist, state);
    paint();
  });

  paint();
}
