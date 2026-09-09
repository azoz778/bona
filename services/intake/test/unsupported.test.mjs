import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { unsupportedDocument } from '../lib/messages.mjs';

describe('unsupportedDocument', () => {
  it('names the file and the extension it actually got', () => {
    const out = unsupportedDocument('Durrat_Al_Basateen_TK_Estates-3.html', 'text/html');
    assert.match(out, /DurratAlBasateenTKEstates-3\.html/);
    assert.match(out, /\.html file/);
    assert.match(out, /only read PDF brochures/i);
    assert.match(out, /Send the brochure as a PDF/i);
  });

  it('falls back to the mimetype when the name carries no extension', () => {
    assert.match(unsupportedDocument('brochure', 'application/msword'), /application\/msword file/);
  });

  it('says something usable even with nothing to go on', () => {
    const out = unsupportedDocument(null, null);
    assert.match(out, /Not published/);
    assert.ok(out.length > 40);
  });

  it('is a refusal, never a false promise that it was published', () => {
    const out = unsupportedDocument('plan.dwg', null);
    assert.match(out, /^✋ Not published/);
    assert.equal(/✅/.test(out), false);
  });

  it('keeps an untrusted filename from changing message formatting', () => {
    const out = unsupportedDocument('../*urgent*_[click](https://evil.invalid)\nfile.html', 'text/html');
    assert.equal(out.includes('evil.invalid'), false);
    assert.equal(out.includes('\nfile'), false, 'control characters are collapsed');
    assert.match(out, /file\.html is a \.html file/);
    assert.ok(out.length < 400, 'a filename cannot grow the reply without bound');
  });
});

describe('unsupported document durability', () => {
  it('persists before markSeen and replays the durable job after restart', () => {
    // Entry-point orchestration: assert source order directly, as publish.test.mjs
    // does for pull/write/push. Importing index.mjs would start the WhatsApp daemon.
    const file = fileURLToPath(new URL('../index.mjs', import.meta.url));
    const src = fs.readFileSync(file, 'utf8');
    const anchor = src.indexOf("log.info('msg.document_not_pdf'");
    const start = src.lastIndexOf('if (doc) {', anchor);
    const block = src.slice(start, src.indexOf('const text = textOf(record)', start));
    const persisted = block.indexOf('state.addJob({');
    const seen = block.indexOf('state.markSeen(record.key.id);');
    const queued = block.indexOf("enqueue({ kind: 'unsupported'");
    assert.ok(start >= 0 && persisted >= 0 && seen > persisted && queued > seen,
      'persist first, mark seen second, queue last');
    assert.match(src, /if \(job\.kind === 'unsupported'\)[\s\S]*kind: 'unsupported'/,
      'pending unsupported jobs are rebuilt on startup');
  });

  it('sends before closing the job, so a crash may duplicate but never lose the refusal', () => {
    const file = fileURLToPath(new URL('../index.mjs', import.meta.url));
    const src = fs.readFileSync(file, 'utf8');
    const start = src.indexOf('async function handleUnsupported');
    const block = src.slice(start, src.indexOf('async function handleCommand', start));
    assert.ok(block.indexOf('await sendReply(') >= 0);
    assert.ok(block.indexOf('state.finishJob(') > block.indexOf('await sendReply('));
    assert.match(src, /job\.kind === 'unsupported'\) && jobId\) state\.failJob/,
      'a send failure keeps the durable job retryable');
  });
});
