/* Browser voice call with Dana, over the Retell web SDK.
   The SDK (and its LiveKit dependency) is imported lazily — nothing ships to visitors who never open the Call tab. */

import type { RetellWebClient } from 'retell-client-js-sdk';
import { getJson, postJson, type Card, type CallContextResponse, type CallTokenResponse } from './api';

export type CallStatus = 'idle' | 'permission' | 'connecting' | 'live' | 'speaking' | 'ended' | 'error';
export type CallErrorKind = 'unsupported' | 'mic' | 'failed';

export interface CallState {
  status: CallStatus;
  callId: string | null;
  muted: boolean;
  startedAt: number | null;
  endedAt: number | null;
  cards: Card[];
  transcript: { role: string; content: string }[];
  errorKind: CallErrorKind | null;
}

export function browserSupportsCall(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof RTCPeerConnection !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

/** One voice call. Lives in module scope so a call survives in-site navigation. */
export class CallSession {
  state: CallState = { status: 'idle', callId: null, muted: false, startedAt: null, endedAt: null, cards: [], transcript: [], errorKind: null };
  onChange: () => void = () => {};

  private client: RetellWebClient | null = null;
  private poll = 0;
  private starting = false;
  /** Bumped by end()/dispose(); a start whose id is stale drops whatever it was about to do. */
  private startId = 0;

  get active(): boolean {
    return this.state.status === 'connecting' || this.state.status === 'live' || this.state.status === 'speaking' || this.state.status === 'permission';
  }

  private set(patch: Partial<CallState>) {
    Object.assign(this.state, patch);
    this.onChange();
  }

  /** Every await below is followed by this check: the panel may have closed, or the page gone, meanwhile. */
  private live(id: number): boolean {
    return id === this.startId;
  }

  async start(apiBase: string, locale: string, page: string): Promise<void> {
    if (this.starting || this.active) return;
    const id = ++this.startId;
    this.starting = true;
    this.set({ status: 'permission', errorKind: null, cards: [], transcript: [], endedAt: null, muted: false, callId: null });

    try {
      if (!browserSupportsCall()) {
        this.set({ status: 'error', errorKind: 'unsupported' });
        return;
      }

      // Ask for the microphone first, so a denial is reported before a call token is spent.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach(t => t.stop());
      } catch {
        if (this.live(id)) this.set({ status: 'error', errorKind: 'mic' });
        return;
      }
      if (!this.live(id)) return;

      this.set({ status: 'connecting' });
      let client: RetellWebClient | null = null;
      try {
        const [{ accessToken, callId }, mod] = await Promise.all([
          postJson<CallTokenResponse>(apiBase, '/v1/call/token', { locale, page }, 15000),
          import('retell-client-js-sdk'),
        ]);
        if (!this.live(id)) return;
        if (!accessToken) throw new Error('no access token');

        client = new mod.RetellWebClient();
        this.client = client;
        this.state.callId = callId || null;
        const mine = () => this.client === client && this.live(id);

        client.on('call_started', () => { if (mine()) this.set({ status: 'live', startedAt: Date.now() }); });
        client.on('agent_start_talking', () => { if (mine() && this.active) this.set({ status: 'speaking' }); });
        client.on('agent_stop_talking', () => { if (mine() && this.active) this.set({ status: 'live' }); });
        client.on('update', (u: { transcript?: { role: string; content: string }[] }) => {
          if (mine() && Array.isArray(u?.transcript)) this.set({ transcript: u.transcript.slice(-6) });
        });
        client.on('call_ended', () => { if (mine()) this.finish('ended'); });
        client.on('error', () => {
          try { client?.stopCall(); } catch { /* already down */ }
          if (mine()) this.finish('error', 'failed');
        });

        await client.startCall({ accessToken });
        // Closed or navigated away while the SDK was connecting: take the call down instead of leaving it live.
        if (!this.live(id)) { try { client.stopCall(); } catch { /* already down */ } this.client = null; return; }
        this.startPolling(apiBase);
      } catch {
        try { client?.stopCall(); } catch { /* already down */ }
        if (this.live(id)) this.finish('error', 'failed');
        else this.client = null;
      }
    } finally {
      if (this.live(id)) this.starting = false;
    }
  }

  /** Ends a live call and cancels one that is still connecting. Safe to call when nothing is running. */
  end(): void {
    this.startId++;
    this.starting = false;
    try { this.client?.stopCall(); } catch { /* already down */ }
    if (this.active) this.finish('ended');
    else { this.stopPolling(); this.client = null; }
  }

  toggleMute(): void {
    if (!this.client || !this.active) return;
    const next = !this.state.muted;
    try { next ? this.client.mute() : this.client.unmute(); } catch { return; }
    this.set({ muted: next });
  }

  /** Called when the page goes away for good; keeps nothing running and invalidates any pending start. */
  dispose(): void {
    this.startId++;
    this.starting = false;
    this.stopPolling();
    try { this.client?.stopCall(); } catch { /* already down */ }
    this.client = null;
    if (this.active) this.set({ status: 'ended', endedAt: Date.now(), muted: false });
  }

  private finish(status: 'ended' | 'error', errorKind: CallErrorKind | null = null) {
    this.stopPolling();
    this.client = null;
    this.set({ status, errorKind, endedAt: Date.now(), muted: false });
  }

  private startPolling(apiBase: string) {
    this.stopPolling();
    const tick = async () => {
      const id = this.state.callId;
      if (!id || !this.active) return;
      try {
        const ctx = await getJson<CallContextResponse>(apiBase, `/v1/call/${encodeURIComponent(id)}/context`, 5000);
        const cards = Array.isArray(ctx?.listings) ? ctx.listings.filter(c => c && c.id) : [];
        if (cards.length !== this.state.cards.length || cards.some((c, i) => c.id !== this.state.cards[i]?.id)) {
          this.set({ cards });
        }
      } catch { /* the context endpoint is a nicety; a call is fine without it */ }
    };
    this.poll = window.setInterval(tick, 3000);
    void tick();
  }

  private stopPolling() {
    if (this.poll) { window.clearInterval(this.poll); this.poll = 0; }
  }
}
