/* Section nav: scroll-spy sets aria-current on the matching link, and on the
   mobile tab strip keeps the active tab scrolled into view. */
import { $$ } from './dom';

export function initNav(): void {
  const links = $$<HTMLAnchorElement>('a[data-nav]');
  const sections = $$<HTMLElement>('section[data-section]');
  if (!links.length || !sections.length || !('IntersectionObserver' in window)) return;

  const byId = new Map(links.map(a => [a.getAttribute('href')?.replace(/^#/, '') ?? '', a]));
  let current = '';
  const setCurrent = (id: string) => {
    if (id === current) return;
    current = id;
    for (const [sid, a] of byId) {
      if (sid === id) { a.setAttribute('aria-current', 'true'); a.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
      else a.removeAttribute('aria-current');
    }
  };

  const visible = new Map<string, number>();
  const io = new IntersectionObserver(entries => {
    for (const e of entries) visible.set((e.target as HTMLElement).id, e.isIntersecting ? e.intersectionRatio : 0);
    // Pick the top-most section that is meaningfully on screen.
    const ordered = sections.filter(s => (visible.get(s.id) ?? 0) > 0);
    if (ordered.length) setCurrent(ordered[0].id);
  }, { rootMargin: '-96px 0px -55% 0px', threshold: [0, 0.1, 0.5] });
  sections.forEach(s => io.observe(s));

  for (const a of links) {
    a.addEventListener('click', () => setCurrent(a.getAttribute('href')?.replace(/^#/, '') ?? ''));
  }
}
