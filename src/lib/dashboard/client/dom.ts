/* Small DOM helpers. Everything user-supplied goes through textContent —
   never innerHTML — so lead names, notes and CSV cells can't inject markup. */

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null =>
  root.querySelector(sel) as T | null;

export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  Array.from(root.querySelectorAll(sel)) as T[];

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function download(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** Opens a file picker and resolves with the file's text (null if cancelled). */
export function pickFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise(resolve => {
    const input = el('input', { type: 'file', accept, hidden: true });
    document.body.append(input);
    let settled = false;
    const finish = (v: { name: string; text: string } | null) => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      file.text().then(text => finish({ name: file.name, text })).catch(() => finish(null));
    });
    // If the dialog is dismissed the change event never fires; clean up on the next focus.
    window.addEventListener('focus', () => window.setTimeout(() => finish(null), 800), { once: true });
    input.click();
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = el('textarea', { 'aria-hidden': 'true' });
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

let toastTimer: number | undefined;
export function toast(message: string): void {
  const t = $('#dash-toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, 2800);
}

export function uid(prefix = 'L'): string {
  const time = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${time}${rand}`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export const fmt = {
  date(iso: string | Date): string {
    const d = typeof iso === 'string' ? new Date(iso) : iso;
    return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
  },
  time(d: Date): string { return timeFmt.format(d); },
  /** Local calendar day as YYYY-MM-DD (no timezone drift from toISOString). */
  isoDay(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  number(n: number): string { return new Intl.NumberFormat('en-US').format(n); },
};

/** Parse a YYYY-MM-DD string as a local date (so "2026-09-05" is Sept 5 everywhere). */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
