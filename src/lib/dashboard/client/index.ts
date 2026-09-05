import { readData } from './data';
import { initNav } from './nav';
import { initChart } from './chart';
import { initLeads } from './leads';
import { initInventory } from './inventory';
import { initCalendar } from './calendar';
import { initChecks } from './checks';
import { initChecklist } from './checklist';
import { storageAvailable } from './storage';
import { $ } from './dom';

export function initDashboard(): void {
  const data = readData();
  const guarded = (name: string, fn: () => void) => {
    try { fn(); } catch (err) { console.error(`[dashboard] ${name} failed`, err); }
  };
  guarded('nav', initNav);
  guarded('chart', initChart);
  guarded('leads', () => initLeads(data));
  guarded('inventory', initInventory);
  guarded('calendar', () => initCalendar(data));
  guarded('checks', () => initChecks(data));
  guarded('checklist', initChecklist);

  const warn = $('#storage-warning');
  if (warn) warn.hidden = storageAvailable();
  document.documentElement.dataset.dashReady = 'true';
}
