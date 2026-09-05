/* RFC 4180-ish CSV: quoted fields, doubled quotes, newlines inside quotes.
   Export prepends a BOM so Excel opens Arabic names correctly. */

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    let s = v == null ? '' : String(v);
    // Spreadsheet formula-injection guard: neutralise leading = + - @ \t \r so Excel/Sheets treat the cell as text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): Record<string, string>[] {
  const src = (text || '').replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
  const header = nonEmpty.shift();
  if (!header) return [];
  const keys = header.map(h => h.trim().toLowerCase());
  return nonEmpty.map(r => {
    const obj: Record<string, string> = {};
    keys.forEach((k, idx) => { if (k) obj[k] = (r[idx] ?? '').trim(); });
    return obj;
  });
}
