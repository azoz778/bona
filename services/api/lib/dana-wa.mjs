/**
 * Dana on WhatsApp (2026-09-27 design §6, Phase 4; plan P4-6..P4-16).
 *
 * The poller wakes this module once per client message it stores in a Bona inbox chat
 * (`wake`, never awaited); a two-second timer turns a tick's burst into one run. A run
 * decides whether Dana may answer at all — configured, the chat `in` and nobody's colleague,
 * the owner's global switch (or his test flag on this one chat), the chat's own switch, the
 * Sending switch (`sending_off`, a state like `off`: never logged), no
 * hand-over pending, no human answer in the last 24 h, a phone jid to send to, a message
 * that is fresh, her caps — then reads the messages nobody answered yet, keeps one Retell
 * chat per WhatsApp chat (reused under 23 h idle, else made anew with the conversation so
 * far as context), turns the completion into plain WhatsApp text with links instead of
 * cards, re-reads the chat from WhatsApp right before sending and drops her answer if a
 * person answered meanwhile, prefixes her first message in a chat with who she is, and
 * sends through the one sender (kind `dana`). A hand-over — the model calling
 * `request_human`, Retell failing, an empty answer, a spent budget or cap, a send that
 * failed — flags the chat for a human, alerts everyone and (once) tells the client the team
 * will reply shortly; she then stays quiet until a person answers and 24 h pass.
 *
 * A hand-over runs the same pre-send check as an answer: a person who answered during the
 * Retell round trip, or a switch turned off meanwhile, means no flag, no alert and no line.
 *
 * A run that throws after Dana's outbox row is written leaves that row `pending`; start-up
 * or daily upkeep turns it `uncertain` (it may have gone), the batch counts as answered and
 * the chat is not flagged — exactly like a staff reply cut off mid-send.
 *
 * Never logged: message text, a name, a number, a Retell chat id. Never rejects.
 */
import { extractActions, plainText } from './actions.mjs';
import { replyJidFor } from './wa-send.mjs';
import { HANDOVER_TOOL } from './tools.mjs';
import { randomId } from './store.mjs';

export const HUMAN_QUIET_MS = 24 * 3_600_000;
export const SESSION_IDLE_MS = 23 * 3_600_000;
export const BATCH_MS = 2_000;
export const FRESH_MS = 30 * 60_000;
export const PER_CHAT_PER_HOUR = 6;
export const PER_DAY = 200;
export const CONTEXT_MESSAGES = 10;
export const MAX_LINKS = 3;
export const MAX_ANSWER_LEN = 1500;
/** Prefixed, in code, to her first message in a chat (P4-12). */
export const DISCLOSURE = { en: "Dana — Bona's AI assistant", ar: 'دانة — مساعدة بونا بالذكاء الاصطناعي' };
/** The one line a hand-over sends (P4-11). */
export const HANDOVER = { en: 'Thank you — a member of the Bona team will reply to you shortly.', ar: 'شكراً لك، أحد أعضاء فريق بونا بيرد عليك قريباً.' };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LINE_MAX = 300;
const CONTEXT_MAX = 3000;
const FACT_MAX = 120;
const BATCH_MAX = 4000;
const ARABIC_RE = /[؀-ۿ]/;
const LATIN_RE = /[A-Za-z]/;
const PLACEHOLDER_RE = /^\[[^\]\n]{1,40}\]$/;
/** Skips worth a log line; the rest are states, not events (P4-15). */
const CAPS = new Set(['cap_chat', 'cap_day']);
/** A hand-over re-check that finds one of these does nothing at all: no flag, no alert, no line. */
// `human_recent`: a person active in the chat within 24 h (a message older than the batch,
// stored during the round trip) owns it — no hand-over over their head (whole-branch review).
// `sending_off`: the owner's Sending switch stops every send, the hand-over line included.
const HANDOVER_SKIPS = new Set(['dropped_human', 'human_recent', 'not_in_inbox', 'off', 'chat_off', 'sending_off', 'not_configured']);
const LOGGED_SKIPS = new Set(['human_recent', 'needs_human', 'lid_only', 'old', 'cap_chat', 'cap_day', 'nothing', 'dropped_human']);

/** Whitespace folded, cut on whole characters. */
const oneLine = (v, max) => Array.from(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
const textOrMedia = (m) => (typeof m?.text === 'string' && m.text.trim() ? m.text.trim() : (m?.media_type ?? '[message]'));

/** The client's language (P4-9). */
export function languageOf({ lead = null, texts = [] } = {}) {
  // A media placeholder ('[voice note]', '[image]') is not the client's writing: no language.
  const all = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string' && !PLACEHOLDER_RE.test(t.trim())).join('\n');
  if (ARABIC_RE.test(all)) return 'ar';
  if (LATIN_RE.test(all)) return 'en';
  return lead?.language === 'en' ? 'en' : 'ar';
}

/** What Bona knows about the client, for the prompt — never the phone number (P4-8). */
export function leadFacts(lead) {
  if (!lead || typeof lead !== 'object') return '';
  const facts = [['Name', lead.name], ['Interest', lead.interest], ['Budget', lead.budget], ['District', lead.district],
    ['Listing', lead.listing_id], ['Stage', lead.stage], ['Timeline', lead.timeline]];
  return facts.filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => `${k}: ${oneLine(v, FACT_MAX)}`).join('\n');
}

const speaker = (m) => (m.direction === 'in' ? 'Client' : m.sender_kind === 'dana' ? 'Dana' : 'Team');

/** The conversation so far as prompt context: the newest lines that fit (P4-8). */
export function recentContext(messages, { exclude = new Set() } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && !exclude.has(m.key_id));
  const lines = rows.slice(-CONTEXT_MESSAGES).map((m) => `${speaker(m)}: ${oneLine(textOrMedia(m), LINE_MAX)}`);
  while (lines.length > 1 && lines.join('\n').length > CONTEXT_MAX) lines.shift();
  return lines.join('\n').slice(0, CONTEXT_MAX);
}

/** The unanswered messages as the one message Retell is asked. */
export function batchText(messages) {
  return (Array.isArray(messages) ? messages : []).map(textOrMedia).join('\n').slice(0, BATCH_MAX);
}

/** Cards become link lines in the client's language; a URL already in the text is not repeated (P4-10). */
export function withLinks(text, cards, language, { max = MAX_LINKS } = {}) {
  const lang = language === 'ar' ? 'ar' : 'en';
  let out = String(text ?? '').trim();
  let links = 0;
  for (const card of Array.isArray(cards) ? cards : []) {
    if (links >= max) break;
    const url = card?.url?.[lang] ?? card?.url?.en;
    if (!url) continue;
    if ([card.url?.en, card.url?.ar].some((u) => u && out.includes(u))) continue;
    const title = oneLine(card?.title?.[lang] ?? card?.title?.en ?? card?.id ?? '', 80);
    out += `${out ? '\n\n' : ''}${title ? `${title} — ` : ''}${url}`;
    links += 1;
  }
  return { text: out, links };
}

/** At most `max` characters, cut at whitespace when there is some in the second half. */
export function clip(text, max = MAX_ANSWER_LEN) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  // Whole characters only: a surrogate pair is never split (the sender measures `.length`).
  let cut = '';
  for (const ch of s) {
    if (cut.length + ch.length > max) break;
    cut += ch;
  }
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (at > max / 2 ? cut.slice(0, at) : cut).trim();
}

/** Ids and slugs the completion's tool results carried (the content is JSON, sometimes encoded twice). */
function resultIds(messages) {
  const ids = new Set();
  for (const m of messages) {
    if (m?.role !== 'tool_call_result') continue;
    let payload = m.content;
    for (let i = 0; i < 2 && typeof payload === 'string'; i += 1) {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const rows = Array.isArray(payload) ? payload : payload?.results;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (typeof row?.id === 'string' && row.id) ids.add(row.id);
      if (typeof row?.slug === 'string' && row.slug) ids.add(row.slug);
    }
  }
  return ids;
}

/** The completion as WhatsApp text, and whether the model asked for a person (P4-10, P4-11). */
export function answerFrom(completion, { inventory, siteUrl, language }) {
  const messages = Array.isArray(completion?.messages) ? completion.messages : [];
  const handover = messages.some((m) => m?.role === 'tool_call_invocation' && m?.name === HANDOVER_TOOL);
  const r = extractActions(messages, { inventory, siteUrl, maxCards: MAX_LINKS });
  const body = clip(plainText(r.messages.map((m) => m.text).join('\n\n')));
  // Links never go out alone: no words is the `empty` hand-over.
  if (!body) return { text: '', handover, links: 0 };
  // Only homes a tool actually returned — never the widget's local fallback search, which
  // would link homes Dana never described.
  const returned = resultIds(messages);
  const cards = r.actions.filter((a) => a.type === 'show_listing').map((a) => a.listing)
    .filter((c) => returned.has(c?.id) || returned.has(c?.slug));
  const { text, links } = withLinks(body, cards, language);
  return { text, handover, links };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./db.mjs').openDb>} o.db
 * @param {ReturnType<import('./inbox/store.mjs').createInboxStore>} o.inbox
 * @param {ReturnType<import('./team.mjs').createTeam>} o.team
 * @param {{ sendTo: Function }} o.sender  the ONE sender (app.sender)
 * @param {{ createChat: Function, createChatCompletion: Function }|null} o.retell
 * @param {{ notify: Function }|null} [o.alerts]
 * @param {object} o.inventory
 * @param {string} o.siteUrl
 * @param {string|null} o.agentId  the WhatsApp chat agent (cfg.waChatAgentId)
 * @param {(lead: object) => boolean} o.isExcludedLead
 * @param {{ refresh: Function }|null} [o.backfill]
 * @param {{ take: Function, refund: Function }|null} [o.budget]
 */
export function createDana({
  db, inbox, team, sender, retell, alerts = null, inventory, siteUrl, agentId, isExcludedLead, backfill = null, budget = null,
  now = () => Date.now(), log = () => {}, batchMs = BATCH_MS,
} = {}) {
  if (!db || !inbox || !team) throw new TypeError('createDana needs the store, the inbox store and the team');
  if (!sender || typeof sender.sendTo !== 'function') throw new TypeError('createDana needs the one sender (app.sender)');
  if (typeof isExcludedLead !== 'function') throw new TypeError('createDana needs isExcludedLead (lib/team.mjs)');
  const configured = Boolean(agentId && retell && typeof retell.createChat === 'function' && typeof retell.createChatCompletion === 'function');
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops an answer */ } };
  const timers = new Map();       // leadId → { timer, ts, done, settle }
  const inflight = new Map();     // leadId → the run's promise
  const pendingAgain = new Map(); // leadId → the newest ts woken while a run was in flight
  let stopped = false;            // stop() is final: no wake arms a run after it

  function eligible(leadId, { ts = null } = {}) {
    if (!configured) return { ok: false, reason: 'not_configured' };
    const lead = db.getLead(leadId);
    if (!lead || lead.inbox_state !== 'in' || isExcludedLead(lead)) return { ok: false, reason: 'not_in_inbox' };
    if (!(team.danaEnabled() || Number(lead.dana_test) === 1)) return { ok: false, reason: 'off' };
    if (Number(lead.dana_off) === 1) return { ok: false, reason: 'chat_off' };
    // Every send stops with the Sending switch; asking Retell for an answer that cannot go
    // would only spend budget and end in a `send_failed` hand-over.
    if (!team.sendingEnabled()) return { ok: false, reason: 'sending_off' };
    if (Number(lead.needs_human) === 1) return { ok: false, reason: 'needs_human' };
    const t = now();
    if (Number.isFinite(lead.last_human_out_ts) && t - lead.last_human_out_ts < HUMAN_QUIET_MS) return { ok: false, reason: 'human_recent' };
    if (!replyJidFor(lead)) return { ok: false, reason: 'lid_only' };
    if (ts != null && Number.isFinite(Number(ts)) && Number(ts) < t - FRESH_MS) return { ok: false, reason: 'old' };
    if (inbox.countDanaSends({ leadId: lead.lead_id, sinceTs: t - HOUR_MS }) >= PER_CHAT_PER_HOUR) return { ok: false, reason: 'cap_chat' };
    if (inbox.countDanaSends({ sinceTs: t - DAY_MS }) >= PER_DAY) return { ok: false, reason: 'cap_day' };
    return { ok: true, lead };
  }

  const failure = (err) => (Number.isInteger(err?.status) ? { status: err.status } : { error: err?.name === 'RetellError' ? 'request' : 'error' });

  /**
   * The Retell chat for this WhatsApp chat: the stored one while fresh, else a new one (P4-8).
   * `fresh` forces a new one (the stored chat just failed). `created` says a chat was made.
   */
  async function session(lead, batch, language, { fresh = false } = {}) {
    const t = now();
    if (!fresh && lead.dana_chat_id && Number.isFinite(lead.dana_chat_ts) && t - lead.dana_chat_ts < SESSION_IDLE_MS) return { chatId: lead.dana_chat_id, created: false };
    if (budget && !budget.take('chats')) return { error: 'budget' };
    try {
      const exclude = new Set(batch.map((m) => m.key_id));
      const chat = await retell.createChat({
        agent_id: agentId,
        retell_llm_dynamic_variables: {
          channel: 'whatsapp',
          language,
          lead_facts: leadFacts(lead),
          recent_messages: recentContext(inbox.messagesFor(lead.lead_id, { limit: CONTEXT_MESSAGES + batch.length }), { exclude }),
        },
        metadata: { source: 'bona-whatsapp', lead_id: lead.lead_id },
      });
      if (typeof chat?.chat_id !== 'string' || !chat.chat_id) throw new Error('no chat id');
      db.updateLead(lead.lead_id, { dana_chat_id: chat.chat_id, dana_chat_ts: t });
      say({ evt: 'dana.session', leadId: lead.lead_id, renewed: Boolean(lead.dana_chat_id) });
      return { chatId: chat.chat_id, created: true };
    } catch (err) {
      if (budget) budget.refund('chats');
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
      return { error: 'retell_error' };
    }
  }

  /** Ask the model; a reused chat that fails (ended on Retell's side, say) is replaced once. */
  async function complete(lead, batch, language) {
    const content = batchText(batch);
    let s = await session(lead, batch, language);
    if (s.error) return s;
    try {
      return { completion: await retell.createChatCompletion({ chat_id: s.chatId, content }), newChat: s.created };
    } catch (err) {
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
      if (s.created) return { error: 'retell_error' };
    }
    s = await session(lead, batch, language, { fresh: true });
    if (s.error) return s;
    try {
      return { completion: await retell.createChatCompletion({ chat_id: s.chatId, content }), newChat: true };
    } catch (err) {
      say({ level: 'warn', evt: 'dana.retell_failed', leadId: lead.lead_id, ...failure(err) });
      return { error: 'retell_error' };
    }
  }

  /**
   * One message out through the one sender (P4-12, P4-14). Her outbox row goes in FIRST, with
   * `covers_ts` = the newest client message this answers and the text normalised the way a
   * staff reply is (the poller matches an unconfirmed send by exact text), so a client message
   * stamped while she composed is not counted as answered, and a crash mid-send leaves a row.
   */
  async function send(lead, text, language, coversTs) {
    // Introduced = the flag OR any Dana row for this chat that is not `failed` (P4-12): a run
    // that crashed after its row was written may have sent her first message without setting
    // the flag. Read before this run's own row goes in. A purge stubs rows with lead_id NULL,
    // so a chat that comes back is introduced again.
    const introduced = Number(lead.dana_introduced) === 1 || inbox.countDanaSends({ leadId: lead.lead_id, sinceTs: 0 }) > 0;
    const body = (introduced ? text : `${DISCLOSURE[language]}\n\n${text}`).replace(/\r\n?/g, '\n').trim();
    const jid = replyJidFor(lead);
    const sendId = `SND-${now().toString(36)}-${randomId(8)}`;
    const ins = inbox.insertOutbox({ send_id: sendId, lead_id: lead.lead_id, jid, text: body, user_id: null, sender_kind: 'dana', status: 'pending', covers_ts: coversTs });
    if (!ins.inserted) return { sent: false, error: 'bad_send_id' };
    const out = await sender.sendTo({ jid, text: body, kind: 'dana', leadId: lead.lead_id, sendId });
    const t = now();
    if (out.ok) {
      const startedAt = Number.isFinite(ins.row?.created) ? ins.row.created : t;
      try {
        db.transaction(() => {
          if (db.getLead(lead.lead_id)?.inbox_state !== 'in') return;
          inbox.upsertMessage({ key_id: out.keyId, lead_id: lead.lead_id, jid, direction: 'out', sender_kind: 'dana', text: body, ts: Math.floor(startedAt / 1000) * 1000, status: 'sent' });
          db.updateLead(lead.lead_id, { dana_chat_ts: t, dana_introduced: 1 });
        });
      } catch (err) {
        say({ level: 'error', evt: 'dana.record_failed', leadId: lead.lead_id, name: typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error' });
      }
      return { sent: true, chars: body.length };
    }
    if (out.uncertain) {
      db.transaction(() => {
        if (db.getLead(lead.lead_id)?.inbox_state !== 'in') return;
        db.updateLead(lead.lead_id, { dana_chat_ts: t, dana_introduced: 1 });
      });
      return { sent: true, chars: body.length };
    }
    say({ level: 'warn', evt: 'dana.send_failed', leadId: lead.lead_id, error: String(out.error ?? 'error').slice(0, 40) });
    return { sent: false, error: out.error };
  }

  /**
   * The pre-send check (P4-13), for an answer and a hand-over alike: the chat as WhatsApp has
   * it now, then a person's answer since the batch, then the lead again (freshness aside).
   */
  async function preSend(leadId, coversTs) {
    const lead = db.getLead(leadId);
    if (lead && backfill && typeof backfill.refresh === 'function') {
      try { await backfill.refresh(lead); } catch { /* the checks below read what is stored */ }
    }
    // A person's answer stored by the refresh also stamps `last_human_out_ts`, so the re-check
    // alone would say `human_recent`; it is named for what happened — `dropped_human`.
    if (inbox.humanOutboundAfter(leadId, coversTs)) return { ok: false, reason: 'dropped_human' };
    return eligible(leadId);
  }

  const skip = (leadId, reason) => {
    if (LOGGED_SKIPS.has(reason)) say({ evt: 'dana.skipped', leadId, reason });
    return { skipped: reason };
  };

  /**
   * The hand-over (P4-11): the flag first, then the alert, then the one line — unless it went
   * already. A person who answered meanwhile, or the chat leaving the inbox or switched off,
   * means nothing at all happens.
   */
  async function handover(leadId, language, why, coversTs, { checked = false } = {}) {
    if (!checked) {
      const pre = await preSend(leadId, coversTs);
      if (!pre.ok && HANDOVER_SKIPS.has(pre.reason)) return skip(leadId, pre.reason);
    }
    const fresh = db.getLead(leadId);
    if (!fresh || fresh.inbox_state !== 'in') return skip(leadId, 'not_in_inbox');
    const already = Number(fresh.needs_human) === 1;
    if (!already) inbox.setNeedsHuman(leadId, 1);
    if (alerts) alerts.notify(leadId, { reason: 'needs_human' });
    // A chat that turned lid-only meanwhile has no phone jid to send to: flagged and alerted
    // like any hand-over, but no line — as if it had gone already (Task 6 re-review).
    const noJid = !replyJidFor(fresh);
    const sent = already || noJid ? false : (await send(fresh, HANDOVER[language], language, coversTs)).sent;
    say({ evt: 'dana.handover', leadId, why, sent });
    return { handover: why, sent };
  }

  async function run(leadId, ts) {
    const e = eligible(leadId, { ts });
    if (!e.ok) {
      if (CAPS.has(e.reason)) {
        const lead = db.getLead(leadId);
        const waiting = inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
        // A cap hands over only a client who is waiting: with nothing unanswered (a wake for a
        // batch another run answered) there is nobody to hand over — no flag, alert or line.
        if (!waiting.length) return skip(leadId, 'nothing');
        return handover(leadId, languageOf({ lead, texts: waiting.map((m) => m.text) }), e.reason, waiting[waiting.length - 1].ts);
      }
      return skip(leadId, e.reason);
    }
    const batch = inbox.unansweredClientMessages(leadId, { limit: CONTEXT_MESSAGES });
    if (!batch.length) return skip(leadId, 'nothing');
    const language = languageOf({ lead: e.lead, texts: batch.map((m) => m.text) });
    const coversTs = batch[batch.length - 1].ts;
    const c = await complete(e.lead, batch, language);
    if (c.error) return handover(leadId, language, c.error, coversTs);
    const { text, handover: asked, links } = answerFrom(c.completion, { inventory, siteUrl, language });
    if (asked) return handover(leadId, language, 'request_human', coversTs);
    if (!text) return handover(leadId, language, 'empty', coversTs);
    const pre = await preSend(leadId, coversTs);
    if (!pre.ok) {
      // A cap reached meanwhile is still a hand-over: the client is waiting (P4-6).
      if (CAPS.has(pre.reason)) return handover(leadId, language, pre.reason, coversTs, { checked: true });
      return skip(leadId, pre.reason);
    }
    const r = await send(pre.lead, text, language, coversTs);
    if (!r.sent) {
      inbox.setNeedsHuman(leadId, 1);
      if (alerts) alerts.notify(leadId, { reason: 'needs_human' });
      say({ evt: 'dana.handover', leadId, why: 'send_failed', sent: false });
      return { handover: 'send_failed', sent: false };
    }
    say({ evt: 'dana.answered', leadId, batch: batch.length, chars: r.chars, links, newChat: c.newChat });
    return { answered: true, chars: r.chars, links, newChat: c.newChat };
  }

  /**
   * One run per chat at a time: a call made while a run is in flight waits for it, so two
   * runs never read the same batch. Never rejects.
   */
  function answer(leadId, { ts = null } = {}) {
    const id = String(leadId ?? '');
    const prev = inflight.get(id) ?? Promise.resolve();
    const p = prev.then(() => run(id, ts)).catch((err) => {
      say({ level: 'error', evt: 'dana.failed', name: typeof err?.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error' });
      return { error: 'failed' };
    });
    inflight.set(id, p);
    p.then(() => {
      if (inflight.get(id) !== p) return; // a later call chained on; it cleans up
      inflight.delete(id);
      if (pendingAgain.has(id)) {
        const t = pendingAgain.get(id);
        pendingAgain.delete(id);
        wake(id, t);
      }
    });
    return p;
  }

  function fire(id) {
    const entry = timers.get(id);
    timers.delete(id);
    if (!entry) return;
    answer(id, { ts: entry.ts }).then(() => entry.settle());
  }

  /** Called by the poller for every client message it stores (P4-7, P4-16). Synchronous, never throws. */
  function wake(leadId, ts) {
    if (!configured || stopped) return;
    const id = String(leadId ?? '');
    const t = Number.isFinite(Number(ts)) ? Number(ts) : now();
    if (inflight.has(id)) {
      pendingAgain.set(id, Math.max(t, pendingAgain.get(id) ?? 0));
      return;
    }
    let entry = timers.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      entry.ts = Math.max(entry.ts, t);
    } else {
      entry = { ts: t };
      entry.done = new Promise((resolve) => { entry.settle = resolve; });
      timers.set(id, entry);
    }
    entry.timer = setTimeout(() => fire(id), batchMs);
  }

  /** Every armed batch fired and every run landed — including runs an `again` started meanwhile (tests, shutdown). */
  async function flush() {
    for (;;) {
      const waits = [...timers.values()].map((e) => e.done).concat([...inflight.values()]);
      if (!waits.length) return;
      await Promise.allSettled(waits);
    }
  }

  /** Drop every armed batch, forget every `again`, wait for the runs in flight (shutdown). */
  async function stop() {
    stopped = true;
    for (const [id, e] of timers) {
      clearTimeout(e.timer);
      timers.delete(id);
      e.settle();
    }
    pendingAgain.clear();
    await Promise.allSettled([...inflight.values()]);
  }

  const status = () => ({ configured, enabled: team.danaEnabled(), pending: timers.size, inflight: inflight.size });

  return { configured, eligible, wake, answer, flush, stop, status };
}
