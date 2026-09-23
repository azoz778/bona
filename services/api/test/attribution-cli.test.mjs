import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMetaSpendArgs } from '../bin/meta-spend.mjs';
import { parseBackfillArgs, main as backfillMain } from '../bin/attribution-backfill.mjs';
import { openDb } from '../lib/db.mjs';
import { createRestrictedBackup } from '../lib/attribution-backfill.mjs';

test('Meta spend CLI requires an explicit date window and defaults to dry-run JSON', () => {
  assert.deepEqual(parseMetaSpendArgs(['--from', '2026-09-01', '--to', '2026-09-02', '--json']), {
    from: '2026-09-01', to: '2026-09-02', dryRun: true, json: true,
  });
  assert.equal(parseMetaSpendArgs(['--from=2026-09-01', '--to=2026-09-02', '--apply']).dryRun, false);
  assert.throws(() => parseMetaSpendArgs(['--to', '2026-09-02']), /--from/);
  assert.throws(() => parseMetaSpendArgs(['--from', 'bad', '--to', '2026-09-02']), /date/i);
  assert.throws(() => parseMetaSpendArgs(['--from', '2026-09-03', '--to', '2026-09-02']), /date/i);
  assert.throws(() => parseMetaSpendArgs(['--from', '2026-09-01', '--to', '2026-09-02', '--wat']), /unknown/);
});

test('backfill CLI defaults to dry-run and requires explicit rollback inputs', () => {
  assert.deepEqual(parseBackfillArgs(['--db', '/tmp/bona.db', '--json']), { dbFile: '/tmp/bona.db', dryRun: true, json: true, rollbackManifest: null, force: false });
  assert.equal(parseBackfillArgs(['--db=/tmp/bona.db', '--apply']).dryRun, false);
  assert.equal(parseBackfillArgs(['--db', '/tmp/bona.db', '--rollback', '/tmp/backup.json', '--force']).rollbackManifest, '/tmp/backup.json');
  assert.throws(() => parseBackfillArgs(['--apply']), /--db/);
  assert.throws(() => parseBackfillArgs(['--db', '/tmp/bona.db', '--rollback']), /manifest/);
});

test('backfill rollback cannot mutate a database unless --apply is explicit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bona-cli-rollback-'));
  const file = path.join(dir, 'bona.db');
  const db = openDb(file);
  db.insertLead({ lead_id: 'lead-guard', created: 1, updated: 1, stage: 'new' });
  db.close();
  const backup = createRestrictedBackup(file, { backupDir: path.join(dir, 'backups'), now: () => 42 });
  const before = fs.readFileSync(file);
  assert.throws(
    () => backfillMain(['--db', file, '--rollback', backup.manifestFile]),
    /requires --apply/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  fs.rmSync(dir, { recursive: true, force: true });
});
