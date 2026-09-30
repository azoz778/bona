#!/usr/bin/env node
/**
 * Generate the Web Push (VAPID) key pair for phone alerts — ONCE, on the VPS (design §5):
 *
 *   node /opt/bona/services/api/bin/vapid-keys.mjs --file ~/.secrets/bona-services.env [--subject mailto:…]
 *
 * (The flag is --file, not --env-file: node itself intercepts --env-file anywhere in argv and exits if the file is missing.)
 * A half-configured file (only one key) is an error, and --subject must be mailto:… or https:…
 * (lib/push.mjs VAPID_SUBJECT_RE — the same rule the server applies at start).
 * Appends BONA_VAPID_PUBLIC / BONA_VAPID_PRIVATE (and BONA_VAPID_SUBJECT when given) and
 * keeps the file 0600. Never overwrites keys that are there: every phone's subscription is
 * tied to the public key it was made with, so a new pair silently ends every alert until
 * each member turns alerts on again. Prints the public key only. bona-api reads the keys
 * at its next start (deploy.sh).
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { generateVapidKeys, VAPID_SUBJECT_RE } from '../lib/push.mjs';
import { parseEnvText } from '../lib/env.mjs';

export function writeVapidKeys(file, { subject = null } = {}) {
  if (subject !== null && !VAPID_SUBJECT_RE.test(subject)) return { written: false, reason: 'bad_subject' };
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const env = parseEnvText(text);
  const hasPub = Boolean(env.BONA_VAPID_PUBLIC);
  const hasPriv = Boolean(env.BONA_VAPID_PRIVATE);
  if (hasPub && hasPriv) return { written: false, reason: 'present' };
  if (hasPub || hasPriv) return { written: false, reason: 'partial' };
  if (exists) fs.chmodSync(file, 0o600);
  const k = generateVapidKeys();
  const lines = [
    `# Web Push (phone alerts), ${new Date().toISOString().slice(0, 10)}, services/api/bin/vapid-keys.mjs. Do not rotate: every phone's alerts would end.`,
    `BONA_VAPID_PUBLIC=${k.publicKey}`,
    `BONA_VAPID_PRIVATE=${k.privateKey}`,
    ...(subject ? [`BONA_VAPID_SUBJECT=${subject}`] : []),
  ];
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { written: true, publicKey: k.publicKey };
}

let main = null;
try { main = pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { /* not run as a script */ }
if (main === import.meta.url) {
  const args = process.argv.slice(2);
  const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const file = at('--file');
  if (!file) {
    console.error('usage: vapid-keys.mjs --file <path> [--subject mailto:…|https:…]');
    process.exit(2);
  }
  const out = writeVapidKeys(file, { subject: at('--subject') });
  if (out.reason === 'bad_subject') { console.error('The subject must be mailto:… or https:…'); process.exit(2); }
  if (out.reason === 'partial') { console.error('Only one of BONA_VAPID_PUBLIC / BONA_VAPID_PRIVATE is set — fix the file by hand; nothing changed.'); process.exit(1); }
  console.log(out.written ? `VAPID keys written. Public key: ${out.publicKey}` : 'VAPID keys already present — nothing changed.');
}
