// The site validator's copy check (scripts/curate/validate.mjs) — the deploy's last gate for a
// contact detail or another brand in a listing's words. It shares FORBIDDEN and the digit normaliser
// with the WhatsApp intake (scripts/curate/rules.mjs), so a number written in Arabic-Indic or Persian
// digits is caught here too, and ordinary listing copy (./ordinary-copy-fixture.mjs) is left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ORDINARY_COPY } from './ordinary-copy-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = ['scripts/curate/validate.mjs', 'scripts/curate/rules.mjs', 'src/lib/units-summary.mjs', 'src/data/kind-map.json', 'src/data/listings.json'];

/** A copy of just what validate.mjs reads, with listings.json rewritten by `edit`. */
function validateWith(edit) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bona-validate-copy-')));
  try {
    for (const f of FILES) {
      fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
    const file = path.join(dir, 'src/data/listings.json');
    const listings = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(listings);
    fs.writeFileSync(file, JSON.stringify(listings, null, 2));
    return spawnSync(process.execPath, [path.join(dir, 'scripts/curate/validate.mjs')], { cwd: dir, encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('validate.mjs leaves ordinary listing copy alone, in both languages', () => {
  const res = validateWith((listings) => {
    const l = listings[0];
    l.description.en = `${l.description.en}\n\n${ORDINARY_COPY.join('\n\n')}`;
    l.description.ar = `${l.description.ar}\n\n${ORDINARY_COPY.join('\n\n')}`;
  });
  assert.equal(res.status, 0, res.stderr);
});

test('validate.mjs catches a contact number written in Arabic-Indic or Persian digits', () => {
  for (const leak of ['الرقم الموحد ٩٢٠٠٠١٢٣٤', 'جوال ٠٥٥١٢٣٤٥٦٧', 'هاتف ٠١٢٦٦٠١٢٣٤', 'الرقم المجاني ٨٠٠١٢٤٤٤٤٤', 'للتواصل ۰۵۵۱۲۳۴۵۶۷']) {
    let id;
    const res = validateWith((listings) => {
      const l = listings[0];
      id = l.id;
      l.description.ar = `${l.description.ar}\n\n${leak}`;
    });
    assert.equal(res.status, 1, `${leak} must fail the deploy`);
    assert.match(res.stderr, new RegExp(`${id}: description\\.ar mentions a contact detail or another brand: `), res.stderr);
  }
});
