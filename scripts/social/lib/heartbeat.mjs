// Daily-run routing and the Uptime Kuma heartbeat. The push URL lives outside the repo:
// ~/bona-data/daily/heartbeat-<channel>.url (mode 600). A missing file or a failed push is
// logged and never changes the run's outcome. The URL is a secret (its path is the push token):
// it is never logged, and a failure is logged only by category, never by its error message.
import fs from 'node:fs';
import path from 'node:path';
import { ksaNow } from './daily-pack.mjs';

const PUBLISHED = new Set(['published', 'already-published']);
/** Only a property run that found nothing eligible continues into the reviewed-pack path. */
export const continueToPack = result => result?.status === 'skipped-no-eligible-property';
/**
 * What Uptime Kuma should hear about this run: { status: 'up'|'down', msg } or null (say nothing).
 * Up on any confirmed publication. Down only from `downFrom` to before `downTo` Riyadh (default
 * 22:30–22:59, the last two Instagram/Facebook timer runs) when the day still has no post, so earlier
 * retries stay quiet. `uncertain` (a post that may have gone out and blocks the channel until a human
 * settles it) is down at any time: no later retry can clear it. Dry runs never report.
 */
export function heartbeatFor({ status = null, error = null, now = new Date(), dry = false, downFrom = '22:30', downTo = '23:00', uncertain = false } = {}) {
  if (dry) return null;
  if (PUBLISHED.has(status)) return { status: 'up', msg: status };
  const why = error ? (error.message ?? String(error)) : (status ?? 'no publication');
  const down = { status: 'down', msg: String(why).replace(/EAA[A-Za-z0-9]+/g, '[redacted]').slice(0, 200) };
  if (uncertain) return down;
  const { time } = ksaNow(now);
  if (time < downFrom || time >= downTo) return null;
  return down;
}
export async function pushHeartbeat(channel, beat, { dataDir, fetchImpl = fetch, log = console.log } = {}) {
  if (!beat) return { sent: false, reason: 'nothing-to-say' };
  const file = path.join(dataDir, 'daily', `heartbeat-${channel}.url`);
  let base;
  try { base = fs.readFileSync(file, 'utf8').trim(); }
  catch { log(`heartbeat: no ${path.basename(file)}; not pushed`); return { sent: false, reason: 'no-url' }; }
  let u = null;
  try { u = new URL(base); } catch { /* reported below without echoing the file */ }
  if (!u || u.protocol !== 'https:' || u.username || u.password) {
    log(`heartbeat: ${channel} push URL invalid`);
    return { sent: false, reason: 'error' };
  }
  u.search = new URLSearchParams({ status: beat.status, msg: `${channel}: ${beat.msg}` }).toString();
  let status;
  try {
    const res = await fetchImpl(u.href, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    status = res.ok ? null : Number(res.status) || 0;
  } catch {
    log(`heartbeat: ${channel} push failed (network)`);
    return { sent: false, reason: 'error' };
  }
  if (status !== null) {
    log(`heartbeat: ${channel} push failed (http ${status})`);
    return { sent: false, reason: 'error' };
  }
  log(`heartbeat: ${channel} ${beat.status}`);
  return { sent: true };
}
