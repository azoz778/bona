/**
 * The WhatsApp link probe and the instance identity guard (DESIGN §5.3, §6.4, §14; PR-L, PLAN T09).
 *
 * The hazard it guards against: lib/wa.mjs defaults the instance to 'abdulaziz-personal' (the
 * owner's PERSONAL WhatsApp, on the same Evolution server as Bona's), while "the number is Bona's
 * own" (`ownNumberFrom === 'instance'`) is read from BONA_WA_INSTANCE_JID alone. With
 * BONA_WA_INSTANCE missing or wrong and the JID still set, the own-number rule would take in every
 * chat on his personal WhatsApp. So `identityOk()` is true only when ALL of these hold:
 *   1. BONA_WA_INSTANCE is set explicitly in env (not the code default);
 *   2. it is not a personal instance ('abdulaziz-personal', or any name in
 *      BONA_WA_PERSONAL_INSTANCES; trimmed, any case);
 *   3. BONA_WA_INSTANCE_JID is a phone jid, and not the owner's own number (BONA_OWNER_JID): the
 *      instance cannot be "Bona's own" when the env says it is his;
 *   4. the live instance's connected number, `ownerJid` from `GET /instance/fetchInstances`
 *      (lib/evolution.mjs `fetchInstance`), is a phone jid whose digits equal BONA_WA_INSTANCE_JID's.
 * A setup that fails 1-3 is never asked anything: nothing on a personal instance is probed. When
 * the JID claims Bona's number but 1-3 fail, the start says so once: an owner web push
 * (`identity_mismatch`) and a Kuma DOWN.
 *
 * When it runs: `start()` probes at once, then every 10 min (PROBE_EVERY_MS), one round at a time.
 * Each round checks the identity first and records the answer before it asks the link. A run is
 * the time from one `start()` to its `stop()`: `start()` forgets what the last run learnt (the
 * identity answer, the failed checks in a row, an alerted mismatch, the good-probe streak), since
 * nothing watched the instance while it was stopped.
 *   - A mismatch makes it false at once, plus one owner alert (web push `identity_mismatch`, Kuma
 *     DOWN) per incident in a run; never a note through another instance.
 *   - An error or timeout (or an instance with no number at the moment) keeps the last value for
 *     up to 30 min after the last answer (IDENTITY_STALE_MS), then it fails closed. No web push:
 *     Kuma reads it as `identity_unknown`.
 *   - Until the first answer of a run it is false. Kuma hears that as `identity_pending` (up) after
 *     one failed check and as `identity_unknown` (DOWN) after two in a row (IDENTITY_DOWN_AFTER).
 * A whatsappNumbers answer proves the link only (any instance answers it), so it never counts as
 * identity.
 *
 * The link probe (G3): `POST /chat/whatsappNumbers/<inst>` for Bona's own number, in the same round.
 * Two failures in a row (LINK_DOWN_AFTER) make `linkOk()` false, with one web push (`wa_link_down`)
 * per outage and a Kuma DOWN; one good answer makes it true again. Until something is probed it is
 * true, as before this module: nothing is held back for a link nobody has looked at.
 * While the newest identity answer is another number (that round's, or the last one, kept through
 * errors), the instance may be the owner's own WhatsApp: the round asks nothing more through it.
 * No link probe goes out, `linkOk()` keeps its value, and Kuma hears `identity_mismatch`. The
 * link probe comes back in the first round whose answer is Bona's number again.
 * `linkStable()` is DESIGN §6.4's "the link has held for 10 min", for the backlog rule: two good
 * probes in a row of one run that span LINK_STABLE_MS; false before. A failed probe, a round that
 * skipped the probe for a mismatch, and a new `start()` all start the count again.
 *
 * The Kuma push "Bona WhatsApp link" (BONA_KUMA_WA_LINK_PUSH, DESIGN §14) hears every round once:
 * `up` when the link is up and the identity checked out (`ok`) or has not answered once since the
 * start (`identity_pending`), else `down`, with a fixed code as the message (`link_down`,
 * `identity_mismatch`, `identity_unknown`, `misconfigured`). The URL carries the push
 * token: it must be https (or http to this machine), never with credentials, and it is never
 * logged.
 *
 * Six probes an hour: a probe must not look automated. It writes no WhatsApp message at all and is
 * handed no way to: what it can reach is the two read probes, Kuma and `alerts.notifyOwners`.
 * Constructing it contacts nothing; only `start()` (wired by PR-INT, T14) and `probe()` do. The log
 * carries event names, booleans and fixed codes: never a number, a jid, a key, a URL or an
 * upstream text. `health()` is booleans only (/health `inbox.identityOk`, `wa.linkOk`).
 */
import { bareJid, fetchInstance, whatsappNumbers } from './evolution.mjs';
import { waConfig } from './wa.mjs';
import { PERSONAL_INSTANCE } from './config.mjs';

/** The probe cadence (DESIGN §5.3): six an hour. */
export const PROBE_EVERY_MS = 10 * 60_000;
/** How long an identity answer holds while the probes fail (DESIGN §5.3). */
export const IDENTITY_STALE_MS = 30 * 60_000;
/** Failed identity checks in a row, with no answer since the start, before Kuma hears DOWN (DESIGN §14). */
export const IDENTITY_DOWN_AFTER = 2;
/** Failed link probes in a row before the link is down (DESIGN §5.3). */
export const LINK_DOWN_AFTER = 2;
/** How long the link must have answered before backlog may be answered (DESIGN §6.4). */
export const LINK_STABLE_MS = 10 * 60_000;
/** Each probe request's deadline. */
export const PROBE_TIMEOUT_MS = 10_000;

/** The connected number as 2.3.7 writes it: a phone jid, a device suffix allowed. */
const OWNER_JID_RE = /^\d{8,15}(?::\d+)?@s\.whatsapp\.net$/;
/** The failure codes the log may carry; anything else is `bad_response`. */
const PROBE_CODES = new Set(['timeout', 'network', 'auth', 'forbidden', 'not_found', 'bad_response']);
/** Hosts a plain-http Kuma push may go to: this machine only (the token would cross the network in clear otherwise). */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The real timer: one shot, never keeping the process alive. */
function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}

/** The personal instances, trimmed and lower-cased: the code's own one plus the configured ones. */
function personalNames(cfg, env) {
  const given = Array.isArray(cfg?.waPersonalInstances) ? cfg.waPersonalInstances : String(env.BONA_WA_PERSONAL_INSTANCES ?? '').split(',');
  return new Set([PERSONAL_INSTANCE, ...given].map((n) => String(n ?? '').trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether the env can describe Bona's own number at all (checks 1-3, and Evolution configured),
 * and if not, why. `alert` is true where the JID says "Bona's own number" but the instance cannot
 * be it: the hazard itself.
 */
function setupOf(env, cfg) {
  const wa = waConfig(env);
  if (wa.ownNumberFrom === 'invalid') return { ok: false, why: 'jid_invalid', alert: false, wa };
  if (wa.ownNumberFrom !== 'instance') return { ok: false, why: 'no_own_number', alert: false, wa };
  const named = typeof env.BONA_WA_INSTANCE === 'string' ? env.BONA_WA_INSTANCE.trim() : '';
  if (!named) return { ok: false, why: 'instance_unset', alert: true, wa };
  if (personalNames(cfg, env).has(named.toLowerCase())) return { ok: false, why: 'personal_instance', alert: true, wa };
  const ownDigits = bareJid(wa.instanceJid);
  if (!ownDigits || ownDigits === bareJid(wa.ownerJid)) return { ok: false, why: 'owner_number', alert: true, wa };
  if (!wa.baseUrl || !wa.apiKey) return { ok: false, why: 'no_evolution', alert: false, wa };
  return { ok: true, why: null, alert: false, wa, ownDigits };
}

/** The Kuma push URL, or null when it is unset (`invalid` false) or unusable (`invalid` true). */
function kumaOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { url: null, invalid: false };
  let u = null;
  try { u = new URL(s); } catch { u = null; }
  const ok = Boolean(u) && !u.username && !u.password
    && (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)));
  return ok ? { url: u, invalid: false } : { url: null, invalid: true };
}

/** A probe failure as a fixed code. */
const codeOf = (err) => (PROBE_CODES.has(err?.code) ? err.code : 'bad_response');

/**
 * @typedef {object} WaLink
 * @property {() => boolean} identityOk  the instance is Bona's own, checked number (false until a probe has answered)
 * @property {() => boolean} identityMismatch  the newest probe answer named another number (an established mismatch)
 * @property {() => boolean} identityMismatchAlerted  the owners were already pushed about the current mismatch
 * @property {() => Promise<boolean>} probeIdentity  the identity half alone: no link probe, no Kuma beat, no failure count
 * @property {() => boolean} linkOk      WhatsApp answers through the instance (true until two probes in a row fail)
 * @property {() => boolean} linkStable  the link has answered for 10 min (DESIGN §6.4; false until two good probes of this run span it)
 * @property {() => void} start          forget the last run, probe now, then every 10 min (a second call does nothing)
 * @property {() => void} stop           no more probes; a round in flight changes nothing more
 * @property {() => Promise<void>} probe one round now (the one in flight, if any); never rejects
 * @property {() => Promise<void>} flush waits for every round and the start's alert
 * @property {() => { linkOk: boolean, identityOk: boolean }} health  booleans only
 */

/**
 * @param {{ env?: object, cfg?: object|null, alerts?: { notifyOwners: Function }|null,
 *           fetchImpl?: typeof globalThis.fetch, now?: () => number, log?: (entry: object) => void,
 *           schedule?: (fn: () => void, ms: number) => { cancel: () => void }, timeoutMs?: number }} [deps]
 *   `env` is the process env (lib/env.mjs; index.mjs hands in `cfg.env`); `cfg`, when given, supplies
 *   `waPersonalInstances` and `kumaWaLinkPush` as lib/config.mjs parsed them.
 * @returns {WaLink}
 */
export function createWaLink({
  env = {}, cfg = null, alerts = null, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {},
  schedule = defaultSchedule, timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const setup = setupOf(env ?? {}, cfg);
  const { wa } = setup;
  const kuma = kumaOf(cfg?.kumaWaLinkPush ?? env?.BONA_KUMA_WA_LINK_PUSH);
  const canProbe = setup.ok && typeof fetchImpl === 'function';
  const say = (entry) => { try { log(entry); } catch { /* a logger never stops a probe */ } };

  // The newest identity answer, { match, at } (`at` = when it came back); null = none since start.
  let identity = null;
  // Failed identity checks in a row in this run; a good answer sets it back to 0.
  let idFails = 0;
  // This run has alerted the current mismatch; Bona's number again ends the incident.
  let mismatchAlerted = false;
  let fails = 0;
  let linkUp = true;
  let downAlerted = false;
  // The current streak of good link probes: when its first and its newest one answered.
  let goodSince = null;
  let lastGood = null;
  let loggedIdentity = null;
  // PR-INT r3: every identity check takes a number when it starts; an answer is recorded only when its check started
  // after the last recorded one, so a slow early answer never overwrites a newer one (a confirmed mismatch, say).
  let probeSeq = 0;
  let recordedSeq = 0;
  const takeSeq = () => { probeSeq += 1; return probeSeq; };
  const newest = (seq) => { if (seq <= recordedSeq) return false; recordedSeq = seq; return true; };
  let started = false;
  let timer = null;
  let gen = 0;
  let inflight = null;
  let controller = null;
  const running = new Set();
  const track = (p) => {
    running.add(p);
    p.then(() => running.delete(p), () => running.delete(p));
    return p;
  };

  const identityOk = () => setup.ok && identity?.match === true && now() - identity.at <= IDENTITY_STALE_MS;
  const linkStable = () => linkUp && goodSince !== null && lastGood - goodSince >= LINK_STABLE_MS;

  /** One owner web push; notifyOwners never rejects, and one that throws is ignored. */
  async function push(reason) {
    try {
      await alerts?.notifyOwners?.({ reason });
    } catch { /* the probe carries on: Kuma still hears it */ }
  }

  /** One Kuma beat with a fixed code; a failure is logged by category, never by URL or text. */
  async function beat(status, msg) {
    if (!kuma.url || typeof fetchImpl !== 'function') return;
    const u = new URL(kuma.url.href);
    u.search = new URLSearchParams({ status, msg }).toString();
    try {
      const res = await fetchImpl(u.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!res?.ok) say({ level: 'warn', evt: 'wa.link.kuma_failed', code: 'http', status: Number(res?.status) || 0 });
    } catch (err) {
      say({ level: 'warn', evt: 'wa.link.kuma_failed', code: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' });
    }
  }

  /** The identity half of a round: `{ match }`, or `{ error }` with a fixed code. */
  async function askIdentity(signal) {
    try {
      const { ownerJid } = await fetchInstance({ baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance: wa.instance, fetchImpl, timeoutMs, signal });
      if (ownerJid === null) return { error: 'no_number' };
      return { match: OWNER_JID_RE.test(ownerJid) && bareJid(ownerJid) === setup.ownDigits };
    } catch (err) {
      return { error: codeOf(err) };
    }
  }

  /** The link half of a round: `{ ok: true }`, or `{ error }` with a fixed code. */
  async function askLink(signal) {
    try {
      const answers = await whatsappNumbers({
        baseUrl: wa.baseUrl, apiKey: wa.apiKey, instance: wa.instance, numbers: [setup.ownDigits], fetchImpl, timeoutMs, signal,
      });
      return answers.some((a) => a.exists && a.digits === setup.ownDigits) ? { ok: true } : { error: 'not_on_whatsapp' };
    } catch (err) {
      return { error: codeOf(err) };
    }
  }

  /**
   * One round: the identity check, then the link probe, then one Kuma beat. The identity answer is
   * recorded before the link is asked, so it counts however long the link probe then takes. While
   * the newest answer is another number, the round ends after the identity: its alert and Kuma
   * beat, and no link probe. From the moment stop() is called, a round still in flight changes
   * nothing more.
   */
  async function round(g) {
    const ac = new AbortController();
    controller = ac;
    const fresh = () => g === gen;
    const seq = takeSeq();
    const id = await askIdentity(ac.signal);
    if (!fresh()) return;

    if (!id.error && !newest(seq)) {
      // A newer check answered first: this round records nothing, and asks the link on what that one recorded.
    } else if (id.error) {
      idFails += 1;
      say({ level: 'warn', evt: 'wa.link.probe_failed', probe: 'identity', code: id.error });
    } else {
      idFails = 0;
      identity = { match: id.match, at: now() };
      if (id.match) mismatchAlerted = false;
    }
    const idNow = identityOk();
    if (idNow !== loggedIdentity) {
      const why = idNow ? 'match' : identity?.match === false ? 'mismatch' : identity ? 'stale' : 'unknown';
      say({ level: idNow ? 'info' : 'error', evt: 'wa.identity', ok: idNow, why });
      loggedIdentity = idNow;
    }
    // The newest answer is another number (this round's, or the last one, kept through an error),
    // perhaps the owner's own WhatsApp: nothing more is asked through that instance. linkOk keeps
    // its value; no probe watched the link, so the stable count starts again.
    if (identity?.match === false) {
      goodSince = null;
      lastGood = null;
      if (!mismatchAlerted) { mismatchAlerted = true; await push('identity_mismatch'); }
      if (!fresh()) return;
      await beat('down', 'identity_mismatch');
      return;
    }

    const ln = await askLink(ac.signal);
    if (!fresh()) return;
    let downDue = false; // this round took the link down: one web push per outage
    if (ln.ok) {
      fails = 0;
      const t = now();
      if (goodSince === null) goodSince = t;
      lastGood = t;
      if (!linkUp) { linkUp = true; downAlerted = false; say({ evt: 'wa.link', ok: true }); }
    } else {
      say({ level: 'warn', evt: 'wa.link.probe_failed', probe: 'link', code: ln.error });
      fails += 1;
      goodSince = null;
      lastGood = null;
      if (fails >= LINK_DOWN_AFTER && linkUp) {
        linkUp = false;
        say({ level: 'error', evt: 'wa.link', ok: false });
      }
      if (!linkUp && !downAlerted) { downAlerted = true; downDue = true; }
    }
    if (downDue) {
      await push('wa_link_down');
      if (!fresh()) return;
    }
    // An identity the start has not seen answered yet is DOWN after two failed checks in a row, as
    // the link is (DESIGN §14); one that answered and has gone stale is DOWN at once.
    if (!linkUp) await beat('down', 'link_down');
    else if (identityOk()) await beat('up', 'ok');
    else if (identity !== null || idFails >= IDENTITY_DOWN_AFTER) await beat('down', 'identity_unknown');
    else await beat('up', 'identity_pending');
  }

  /**
   * The identity half alone (PR-INT r2): fetchInstances, the same answer rules as a round (the answer recorded, a
   * mismatch alerted once per incident), but no link probe, no Kuma beat and no failure counted. index.mjs's 30-s
   * identity watch runs it until the instance is proven once, so a 503 blip there never adds to the link's count.
   * A full round in flight answers it instead. Resolves to identityOk() after it.
   */
  async function probeIdentity() {
    if (!canProbe || !started) return identityOk();
    if (inflight) { await inflight; return identityOk(); }
    const g = gen;
    const seq = takeSeq();
    const id = await askIdentity(AbortSignal.timeout(timeoutMs));
    if (g !== gen || id.error || !newest(seq)) return identityOk();
    identity = { match: id.match, at: now() };
    if (id.match) mismatchAlerted = false;
    const idNow = identityOk();
    if (idNow !== loggedIdentity) {
      say({ level: idNow ? 'info' : 'error', evt: 'wa.identity', ok: idNow, why: idNow ? 'match' : 'mismatch' });
      loggedIdentity = idNow;
    }
    if (identity.match === false && !mismatchAlerted) { mismatchAlerted = true; await push('identity_mismatch'); }
    return identityOk();
  }

  function probe() {
    if (!canProbe) return Promise.resolve();
    if (!inflight) {
      const p = track(round(gen).catch(() => {}).finally(() => { if (inflight === p) inflight = null; }));
      inflight = p;
    }
    return inflight;
  }

  function loop() {
    timer = null;
    if (!started) return;
    const g = gen;
    probe().then(() => {
      if (started && g === gen && !timer) timer = schedule(loop, PROBE_EVERY_MS);
    });
  }

  function start() {
    if (started) return;
    started = true;
    // Every start fails closed: nothing watched the instance while it was stopped, so what the last
    // run learnt is not this run's (DESIGN §5.3; §6.4: the link may have dropped and come back).
    identity = null;
    idFails = 0;
    mismatchAlerted = false;
    goodSince = null;
    lastGood = null;
    if (kuma.invalid) say({ level: 'error', evt: 'wa.link.kuma_invalid' });
    if (!canProbe) {
      say({ level: setup.alert ? 'error' : 'warn', evt: 'wa.link.off', why: setup.why ?? 'no_fetch' });
      if (setup.alert) track(push('identity_mismatch').then(() => beat('down', 'misconfigured')));
      return;
    }
    loop();
  }

  function stop() {
    started = false;
    gen += 1;
    timer?.cancel?.();
    timer = null;
    controller?.abort();
    controller = null;
    inflight = null;
  }

  async function flush() {
    while (running.size) await Promise.allSettled([...running]);
  }

  return {
    identityOk,
    linkOk: () => linkUp,
    linkStable,
    start,
    stop,
    probe,
    flush,
    // A probe's answer named another number (PR-INT r1): a mismatch established, not merely an identity unproven.
    identityMismatch: () => setup.ok && identity?.match === false,
    // This run has already pushed the owners about the current mismatch (once per incident): a caller adds none.
    identityMismatchAlerted: () => mismatchAlerted,
    probeIdentity,
    health: () => ({ linkOk: linkUp === true, identityOk: identityOk() === true }),
  };
}
