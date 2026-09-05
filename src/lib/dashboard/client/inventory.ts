/* Inventory table: client-side sort (click a column header) and filter over
   the server-rendered rows. Row data lives in data-* attributes:
   category, status, kind, tour ("1" when a virtualTourUrl exists), search. */
import { $, $$ } from './dom';

const NUMERIC = new Set(['price', 'images']);

export function initInventory(): void {
  const root = $('#inventory');
  if (!root) return;
  const table = $<HTMLTableElement>('#inventory-table', root);
  const tbody = table?.tBodies[0];
  if (!table || !tbody) return;
  const rows = Array.from(tbody.rows) as HTMLTableRowElement[];
  const search = $<HTMLInputElement>('#inv-search', root);
  const category = $<HTMLSelectElement>('#inv-category', root);
  const status = $<HTMLSelectElement>('#inv-status', root);
  const kind = $<HTMLSelectElement>('#inv-kind', root);
  const tourMissing = $<HTMLInputElement>('#inv-tour-missing', root);
  const count = $('#inv-count', root);
  const empty = $('#inv-empty', root);
  let sortKey = 'id';
  let sortDir: 1 | -1 = 1;

  function apply(): void {
    const q = (search?.value ?? '').trim().toLowerCase();
    const cat = category?.value ?? '';
    const st = status?.value ?? '';
    const kd = kind?.value ?? '';
    const noTour = tourMissing?.checked ?? false;
    let shown = 0;
    for (const r of rows) {
      const ok = (!cat || r.dataset.category === cat)
        && (!st || r.dataset.status === st)
        && (!kd || r.dataset.kind === kd)
        && (!noTour || r.dataset.tour !== '1')
        && (!q || (r.dataset.search ?? '').includes(q));
      r.hidden = !ok;
      if (ok) shown++;
    }
    const sorted = [...rows].sort((a, b) => {
      const ka = a.dataset[sortKey] ?? '', kb = b.dataset[sortKey] ?? '';
      const cmp = NUMERIC.has(sortKey) ? Number(ka) - Number(kb) : ka.localeCompare(kb, undefined, { numeric: true, sensitivity: 'base' });
      return cmp * sortDir;
    });
    tbody.replaceChildren(...sorted);
    if (count) count.textContent = shown === rows.length ? `${rows.length} listings` : `${shown} of ${rows.length} listings`;
    if (empty) empty.hidden = shown > 0 || rows.length === 0;
    for (const th of $$('th[data-sort]', table)) {
      th.setAttribute('aria-sort', th.dataset.sort === sortKey ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    }
  }

  for (const th of $$('th[data-sort]', table)) {
    const btn = $('button', th) ?? th;
    btn.addEventListener('click', () => {
      const key = th.dataset.sort ?? 'id';
      if (key === sortKey) sortDir = sortDir === 1 ? -1 : 1;
      else { sortKey = key; sortDir = NUMERIC.has(key) ? -1 : 1; }
      apply();
    });
  }
  search?.addEventListener('input', apply);
  category?.addEventListener('change', apply);
  status?.addEventListener('change', apply);
  kind?.addEventListener('change', apply);
  tourMissing?.addEventListener('change', apply);
  // Overview "3D tours" tile and the table note deep-link here with the filter pre-armed.
  $$<HTMLElement>('[data-action="filter-tour-missing"]').forEach(btn => btn.addEventListener('click', () => {
    if (tourMissing) tourMissing.checked = true;
    apply();
  }));
  apply();
}
