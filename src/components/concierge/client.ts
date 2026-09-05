/* Concierge panel controller.

   Lifecycle: the module runs once. The controller lives in module scope and re-binds to the DOM on every
   `astro:page-load`, releasing it on `astro:before-swap` — so a conversation (and a running voice call) survive
   in-site navigation, while the per-page WhatsApp deep link is re-rendered normally.
   Chat state is mirrored into sessionStorage so a hard reload restores it too. */

import { navigate } from 'astro:transitions/client';
import { postBeacon, postJson, resolveApiBase, type Card, type ChatAction, type ChatMessageResponse, type ChatSessionResponse } from './api';
import { bubble, el, listingCard, note, type ConciergeConfig } from './render';
import { browserSupportsCall, CallSession } from './call';

type Item =
  | { t: 'agent'; text: string }
  | { t: 'user'; text: string }
  | { t: 'card'; card: Card }
  | { t: 'wa'; text: string }
  | { t: 'note'; text: string };

interface ChatState { sessionId: string | null; items: Item[]; greeted: boolean; quickUsed: boolean }

const UI_KEY = 'bona.concierge.ui';
const chatKey = (locale: string) => `bona.chat.${locale}`;

const read = (key: string): unknown => {
  try { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const write = (key: string, value: unknown) => {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
};
const drop = (key: string) => { try { sessionStorage.removeItem(key); } catch { /* ignore */ } };

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isSheet = () => window.matchMedia('(max-width: 639px)').matches;

/** Only ever navigate inside this site: API-supplied paths are resolved against our own origin. */
function samePath(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}

class Concierge {
  private cfg: ConciergeConfig | null = null;
  private root: HTMLElement | null = null;
  private q = <T extends HTMLElement = HTMLElement>(sel: string) => this.root?.querySelector<T>(sel) ?? null;

  private chat: ChatState = { sessionId: null, items: [], greeted: false, quickUsed: false };
  private call = new CallSession();

  private open = false;
  private tab: 'chat' | 'call' = 'chat';
  private busy = false;
  private typing = false;
  private offline = false;
  private lastSent = '';
  private modal = false;
  private timer = 0;
  private navTimer = 0;
  private off: (() => void)[] = [];

  constructor() {
    this.call.onChange = () => this.renderCall();
  }

  /* ---------------------------------------------------------------- binding */

  bind(root: HTMLElement) {
    this.root = root;
    try { this.cfg = JSON.parse(root.dataset.config || '{}') as ConciergeConfig; } catch { return; }
    if (!this.cfg?.enabled) return;
    this.cfg.apiBase = resolveApiBase(this.cfg.apiBase);

    const on = <K extends keyof HTMLElementEventMap>(target: EventTarget | null, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      if (!target) return;
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    on(this.q('[data-cg-open]'), 'click', () => this.setOpen(true));
    on(this.q('[data-cg-close]'), 'click', () => this.setOpen(false));
    on(this.q('[data-cg-scrim]'), 'click', () => this.setOpen(false));
    this.root.querySelectorAll<HTMLButtonElement>('[data-cg-tab]').forEach(btn =>
      on(btn, 'click', () => this.setTab((btn.dataset.cgTab as 'chat' | 'call') || 'chat')));
    this.root.querySelectorAll<HTMLButtonElement>('[data-cg-quick-btn]').forEach(btn =>
      on(btn, 'click', () => { this.hideQuick(); void this.send(btn.dataset.text || btn.textContent || ''); }));
    on(this.q('[data-cg-new]'), 'click', () => void this.reset());
    on(this.q('[data-cg-retry]'), 'click', () => void this.retry());
    on(this.q('[data-cg-call-start]'), 'click', () => void this.startCall());
    on(this.q('[data-cg-end]'), 'click', () => this.call.end());
    on(this.q('[data-cg-mute]'), 'click', () => this.call.toggleMute());

    const form = this.q<HTMLFormElement>('[data-cg-form]');
    const input = this.q<HTMLTextAreaElement>('[data-cg-input]');
    on(form, 'submit', e => { e.preventDefault(); const v = input?.value ?? ''; if (input) { input.value = ''; this.grow(input); } void this.send(v); });
    on(input, 'keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form?.requestSubmit(); }
    });
    on(input, 'input', () => input && this.grow(input));

    on(this.q('[data-cg-panel]'), 'keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); this.setOpen(false); }
      else if (e.key === 'Tab') this.trap(e);
    });

    // Page-level triggers ("Ask Dana" links). Re-queried per page.
    document.querySelectorAll<HTMLElement>('[data-concierge-trigger]').forEach(trigger =>
      on(trigger, 'click', e => {
        e.preventDefault();
        this.setOpen(true, (trigger.dataset.conciergeTab as 'chat' | 'call') || 'chat', trigger.dataset.conciergeMessage);
      }));

    this.restore();
  }

  unbind() {
    this.stopTicker();
    if (this.navTimer) { window.clearTimeout(this.navTimer); this.navTimer = 0; }
    this.releaseModal();
    for (const fn of this.off) fn();
    this.off = [];
    this.root = null;
  }

  /* ------------------------------------------------------------ open / tabs */

  private restore() {
    const ui = read(UI_KEY) as { open?: boolean; tab?: string } | null;
    const stored = read(chatKey(this.cfg!.locale)) as ChatState | null;
    if (stored && Array.isArray(stored.items)) this.chat = { sessionId: stored.sessionId ?? null, items: stored.items, greeted: !!stored.greeted, quickUsed: !!stored.quickUsed };
    this.tab = this.call.active ? 'call' : (ui?.tab === 'call' && this.call.active ? 'call' : 'chat');
    this.renderChat();
    this.renderCall();
    this.applyTab();
    if (ui?.open || this.call.active) this.setOpen(true, this.tab, undefined, false);
    this.q('[data-cg-open]')?.classList.toggle('is-live', this.call.active);
  }

  private persistUi() { write(UI_KEY, { open: this.open, tab: this.tab }); }
  private persistChat() { write(chatKey(this.cfg!.locale), this.chat); }

  setOpen(open: boolean, tab?: 'chat' | 'call', prefill?: string, focus = true) {
    if (!this.cfg?.enabled || !this.root) return;
    const panel = this.q('[data-cg-panel]');
    const scrim = this.q('[data-cg-scrim]');
    const opener = this.q<HTMLButtonElement>('[data-cg-open]');
    if (!panel || !opener) return;

    this.open = open;
    if (tab) this.tab = tab;
    this.root.classList.toggle('is-open', open);
    if (!focus) panel.classList.add('cg-no-anim');
    panel.classList.toggle('is-open', open);
    panel.toggleAttribute('inert', !open);
    panel.setAttribute('aria-hidden', String(!open));
    scrim?.classList.toggle('is-open', open);
    opener.setAttribute('aria-expanded', String(open));
    if (!focus) requestAnimationFrame(() => panel.classList.remove('cg-no-anim'));

    if (open) {
      this.applyTab();
      if (isSheet()) this.takeModal(); else this.releaseModal();
      if (prefill) {
        const input = this.q<HTMLTextAreaElement>('[data-cg-input]');
        if (input) { input.value = prefill; this.grow(input); }
      }
      if (focus) {
        const target = this.tab === 'chat' ? this.q<HTMLElement>('[data-cg-input]') : this.q<HTMLElement>('[data-cg-call-start]');
        window.setTimeout(() => (target ?? panel).focus({ preventScroll: true }), reduced() ? 0 : 220);
      } else {
        panel.focus({ preventScroll: true });
      }
      void this.ensureSession();
      this.scrollLog(false);
    } else {
      this.releaseModal();
      if (focus) opener.focus({ preventScroll: true });
    }
    this.persistUi();
  }

  private setTab(tab: 'chat' | 'call') {
    this.tab = tab;
    this.applyTab();
    this.persistUi();
    const target = tab === 'chat' ? this.q<HTMLElement>('[data-cg-input]') : this.q<HTMLElement>('[data-cg-call-start]');
    target?.focus({ preventScroll: true });
    if (tab === 'chat') this.scrollLog(false);
  }

  private applyTab() {
    this.root?.querySelectorAll<HTMLButtonElement>('[data-cg-tab]').forEach(btn => {
      const on = btn.dataset.cgTab === this.tab;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    this.root?.querySelectorAll<HTMLElement>('[data-cg-pane]').forEach(pane => {
      pane.hidden = pane.dataset.cgPane !== this.tab;
    });
  }

  /* --------------------------------------------------------- modal plumbing */

  private takeModal() {
    if (this.modal) return;
    this.modal = true;
    document.body.classList.add('concierge-open');
    this.q('[data-cg-panel]')?.setAttribute('aria-modal', 'true');
    for (const sel of ['main', 'footer', '[data-header]', '[data-drawer]']) document.querySelector(sel)?.setAttribute('inert', '');
  }

  private releaseModal() {
    if (!this.modal) return;
    this.modal = false;
    document.body.classList.remove('concierge-open');
    this.q('[data-cg-panel]')?.removeAttribute('aria-modal');
    for (const sel of ['main', 'footer', '[data-header]', '[data-drawer]']) document.querySelector(sel)?.removeAttribute('inert');
  }

  private trap(e: KeyboardEvent) {
    const panel = this.q('[data-cg-panel]');
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )).filter(n => !n.hasAttribute('hidden') && n.offsetParent !== null && n.tabIndex !== -1);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }

  /* -------------------------------------------------------------------- chat */

  private async ensureSession() {
    if (!this.cfg || this.chat.greeted || this.busy) return;
    this.busy = true;
    this.setTyping(true);
    try {
      const res = await postJson<ChatSessionResponse>(this.cfg.apiBase, '/v1/chat/session', { locale: this.cfg.locale, page: window.location.pathname }, 15000);
      this.chat.sessionId = res?.sessionId || null;
      this.chat.greeted = true;
      this.setOffline(false);
      if (res?.greeting) this.push({ t: 'agent', text: res.greeting });
      else this.persistChat();
      if (!this.chat.quickUsed) this.showQuick();
    } catch {
      this.setOffline(true);
    } finally {
      this.setTyping(false);
      this.busy = false;
    }
  }

  private async send(raw: string) {
    const text = (raw || '').trim();
    if (!text || !this.cfg || this.busy) return;
    this.hideQuick();
    this.lastSent = text;
    this.push({ t: 'user', text });
    this.busy = true;
    this.setTyping(true);
    this.setOffline(false);
    try {
      if (!this.chat.sessionId) {
        const s = await postJson<ChatSessionResponse>(this.cfg.apiBase, '/v1/chat/session', { locale: this.cfg.locale, page: window.location.pathname }, 15000);
        this.chat.sessionId = s?.sessionId || null;
        this.chat.greeted = true;
      }
      const res = await postJson<ChatMessageResponse>(this.cfg.apiBase, '/v1/chat/message', {
        sessionId: this.chat.sessionId, text, locale: this.cfg.locale, page: window.location.pathname,
      }, 30000);
      for (const m of res?.messages ?? []) if (m?.text) this.push({ t: 'agent', text: m.text });
      for (const a of res?.actions ?? []) this.action(a);
    } catch {
      this.setOffline(true);
    } finally {
      this.setTyping(false);
      this.busy = false;
    }
  }

  private action(a: ChatAction) {
    if (!a || !this.cfg) return;
    if (a.type === 'show_listing' && a.listing?.id) { this.push({ t: 'card', card: a.listing }); return; }
    if (a.type === 'whatsapp') { this.push({ t: 'wa', text: a.message || '' }); return; }
    if (a.type === 'navigate') {
      const path = samePath(a.path);
      if (!path || path === window.location.pathname) return;
      this.push({ t: 'note', text: this.cfg.strings.opening });
      this.persistUi();
      if (this.navTimer) window.clearTimeout(this.navTimer);
      this.navTimer = window.setTimeout(() => {
        try { navigate(path); } catch { window.location.assign(path); }
      }, 600);
    }
  }

  private async retry() {
    this.setOffline(false);
    if (!this.chat.greeted) { await this.ensureSession(); return; }
    if (this.lastSent) { const t = this.lastSent; this.lastSent = ''; await this.send(t); }
  }

  private async reset() {
    if (!this.cfg) return;
    if (this.chat.sessionId) postBeacon(this.cfg.apiBase, '/v1/chat/end', { sessionId: this.chat.sessionId });
    this.chat = { sessionId: null, items: [], greeted: false, quickUsed: false };
    drop(chatKey(this.cfg.locale));
    this.renderChat();
    this.setOffline(false);
    await this.ensureSession();
    this.q<HTMLTextAreaElement>('[data-cg-input]')?.focus({ preventScroll: true });
  }

  private push(item: Item) {
    this.chat.items.push(item);
    this.persistChat();
    const log = this.q('[data-cg-log]');
    if (log) { log.append(this.node(item)); this.scrollLog(true); }
  }

  private node(item: Item): HTMLElement {
    const c = this.cfg!;
    if (item.t === 'agent') return bubble('agent', item.text, c.strings.agent);
    if (item.t === 'user') return bubble('user', item.text, c.strings.you);
    if (item.t === 'card') return listingCard(item.card, c);
    if (item.t === 'note') return note(item.text);
    const wrap = el('div', 'cg-action');
    const a = el('a', 'cg-wa-btn', c.strings.whatsapp);
    a.href = item.text ? `${c.waHref.split('?')[0]}?text=${encodeURIComponent(item.text)}` : c.waHref;
    a.target = '_blank';
    a.rel = 'noopener';
    wrap.append(a);
    return wrap;
  }

  private renderChat() {
    const log = this.q('[data-cg-log]');
    if (!log) return;
    log.textContent = '';
    for (const item of this.chat.items) log.append(this.node(item));
    if (this.chat.greeted && !this.chat.quickUsed) this.showQuick(); else this.hideQuick(false);
    this.scrollLog(false);
  }

  private showQuick() { const q = this.q('[data-cg-quick]'); if (q) q.hidden = false; }
  private hideQuick(persist = true) {
    const q = this.q('[data-cg-quick]');
    if (q) q.hidden = true;
    if (persist && !this.chat.quickUsed) { this.chat.quickUsed = true; this.persistChat(); }
  }

  private setTyping(on: boolean) {
    const t = this.q('[data-cg-typing]');
    if (t) t.hidden = !on;
    this.typing = on;
    this.updateComposer();
    if (on) this.scrollLog(true);
  }

  private setOffline(on: boolean) {
    this.offline = on;
    const f = this.q('[data-cg-fallback]');
    if (f) f.hidden = !on;
    this.updateComposer();
    if (on) this.scrollLog(true);
  }

  /** The composer is dead while Dana is typing, and while the API is unreachable. */
  private updateComposer() {
    const send = this.q<HTMLButtonElement>('[data-cg-send]');
    const input = this.q<HTMLTextAreaElement>('[data-cg-input]');
    const off = this.offline;
    if (send) send.disabled = this.typing || off;
    if (input) input.disabled = off;
    this.q('[data-cg-pane="chat"]')?.classList.toggle('is-offline', off);
  }

  private scrollLog(smooth: boolean) {
    const s = this.q('[data-cg-scroll]');
    if (!s) return;
    const go = () => s.scrollTo({ top: s.scrollHeight, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
    requestAnimationFrame(go);
  }

  private grow(input: HTMLTextAreaElement) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  /* -------------------------------------------------------------------- call */

  private async startCall() {
    if (!this.cfg) return;
    await this.call.start(this.cfg.apiBase, this.cfg.locale, window.location.pathname);
  }

  private renderCall() {
    if (!this.root || !this.cfg) return;
    const s = this.call.state;
    const pane = this.q('[data-cg-pane="call"]');
    const status = this.q('[data-cg-call-status]');
    const orb = this.q<HTMLButtonElement>('[data-cg-call-start]');
    const actions = this.q('[data-cg-call-actions]');
    const errorEl = this.q('[data-cg-call-error]');
    const fallback = this.q('[data-cg-call-fallback]');
    const timer = this.q('[data-cg-timer]');
    const intro = this.q('[data-cg-call-intro]');
    const captions = this.q('[data-cg-captions]');
    const mute = this.q<HTMLButtonElement>('[data-cg-mute]');

    pane?.setAttribute('data-state', s.status);
    this.q('[data-cg-open]')?.classList.toggle('is-live', this.call.active);

    if (status) status.textContent = status.dataset[s.status] || '';
    if (orb) {
      orb.disabled = this.call.active;
      orb.classList.toggle('is-speaking', s.status === 'speaking');
      orb.classList.toggle('is-live', s.status === 'live' || s.status === 'speaking');
    }
    if (actions) actions.hidden = !this.call.active;
    if (mute) {
      mute.textContent = (s.muted ? mute.dataset.unmute : mute.dataset.mute) || '';
      mute.setAttribute('aria-pressed', String(s.muted));
    }
    if (intro) intro.hidden = s.status !== 'idle';

    const err = s.status === 'error'
      ? (s.errorKind === 'mic' ? this.cfg.strings.micDenied : s.errorKind === 'unsupported' ? this.cfg.strings.callUnsupported : this.cfg.strings.callFailed)
      : '';
    if (errorEl) { errorEl.textContent = err; errorEl.hidden = !err; }
    if (fallback) fallback.hidden = !err;

    if (timer) {
      timer.hidden = !(s.startedAt && (this.call.active || s.status === 'ended'));
      if (!timer.hidden) timer.textContent = this.elapsed();
    }
    if (this.call.active && s.startedAt) this.startTicker(); else this.stopTicker();

    if (captions) {
      const lines = s.transcript.slice(-2).map(x => x.content).filter(Boolean);
      captions.textContent = lines.join('  ·  ');
      captions.hidden = !lines.length || !this.call.active;
    }

    const list = this.q('[data-cg-mentioned-list]');
    const section = this.q('[data-cg-mentioned]');
    if (list && section) {
      if (list.childElementCount !== s.cards.length) {
        list.textContent = '';
        for (const card of s.cards) list.append(listingCard(card, this.cfg));
      }
      section.hidden = s.cards.length === 0;
    }
    if (!browserSupportsCall() && orb) orb.disabled = false; // let the tap surface the explanation
  }

  private elapsed(): string {
    const s = this.call.state;
    if (!s.startedAt) return '0:00';
    const end = this.call.active ? Date.now() : (s.endedAt ?? Date.now());
    const total = Math.max(0, Math.floor((end - s.startedAt) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  private startTicker() {
    if (this.timer) return;
    this.timer = window.setInterval(() => {
      const timer = this.q('[data-cg-timer]');
      if (timer && !timer.hidden) timer.textContent = this.elapsed();
    }, 1000);
  }

  private stopTicker() {
    if (this.timer) { window.clearInterval(this.timer); this.timer = 0; }
  }
}

/* ------------------------------------------------------------------ lifecycle */

declare global { interface Window { __bonaConcierge?: Concierge } }

const widget = window.__bonaConcierge ?? (window.__bonaConcierge = new Concierge());
let bound: HTMLElement | null = null;

function init() {
  const root = document.querySelector<HTMLElement>('[data-concierge]');
  if (!root) { if (bound) { widget.unbind(); bound = null; } return; }
  if (bound === root) return;
  if (bound) widget.unbind();
  bound = root;
  widget.bind(root);
}

document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', () => { if (bound) { widget.unbind(); bound = null; } });
