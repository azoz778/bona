/** Deterministic, PII-safe historical attribution backfill. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sourceFromTouch, normaliseTouch } from './attribution.mjs';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fileHash = (file) => fs.existsSync(file) ? sha256(file) : null;
const leadRef = (id) => createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
const present = (v) => v !== null && v !== undefined && v !== '';
const knownSource = (v) => present(v) && !['(direct)', 'direct', 'unknown', '(unknown)'].includes(String(v).toLowerCase());

function parsed(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function touchPatch(lead, touch) {
  if (!touch) return {};
  const source = sourceFromTouch(touch);
  // Filling only the missing fields of a touch can bolt a paid campaign id onto a lead
  // whose source is already recorded as something else (e.g. whatsapp_organic): that
  // is not deterministic evidence, it is two different attributions stitched together.
  // A touch's fields are proposed as one coherent unit, only when nothing on the lead
  // already contradicts it.
  const conflicts = ['source', 'medium', 'campaign', 'campaign_id']
    .some((key) => present(lead[key]) && present(source[key]) && String(lead[key]) !== String(source[key]));
  if (conflicts) return {};
  const patch = {};
  for (const key of ['source', 'medium', 'campaign', 'campaign_id', 'content', 'click_ids']) {
    if (!present(lead[key]) && present(source[key])) patch[key] = source[key];
  }
  return patch;
}

/** Build a report without writing. Report rows contain hashed references, never lead PII. */
export function planAttributionBackfill(db) {
  const leads = db.db.prepare('SELECT * FROM leads ORDER BY rowid').all().map((r) => ({ ...r, first_touch: parsed(r.first_touch), last_touch: parsed(r.last_touch), click_ids: parsed(r.click_ids) }));
  const eventListings = db.db.prepare(`SELECT DISTINCT listing_id FROM events
    WHERE listing_id IS NOT NULL AND listing_id != '' AND (lead_id = ? OR (? IS NOT NULL AND session_id = ?)) ORDER BY listing_id`);
  const touchpoints = db.db.prepare('SELECT * FROM touchpoints WHERE lead_id = ? ORDER BY ts ASC, rowid ASC');
  const changes = [];
  let ambiguous = 0;
  let unknown = 0;

  for (const lead of leads) {
    const patch = {};
    const evidence = [];
    const session = lead.session_id ? db.getSession(lead.session_id) : null;
    const first = lead.first_touch ?? session?.first_touch ?? null;
    const last = lead.last_touch ?? session?.last_touch ?? first;

    if (!lead.first_touch && first) patch.first_touch = normaliseTouch(first);
    if (!lead.last_touch && last) patch.last_touch = normaliseTouch(last);
    const fromTouch = touchPatch({ ...lead, ...patch }, last ?? first);
    if (Object.keys(fromTouch).length || patch.first_touch || patch.last_touch) {
      Object.assign(patch, fromTouch);
      evidence.push(session && (!lead.first_touch || !lead.last_touch) ? 'session_touch' : 'stored_touch');
    }

    const tps = touchpoints.all(lead.lead_id).map((r) => ({ ...r, meta: parsed(r.meta) }));
    if (!present(lead.campaign_id) && !present(patch.campaign_id)) {
      const ad = [...tps].reverse().find((tp) => tp.meta?.ad_meta || present(tp.campaign_id));
      if (ad) {
        const effective = { ...lead, ...patch };
        const effectiveHasAttribution = ['source', 'medium', 'campaign', 'campaign_id', 'click_ids'].some((key) => present(effective[key]));
        const baseTs = Number(last?.ts ?? first?.ts);
        const adTs = Number(ad.ts);
        const adIsNewer = Number.isFinite(adTs) && (!Number.isFinite(baseTs) || adTs > baseTs);
        // Referral rows and browser touches are alternate last-touch candidates, not
        // bags of fields. An older referral must never complete or overwrite a newer
        // browser touch. A newer referral may replace the pending browser-derived
        // columns, but still may not contradict attribution already stored on the lead.
        const comparison = adIsNewer ? lead : effective;
        const adConflicts = (present(comparison.source) && present(ad.source) && comparison.source !== ad.source)
          || (present(comparison.medium) && present(ad.medium) && comparison.medium !== ad.medium)
          || (present(comparison.campaign) && present(ad.campaign) && comparison.campaign !== ad.campaign)
          || (present(comparison.campaign_id) && present(ad.campaign_id) && comparison.campaign_id !== ad.campaign_id);
        if (!adConflicts && (adIsNewer || !effectiveHasAttribution)) {
          for (const key of ['source', 'medium', 'campaign', 'campaign_id']) {
            if (!present(lead[key]) && present(ad[key])) patch[key] = ad[key];
          }
          const click = ad.meta?.ad_meta?.ctwa_clid;
          if (click && !present(lead.click_ids)) patch.click_ids = { ctwa_clid: String(click).slice(0, 300) };
          if (adIsNewer && !lead.last_touch) {
            patch.last_touch = normaliseTouch({
              ts: ad.ts, utm_source: ad.source, utm_medium: ad.medium,
              utm_campaign: ad.campaign, utm_id: ad.campaign_id,
              click_ids: click ? { ctwa_clid: String(click).slice(0, 300) } : null,
              listing_id: ad.listing_id,
            });
          }
          evidence.push('whatsapp_referral');
        }
      }
    }

    if (!present(lead.listing_id)) {
      const listings = new Set(eventListings.all(lead.lead_id, lead.session_id, lead.session_id).map((r) => r.listing_id));
      for (const tp of tps) if (present(tp.listing_id)) listings.add(tp.listing_id);
      if (listings.size === 1) {
        patch.listing_id = [...listings][0];
        evidence.push('session_exact_listing');
      } else if (listings.size > 1) {
        ambiguous += 1;
      }
    }

    if (Object.keys(patch).length) changes.push({ lead_ref: leadRef(lead.lead_id), lead_id: lead.lead_id, patch, evidence: [...new Set(evidence)] });
    const effective = { ...lead, ...patch };
    if (!knownSource(effective.source) && !present(effective.campaign_id) && !present(effective.click_ids)) unknown += 1;
  }

  return {
    dry_run: true,
    total_leads: leads.length,
    proposed_updates: changes.length,
    untouched: leads.length - changes.length,
    ambiguous,
    unknown,
    changes,
    rollback: 'Apply creates a 0600 snapshot and manifest; restore requires --rollback <manifest> and normally --force after verifying the target.',
  };
}

export function applyAttributionBackfill(db) {
  const plan = planAttributionBackfill(db);
  const before = db.countLeads();
  db.transaction(() => {
    for (const change of plan.changes) db.updateLead(change.lead_id, change.patch);
  });
  const after = db.countLeads();
  if (after !== before) throw new Error(`lead count invariant failed: ${before} -> ${after}`);
  return { ...plan, dry_run: false, applied: plan.changes.length, lead_count_before: before, lead_count_after: after };
}

/** Create a consistent SQLite snapshot (including committed WAL pages) and an integrity manifest. */
export function createRestrictedBackup(dbFile, { backupDir = path.join(path.dirname(dbFile), 'backups'), now = () => Date.now() } = {}) {
  const source = path.resolve(dbFile);
  if (!fs.statSync(source).isFile()) throw new Error('database path is not a file');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const stamp = String(now());
  const file = path.join(backupDir, `bona-before-attribution-${stamp}.db`);
  if (fs.existsSync(file)) throw new Error('backup already exists');
  const snapshot = new DatabaseSync(source, { readOnly: true });
  try {
    // VACUUM INTO is SQLite's online, transactionally consistent snapshot. A raw copy
    // can omit committed rows that still live in the WAL while bona-api is running.
    snapshot.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  } finally {
    snapshot.close();
  }
  fs.chmodSync(file, 0o600);
  const manifest = {
    version: 1,
    created_at: Number(stamp),
    source,
    source_sha256: sha256(source),
    source_wal_sha256: fileHash(`${source}-wal`),
    backup: path.resolve(file),
    backup_sha256: sha256(file),
  };
  const manifestFile = `${file}.json`;
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(manifestFile, 0o600);
  return { file, manifestFile, sha256: manifest.backup_sha256 };
}

/** Restore through an adjacent temp file; integrity and target-change checks fail closed. */
export function restoreRestrictedBackup(dbFile, manifestFile, { force = false, apiOffline = false } = {}) {
  if (apiOffline !== true) {
    throw new Error('rollback requires an explicit API-offline confirmation; stop bona-api before restoring');
  }
  const target = path.resolve(dbFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.source !== target) throw new Error('rollback manifest belongs to a different target');
  if (!path.isAbsolute(manifest.backup) || !fs.existsSync(manifest.backup)) throw new Error('rollback backup is missing');
  if (sha256(manifest.backup) !== manifest.backup_sha256) throw new Error('rollback backup checksum mismatch');
  const targetChanged = fs.existsSync(target) && (
    sha256(target) !== manifest.source_sha256
    || fileHash(`${target}-wal`) !== (manifest.source_wal_sha256 ?? null)
  );
  if (!force && targetChanged) {
    throw new Error('rollback target has changed; inspect it and repeat with --force');
  }
  const temp = `${target}.restore-${process.pid}`;
  fs.copyFileSync(manifest.backup, temp);
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  return { restored: true, target, backup_sha256: manifest.backup_sha256 };
}
