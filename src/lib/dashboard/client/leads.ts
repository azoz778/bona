/* Leads: localStorage-backed CRM table with a <dialog> form, WhatsApp openers,
   CSV import/export and JSON backup/restore. Key: bona.leads.v1 */
import { KEYS, load, save } from './storage';
import { $, $$, el, download, pickFile, toast, uid, fmt } from './dom';
import { toCsv, parseCsv } from './csv';
import type { DashData, ListingSummary } from './data';

export const STAGES = ['New', 'Contacted', 'Viewing', 'Offer', 'Won', 'Lost'] as const;
export const SOURCES = ['WhatsApp', 'Instagram', 'Website', 'Referral', 'Walk-in'] as const;
export const INTERESTS = ['buy', 'rent', 'sell'] as const;
export type Stage = typeof STAGES[number];
export type Source = typeof SOURCES[number];
export type Interest = typeof INTERESTS[number];

export interface Lead {
  id: string; name: string; phone: string; source: Source; interest: Interest;
  propertyId: string; budget: string; stage: Stage; notes: string; createdAt: string; updatedAt: string;
}

const CSV_COLUMNS = ['id', 'name', 'phone', 'source', 'interest', 'propertyId', 'propertyTitle', 'budget', 'stage', 'notes', 'createdAt', 'updatedAt'];

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = String(v ?? '').trim();
  const hit = allowed.find(a => a.toLowerCase() === s.toLowerCase());
  return hit ?? fallback;
};
const str = (v: unknown) => (v == null ? '' : String(v)).trim();

function sanitise(raw: Partial<Record<keyof Lead, unknown>>, listings: ListingSummary[]): Lead | null {
  const name = str(raw.name);
  const phone = str(raw.phone);
  if (!name && !phone) return null;
  const now = new Date().toISOString();
  const propertyId = str(raw.propertyId);
  const createdAt = str(raw.createdAt);
  return {
    id: str(raw.id) || uid(),
    name, phone,
    source: pick(raw.source, SOURCES, 'Website'),
    interest: pick(raw.interest, INTERESTS, 'buy'),
    propertyId: listings.some(l => l.id === propertyId) ? propertyId : '',
    budget: str(raw.budget),
    stage: pick(raw.stage, STAGES, 'New'),
    notes: str(raw.notes),
    createdAt: createdAt && !Number.isNaN(Date.parse(createdAt)) ? createdAt : now,
    updatedAt: str(raw.updatedAt) || now,
  };
}

/** Digits for wa.me. Accepts +966 5x…, 05x…, 5x… (9 digits) and international numbers. */
export function phoneDigits(raw: string): string {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('05')) d = '966' + d.slice(1);
  else if (d.length === 9 && d.startsWith('5')) d = '966' + d;
  return d;
}

export function waOpener(lead: Lead, listing: ListingSummary | undefined, site: DashData['site']): string {
  const name = lead.name || '';
  const ar = listing ? ` بخصوص ${listing.titleAr || listing.title}` : '';
  const en = listing ? ` about ${listing.title}` : '';
  const link = listing && site.url ? `\n${site.url}/properties/${listing.slug}/` : '';
  return `السلام عليكم ${name}، معك ${site.nameAr} العقارية${ar}. يسعدنا مساعدتك، متى يناسبك أن نتواصل؟\n\n` +
    `Hello ${name}, this is ${site.name}${en}. We'd be glad to help. When would suit you for a call?${link}`;
}

class LeadStore {
  leads: Lead[] = [];
  constructor(private listings: ListingSummary[]) {
    const raw = load<unknown>(KEYS.leads, []);
    this.leads = Array.isArray(raw) ? raw.map(r => sanitise(r ?? {}, listings)).filter((l): l is Lead => !!l) : [];
  }
  persist(): void {
    if (!save(KEYS.leads, this.leads)) toast('Could not save. Browser storage is blocked, so this change lasts only for this page view.');
  }
  upsert(lead: Lead): 'new' | 'updated' {
    const i = this.leads.findIndex(l => l.id === lead.id);
    if (i === -1) { this.leads.push(lead); return 'new'; }
    this.leads[i] = lead;
    return 'updated';
  }
  remove(id: string): void { this.leads = this.leads.filter(l => l.id !== id); }
  byId(id: string): Lead | undefined { return this.leads.find(l => l.id === id); }
  listing(id: string): ListingSummary | undefined { return this.listings.find(l => l.id === id); }
}

export function initLeads(data: DashData): void {
  const root = $('#leads');
  if (!root) return;
  const store = new LeadStore(data.listings);
  const tbody = $<HTMLTableSectionElement>('[data-leads-body]', root);
  const empty = $('#leads-empty', root);
  const count = $('#lead-count', root);
  const search = $<HTMLInputElement>('#lead-search', root);
  const stageFilter = $<HTMLSelectElement>('#lead-stage-filter', root);
  const dialog = $<HTMLDialogElement>('#lead-dialog');
  const form = $<HTMLFormElement>('#lead-form');
  const dialogTitle = $('#lead-dialog-title');
  if (!tbody || !dialog || !form) return;

  // Property select: available listings first, then the rest.
  const propSelect = form.elements.namedItem('propertyId') as HTMLSelectElement | null;
  if (propSelect) {
    const sorted = [...data.listings].sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available') || a.title.localeCompare(b.title));
    for (const l of sorted) {
      const label = l.status === 'available' ? `${l.title} (${l.id})` : `${l.title} (${l.id}, ${l.status})`;
      propSelect.append(el('option', { value: l.id, text: label }));
    }
  }

  const stageSelect = (lead: Lead) => {
    const s = el('select', { class: 'dash-input dash-input--sm', 'data-act': 'stage', 'aria-label': `Stage for ${lead.name || lead.phone}` });
    for (const st of STAGES) s.append(el('option', { value: st, text: st, selected: st === lead.stage }));
    return s;
  };

  function render(): void {
    const q = (search?.value ?? '').trim().toLowerCase();
    const st = stageFilter?.value ?? '';
    const rows = store.leads
      .filter(l => !st || l.stage === st)
      .filter(l => {
        if (!q) return true;
        const prop = store.listing(l.propertyId);
        return [l.name, l.phone, l.notes, l.budget, l.source, prop?.title ?? '', l.id].join(' ').toLowerCase().includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    tbody.replaceChildren(...rows.map(lead => {
      const prop = store.listing(lead.propertyId);
      const digits = phoneDigits(lead.phone);
      const wa = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(waOpener(lead, prop, data.site))}` : '';
      return el('tr', { 'data-lead-id': lead.id, 'data-stage': lead.stage }, [
        el('td', {}, [
          el('div', { class: 'dash-strong', text: lead.name || '(no name)' }),
          el('div', { class: 'dash-muted dash-num', text: lead.phone }),
        ]),
        el('td', { text: lead.source }),
        el('td', { text: lead.interest }),
        el('td', {}, prop
          ? [el('a', { class: 'dash-link', href: `${data.site.url}/properties/${prop.slug}/`, target: '_blank', rel: 'noopener', text: prop.title })]
          : [el('span', { class: 'dash-muted', text: '—' })]),
        el('td', { class: 'dash-num', text: lead.budget || '—' }),
        el('td', {}, [stageSelect(lead)]),
        el('td', { class: 'dash-muted dash-num dash-nowrap', text: fmt.date(lead.createdAt) }),
        el('td', { class: 'dash-notes', title: lead.notes, text: lead.notes || '' }),
        el('td', { class: 'dash-nowrap' }, [el('div', { class: 'dash-actions' }, [
          wa ? el('a', { class: 'dash-btn dash-btn--sm', href: wa, target: '_blank', rel: 'noopener', text: 'WhatsApp' })
             : el('span', { class: 'dash-muted', text: 'No number' }),
          el('button', { type: 'button', class: 'dash-btn dash-btn--sm dash-btn--ghost', 'data-act': 'edit', text: 'Edit' }),
          el('button', { type: 'button', class: 'dash-btn dash-btn--sm dash-btn--ghost dash-btn--danger', 'data-act': 'delete', text: 'Delete' }),
        ])]),
      ]);
    }));

    if (empty) empty.hidden = store.leads.length > 0;
    const table = tbody.closest('.dash-table-wrap') as HTMLElement | null;
    if (table) table.hidden = store.leads.length === 0;
    if (count) count.textContent = store.leads.length === rows.length
      ? `${rows.length} ${rows.length === 1 ? 'lead' : 'leads'}`
      : `${rows.length} of ${store.leads.length} leads`;
    renderKpis();
  }

  function renderKpis(): void {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const week = store.leads.filter(l => Date.parse(l.createdAt) >= weekAgo).length;
    const open = store.leads.filter(l => l.stage !== 'Won' && l.stage !== 'Lost').length;
    const set = (k: string, v: string) => { const n = $(`[data-kpi="${k}"]`); if (n) n.textContent = v; };
    set('leads-week', fmt.number(week));
    set('leads-total', fmt.number(store.leads.length));
    set('leads-open', `${fmt.number(open)} open`);
    set('leads-won', `${fmt.number(store.leads.filter(l => l.stage === 'Won').length)} won`);
  }

  function openForm(lead?: Lead): void {
    form.reset();
    (form.elements.namedItem('id') as HTMLInputElement).value = lead?.id ?? '';
    (form.elements.namedItem('createdAt') as HTMLInputElement).value = lead?.createdAt ?? '';
    if (lead) {
      for (const k of ['name', 'phone', 'source', 'interest', 'propertyId', 'budget', 'stage', 'notes'] as const) {
        const field = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
        if (field) field.value = lead[k];
      }
    }
    if (dialogTitle) dialogTitle.textContent = lead ? 'Edit lead' : 'New lead';
    dialog.showModal();
    (form.elements.namedItem('name') as HTMLInputElement | null)?.focus();
  }

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const nameField = form.elements.namedItem('name') as HTMLInputElement;
    const phoneField = form.elements.namedItem('phone') as HTMLInputElement;
    const name = str(fd.get('name'));
    const phone = str(fd.get('phone'));
    nameField.setCustomValidity(name ? '' : 'Add the person\'s name.');
    phoneField.setCustomValidity(phone && phoneDigits(phone).length >= 8 ? '' : 'Add a phone number with country code, e.g. +966 5x xxx xxxx.');
    if (!form.reportValidity()) return;
    const existing = store.byId(str(fd.get('id')));
    const lead = sanitise({
      id: str(fd.get('id')) || undefined,
      name, phone,
      source: fd.get('source'), interest: fd.get('interest'), propertyId: fd.get('propertyId'),
      budget: fd.get('budget'), stage: fd.get('stage'), notes: fd.get('notes'),
      createdAt: existing?.createdAt ?? str(fd.get('createdAt')),
      updatedAt: new Date().toISOString(),
    }, data.listings);
    if (!lead) return;
    const result = store.upsert(lead);
    store.persist();
    dialog.close();
    render();
    toast(result === 'new' ? `Saved ${lead.name}` : `Updated ${lead.name}`);
  });
  form.addEventListener('input', ev => { (ev.target as HTMLInputElement).setCustomValidity?.(''); });
  $('[data-act="cancel"]', dialog)?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', ev => { if (ev.target === dialog) dialog.close(); });

  tbody.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr[data-lead-id]');
    if (!btn || !tr) return;
    const lead = store.byId(tr.dataset.leadId ?? '');
    if (!lead) return;
    if (btn.dataset.act === 'edit') openForm(lead);
    if (btn.dataset.act === 'delete') {
      if (window.confirm(`Delete ${lead.name || lead.phone}? This cannot be undone.`)) {
        store.remove(lead.id); store.persist(); render(); toast(`Deleted ${lead.name || lead.phone}`);
      }
    }
  });
  tbody.addEventListener('change', ev => {
    const sel = ev.target as HTMLSelectElement;
    if (sel.dataset.act !== 'stage') return;
    const tr = sel.closest<HTMLElement>('tr[data-lead-id]');
    const lead = store.byId(tr?.dataset.leadId ?? '');
    if (!lead) return;
    lead.stage = pick(sel.value, STAGES, lead.stage);
    lead.updatedAt = new Date().toISOString();
    store.persist();
    if (tr) tr.dataset.stage = lead.stage;
    renderKpis();
    if (stageFilter?.value) render();
  });

  search?.addEventListener('input', render);
  stageFilter?.addEventListener('change', render);
  $('[data-action="lead-add"]', root)?.addEventListener('click', () => openForm());

  $('[data-action="lead-export-csv"]', root)?.addEventListener('click', () => {
    if (!store.leads.length) return toast('No leads to export yet.');
    const rows = store.leads.map(l => ({ ...l, propertyTitle: store.listing(l.propertyId)?.title ?? '' }));
    download(`bona-leads-${fmt.isoDay(new Date())}.csv`, toCsv(CSV_COLUMNS, rows), 'text/csv');
    toast(`Exported ${rows.length} leads as CSV`);
  });

  $('[data-action="lead-import-csv"]', root)?.addEventListener('click', async () => {
    const file = await pickFile('.csv,text/csv');
    if (!file) return;
    const parsed = parseCsv(file.text);
    if (!parsed.length) return toast('Nothing to import. The first row must be the column names.');
    let added = 0, updated = 0, skipped = 0;
    for (const row of parsed) {
      const lead = sanitise({
        id: row.id, name: row.name, phone: row.phone, source: row.source, interest: row.interest,
        propertyId: row.propertyid, budget: row.budget, stage: row.stage, notes: row.notes,
        createdAt: row.createdat, updatedAt: row.updatedat,
      }, data.listings);
      if (!lead) { skipped++; continue; }
      if (!lead.propertyId && row.propertytitle) {
        lead.propertyId = data.listings.find(l => l.title.toLowerCase() === row.propertytitle.toLowerCase())?.id ?? '';
      }
      store.upsert(lead) === 'new' ? added++ : updated++;
    }
    store.persist();
    render();
    toast(`Imported ${added} new, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}`);
  });

  $('[data-action="lead-backup-json"]', root)?.addEventListener('click', () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), leads: store.leads };
    download(`bona-leads-backup-${fmt.isoDay(new Date())}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast(`Backed up ${store.leads.length} leads`);
  });

  $('[data-action="lead-restore-json"]', root)?.addEventListener('click', async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let parsed: unknown;
    try { parsed = JSON.parse(file.text); } catch { return toast('That file is not valid JSON.'); }
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { leads?: unknown })?.leads) ? (parsed as { leads: unknown[] }).leads : null;
    if (!list) return toast('Expected a backup made by this page (an array of leads).');
    const leads = list.map(r => sanitise((r ?? {}) as Partial<Lead>, data.listings)).filter((l): l is Lead => !!l);
    if (!window.confirm(`Replace the ${store.leads.length} leads in this browser with the ${leads.length} in ${file.name}?`)) return;
    store.leads = leads;
    store.persist();
    render();
    toast(`Restored ${leads.length} leads`);
  });

  render();
}
