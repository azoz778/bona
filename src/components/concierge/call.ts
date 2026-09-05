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

  get active(): boolean {
    return this.state.status === 'connecting' || this.state.status === 'live' || this.state.status === 'speaking' || this.state.status === 'permission';
  }

  private set(patch: Partial<CallState>) {
    Object.assign(this.state, patch);
    this.onChange();
  }

  async start(apiBase: string, locale: string, page: string): Promise<void> {
    if (this.starting || this.active) return;
    this.starting = true;
    this.set({ status: 'permission', errorKind: null, cards: [], transcript: [], endedAt: null, muted: false, callId: null });

    if (!browserSupportsCall()) {
      this.starting = false;
      this.set({ status: 'error', errorKind: 'unsupported' });
      return;
    }

    // Ask for the microphone first, so a denial is reported before a call token is spent.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(t => t.stop());
    } catch {
      this.starting = false;
      this.set({ status: 'error', errorKind: 'mic' });
      return;
    }

    this.set({ status: 'connecting' });
    try {
      const [{ accessToken, callId }, mod] = await Promise.all([
        postJson<CallTokenResponse>(apiBase, '/v1/call/token', { locale, page }, 15000),
        import('retell-client-js-sdk'),
      ]);
      if (!accessToken) throw new Error('no access token');

      const client = new mod.RetellWebClient();
      this.client = client;
      this.state.callId = callId || null;

      client.on('call_started', () => this.set({ status: 'live', startedAt: Date.now() }));
      client.on('agent_start_talking', () => { if (this.active) this.set({ status: 'speaking' }); });
      client.on('agent_stop_talking', () => { if (this.active) this.set({ status: 'live' }); });
      client.on('update', (u: { transcript?: { role: string; content: string }[] }) => {
        if (Array.isArray(u?.transcript)) this.set({ transcript: u.transcript.slice(-6) });
      });
      client.on('call_ended', () => this.finish('ended'));
      client.on('error', () => { try { client.stopCall(); } catch { /* already down */ } this.finish('error', 'failed'); });

      await client.startCall({ accessToken });
      this.startPolling(apiBase);
    } catch {
      this.finish('error', 'failed');
    } finally {
      this.starting = false;
    }
  }

  end(): void {
    try { this.client?.stopCall(); } catch { /* already down */ }
    if (this.active) this.finish('ended');
  }

  toggleMute(): void {
    if (!this.client || !this.active) return;
    const next = !this.state.muted;
    try { next ? this.client.mute() : this.client.unmute(); } catch { return; }
    this.set({ muted: next });
  }

  /** Called when the widget's DOM goes away for good; keeps nothing running. */
  dispose(): void {
    this.stopPolling();
    try { this.client?.stopCall(); } catch { /* already down */ }
    this.client = null;
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
