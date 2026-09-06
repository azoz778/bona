#!/usr/bin/env node
// Recovery: make the daemon look again at messages it already marked "seen".
//
//   systemctl --user stop bona-intake
//   node services/intake/unsee.mjs <messageId> [<messageId>…]
//   systemctl --user start bona-intake
//
// Why it exists: before 2026-09-06 the daemon had no idea what a video message was — it
// marked each one seen and moved on, and "seen" is forever. The four clips the owner sent
// that day are the first use. Any stale job record for the id is dropped too, so the replay
// starts clean (state.forgetSeen).
//
// The daemon keeps the state file in memory and rewrites it on every change, so it MUST be
// stopped first — otherwise its next save puts the ids straight back. This script checks
// and refuses; --force skips the check (only for a box where the unit is not installed).
import { execFileSync } from 'node:child_process';
import { loadConfig } from './lib/env.mjs';
import { createState } from './lib/state.mjs';
import { say } from './lib/log.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  say('usage: unsee.mjs <messageId> [<messageId>…] [--force]');
  process.exit(2);
}

if (!force) {
  let active = 'unknown';
  try { active = execFileSync('systemctl', ['--user', 'is-active', 'bona-intake'], { encoding: 'utf8' }).trim(); } catch (err) { active = String(err.stdout || '').trim() || 'inactive'; }
  if (active === 'active' || active === 'activating') {
    say('✋ bona-intake is running — stop it first (systemctl --user stop bona-intake), or the daemon will re-save these ids.');
    process.exit(1);
  }
}

const cfg = loadConfig();
const state = createState(cfg.statePath);
const before = ids.map((id) => `${id} seen=${state.hasSeen(id)} job=${state.getJob(id)?.status ?? '-'}`);
const n = state.forgetSeen(ids);
say(`${cfg.statePath}`);
for (const line of before) say(`  ${line}`);
say(`forgot ${n} of ${ids.length} — the next poll will handle them again.`);
