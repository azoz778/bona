import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unsupportedDocument } from '../lib/messages.mjs';

describe('unsupportedDocument', () => {
  it('names the file and the extension it actually got', () => {
    const out = unsupportedDocument('Durrat_Al_Basateen_TK_Estates-3.html', 'text/html');
    assert.match(out, /Durrat_Al_Basateen_TK_Estates-3\.html/);
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
});
