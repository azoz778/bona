/* DOM builders for the concierge panel. Everything is built with textContent — never innerHTML on API content. */

import type { Card, Loc } from './api';

export interface PluralForms { en: [string, string]; ar: { zero: string; one: string; two: string; few: string; many: string; other: string } }

export interface ConciergeConfig {
  enabled: boolean;
  apiBase: string;
  locale: Loc;
  name: string;
  waHref: string;
  propertiesBase: string;
  /* Only the strings JS has to invent at runtime; everything else is server-rendered in the panel markup. */
  strings: {
    opening: string;
    view: string;
    you: string;
    agent: string;
    sqm: string;
    whatsapp: string;
    micDenied: string;
    callFailed: string;
    callUnsupported: string;
  };
  plurals: { bed: PluralForms; bath: PluralForms };
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function num(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

function plural(n: number, forms: PluralForms, locale: Loc): string {
  if (locale !== 'ar') return `${n} ${n === 1 ? forms.en[0] : forms.en[1]}`;
  let cat: keyof PluralForms['ar'] = 'other';
  try { cat = new Intl.PluralRules('ar').select(n) as keyof PluralForms['ar']; } catch { /* older engines */ }
  return (forms.ar[cat] ?? forms.ar.other).replace('{n}', num(n));
}

/** Card links stay on this site: an off-origin url from the API falls back to the local property page. */
function cardHref(card: Card, cfg: ConciergeConfig): string {
  const local = card.slug ? `${cfg.propertiesBase}${card.slug}/` : cfg.propertiesBase;
  const fromApi = card.url?.[cfg.locale] || card.url?.en;
  if (!fromApi) return local;
  try {
    const url = new URL(fromApi, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search : local;
  } catch { return local; }
}

/** Inline listing card (chat `show_listing` action and the call's "mentioned properties" list). */
export function listingCard(card: Card, cfg: ConciergeConfig): HTMLElement {
  const loc = cfg.locale;
  const title = card.title?.[loc] || card.title?.en || '';
  const article = el('article', 'cg-card');
  const link = el('a', 'cg-card-link');
  link.href = cardHref(card, cfg);
  link.setAttribute('data-concierge-card-link', '');

  const thumb = card.image?.thumb || card.image?.src;
  if (thumb) {
    const media = el('span', 'cg-card-media');
    const img = el('img');
    img.src = thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    media.append(img);
    link.append(media);
  }

  const body = el('span', 'cg-card-body');
  body.append(el('span', 'cg-card-title', title));

  const district = card.district?.[loc] || card.district?.en || '';
  if (district) body.append(el('span', 'cg-card-meta', district));

  const price = card.price?.[loc] || card.price?.en || '';
  if (price) body.append(el('span', 'cg-card-price', price));

  const specs: string[] = [];
  if (card.beds) specs.push(plural(card.beds, cfg.plurals.bed, loc));
  if (card.baths) specs.push(plural(card.baths, cfg.plurals.bath, loc));
  if (card.areaSqm) specs.push(`${num(card.areaSqm)} ${cfg.strings.sqm}`);
  if (specs.length) body.append(el('span', 'cg-card-specs', specs.join('  ·  ')));

  const view = el('span', 'cg-card-view');
  view.append(el('span', undefined, cfg.strings.view), chevron());
  body.append(view);

  link.append(body);
  article.append(link);
  return article;
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'cg-chevron');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M9 5l7 7-7 7');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

/** A chat bubble. `who` is announced to screen readers, visually hidden. */
export function bubble(role: 'agent' | 'user', text: string, who: string): HTMLElement {
  const wrap = el('div', `cg-msg cg-msg-${role}`);
  wrap.append(el('span', 'cg-sr', `${who}: `));
  const body = el('div', 'cg-bubble');
  for (const [i, line] of text.split(/\n+/).map(s => s.trim()).filter(Boolean).entries()) {
    body.append(el('p', i ? 'cg-p' : undefined, line));
  }
  if (!body.childNodes.length) body.append(el('p', undefined, text));
  wrap.append(body);
  return wrap;
}

/** A quiet system note (navigating, lead saved, new conversation). */
export function note(text: string): HTMLElement {
  return el('p', 'cg-note', text);
}
