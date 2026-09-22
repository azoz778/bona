import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaSpendArgs } from '../bin/meta-spend.mjs';
import { parseBackfillArgs } from '../bin/attribution-backfill.mjs';

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
