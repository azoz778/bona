/* Hover/focus tooltip for the inline-SVG district bars. Values are also
   labelled on the marks and repeated in the table view, so the tooltip
   enhances and never gates. */
import { $, $$ } from './dom';

export function initChart(): void {
  const wrap = $('[data-chart="districts"]');
  if (!wrap) return;
  const tip = $('[data-chart-tip]', wrap);
  const bars = $$<SVGGElement>('g.bar', wrap);
  if (!tip || !bars.length) return;

  const show = (bar: SVGGElement, x: number, y: number) => {
    const value = bar.dataset.value ?? '';
    const label = bar.dataset.label ?? '';
    tip.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = `${value} ${value === '1' ? 'listing' : 'listings'}`;
    const span = document.createElement('span');
    span.textContent = label;
    tip.append(strong, span);
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(x - r.left + 12, 8), r.width - tip.offsetWidth - 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${y - r.top - tip.offsetHeight - 10}px`;
  };
  const hide = () => { tip.hidden = true; };

  for (const bar of bars) {
    bar.addEventListener('pointermove', ev => show(bar, ev.clientX, ev.clientY));
    bar.addEventListener('pointerleave', hide);
    bar.addEventListener('focus', () => { const b = bar.getBoundingClientRect(); show(bar, b.left + b.width / 2, b.top); });
    bar.addEventListener('blur', hide);
  }
}
