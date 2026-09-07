#!/usr/bin/env node
// Self-test for src/lib/qr.ts (the dependency-free QR encoder behind the REGA block).
// Usage: node scripts/qr-selftest.mjs        (Node ≥ 22.18: imports the .ts file directly)
// Encodes a listing URL and asserts the structural invariants a scanner relies on: the version chosen for the
// byte count, the module count, the three finder patterns with their separators, the timing patterns, the dark
// module, and format information that decodes back to level M + the chosen mask. Then the version boundaries.
import assert from 'node:assert/strict';
import { encodeQr, qrSvgPath, byteCapacity } from '../src/lib/qr.ts';

// A fixture, deliberately not a real Bona domain: the site's domain lives in site.json and changes, while the
// assertions below depend on this string being exactly 34 bytes.
const url = 'https://example.test/properties/x/';
const qr = encodeQr(url);

// 34 bytes: version 2-M holds 26, version 3-M holds 42.
assert.equal(qr.version, 3, 'version for a 34-byte URL');
assert.equal(qr.size, 29, 'module count = 17 + 4 × version');
assert.equal(qr.modules.length, 29);
for (const row of qr.modules) assert.equal(row.length, 29);

/** The 7×7 finder: dark border, light ring, dark 3×3 core. */
function checkFinder(top, left) {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    const want = d !== 2;
    assert.equal(qr.modules[top + dy][left + dx], want, `finder at (${top},${left}) module (${dy},${dx})`);
  }
}
checkFinder(0, 0);
checkFinder(0, qr.size - 7);
checkFinder(qr.size - 7, 0);

// Separators (light) around each finder.
for (let i = 0; i < 8; i++) {
  assert.equal(qr.modules[7][i], false, 'separator below top-left finder');
  assert.equal(qr.modules[i][7], false, 'separator right of top-left finder');
  assert.equal(qr.modules[7][qr.size - 1 - i], false, 'separator below top-right finder');
  assert.equal(qr.modules[i][qr.size - 8], false, 'separator left of top-right finder');
  assert.equal(qr.modules[qr.size - 8][i], false, 'separator above bottom-left finder');
  assert.equal(qr.modules[qr.size - 1 - i][7], false, 'separator right of bottom-left finder');
}

// Timing patterns between the finders: dark on even positions.
for (let i = 8; i < qr.size - 8; i++) {
  assert.equal(qr.modules[6][i], i % 2 === 0, `row timing at ${i}`);
  assert.equal(qr.modules[i][6], i % 2 === 0, `column timing at ${i}`);
}

// The dark module at (4·version + 9, 8).
assert.equal(qr.modules[4 * qr.version + 9][8], true, 'dark module');

// Format information: read the copy along the top-left finder and compare with the BCH-coded (M, mask).
const bits = [];
for (let i = 0; i <= 5; i++) bits.push(qr.modules[i][8]);
bits.push(qr.modules[7][8], qr.modules[8][8], qr.modules[8][7]);
for (let i = 9; i < 15; i++) bits.push(qr.modules[8][14 - i]);
let value = 0;
for (let i = 0; i < 15; i++) if (bits[i]) value |= 1 << i;
const data = (0b00 << 3) | qr.mask; // level M = 00
let rem = data;
for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
assert.equal(value, ((data << 10) | rem) ^ 0x5412, 'format bits decode to level M + mask');
assert.ok(qr.mask >= 0 && qr.mask <= 7, 'mask in range');

// The SVG path draws every dark module exactly once (sum of horizontal runs = dark count).
const dark = qr.modules.flat().filter(Boolean).length;
const drawn = [...qrSvgPath(qr).matchAll(/h(\d+)v1h-\1z/g)].reduce((n, m) => n + Number(m[1]), 0);
assert.equal(drawn, dark, 'svg path covers each dark module once');

// Version boundaries: the largest payload of each version stays there, one more byte moves up.
const expected = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]; // byte capacity, level M, versions 1–10
for (let v = 1; v <= 10; v++) {
  assert.equal(byteCapacity(v), expected[v - 1], `capacity of version ${v}`);
  assert.equal(encodeQr('a'.repeat(expected[v - 1])).version, v, `${expected[v - 1]} bytes fit version ${v}`);
  if (v < 10) assert.equal(encodeQr('a'.repeat(expected[v - 1] + 1)).version, v + 1, `${expected[v - 1] + 1} bytes need version ${v + 1}`);
}
assert.throws(() => encodeQr('a'.repeat(214)), /exceed/, 'beyond version 10 throws');

// Arabic (multi-byte UTF-8) is counted in bytes, not characters.
assert.equal(encodeQr('بونا').version, 1);

console.log(`qr self-test OK — "${url}" → version ${qr.version}, ${qr.size}×${qr.size} modules, mask ${qr.mask}, ${dark} dark`);
