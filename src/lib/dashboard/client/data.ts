/* The build-time payload the page hands to the browser, via
   <script type="application/json" id="dash-data">. Keep in sync with
   src/pages/dashboard/index.astro. */

export interface ListingSummary {
  id: string; slug: string; title: string; titleAr: string; district: string; status: string; category: string;
  kind?: string; tour?: boolean;   // round 2: derived kind, has virtualTourUrl
}

export interface CalendarItem {
  index: number;       // position in content-calendar.json
  key: string;         // `${date}|${topic.en}` — the localStorage status key
  date: string;        // YYYY-MM-DD
  platform: string;
  format: string;
  pillar: string;
  topic: string;
  status: string;      // status from the JSON (planned | drafted | published)
}

export interface CheckTarget { label: string; url: string }

export interface DashData {
  site: { name: string; nameAr: string; url: string; wa: string };
  builtAt: string;
  listings: ListingSummary[];
  calendar: CalendarItem[];
  checks: CheckTarget[];
}

export function readData(): DashData {
  const empty: DashData = { site: { name: 'Bona', nameAr: 'بونا', url: '', wa: '' }, builtAt: '', listings: [], calendar: [], checks: [] };
  try {
    const node = document.getElementById('dash-data');
    if (!node?.textContent) return empty;
    const parsed = JSON.parse(node.textContent) as Partial<DashData>;
    return {
      site: { ...empty.site, ...(parsed.site ?? {}) },
      builtAt: parsed.builtAt ?? '',
      listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      calendar: Array.isArray(parsed.calendar) ? parsed.calendar : [],
      checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    };
  } catch {
    return empty;
  }
}
