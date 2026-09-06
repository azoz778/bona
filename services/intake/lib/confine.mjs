// Confinement for the `claude -p` step.
//
// Measured on claude 2.x (2026-09-06): the Read tool is NEVER gated by --permission-mode.
// `bypassPermissions`, `dontAsk`, `manual` and the CLI default all let the model read
// /etc/hostname, with or without `--allowedTools "Read(<dir>/**)"`, and
// `--permission-prompts none` changes nothing because Read never raises a prompt.
// A settings file IS honoured under --safe-mode ("Explicitly provide context via:
// … --settings"), and deny rules beat allow rules — so a blanket `Read(//**)` deny locks
// the model out of its own work dir too.
//
// What does work, and is what this module builds: an explicit deny rule for every sibling
// of every component of the work dir's path. `/home/azoz778/bona-data/intake/<d>/<id>`
// yields ~320 rules (~12 KB) and leaves exactly one readable branch — the work dir.
// Verified: `Read /etc/hostname` -> DENIED, `Read <workDir>/allowed.txt` -> the contents.
import fs from 'node:fs';
import path from 'node:path';

/** Deny rules covering everything on the filesystem except `dir` and its ancestors. */
export function outsideDenyRules(dir) {
  const parts = path.resolve(dir).split('/').filter(Boolean);
  const rules = [];
  let prefix = '';
  for (const part of parts) {
    let entries = [];
    try { entries = fs.readdirSync(prefix || '/', { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.name === part) continue;
      const p = `${prefix}/${entry.name}`;
      rules.push(`Read(/${p})`);                                        // the file itself
      if (entry.isDirectory() || entry.isSymbolicLink()) rules.push(`Read(/${p}/**)`); // everything under it
    }
    prefix = `${prefix}/${part}`;
  }
  return rules;
}

/**
 * Write the settings file that confines one `claude -p` run to `workDir`.
 * @returns {{file:string, ruleCount:number}}
 */
export function writeConfinement(workDir, file = path.join(workDir, 'claude-settings.json')) {
  const abs = path.resolve(workDir);
  const deny = outsideDenyRules(abs);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    permissions: { defaultMode: 'dontAsk', allow: [`Read(/${abs}/**)`], deny },
  }, null, 1)}\n`);
  return { file, ruleCount: deny.length };
}
