/* A small QR Code encoder, written from the ISO/IEC 18004 tables. No dependency.

   Scope, on purpose: byte mode only (UTF-8), error-correction level M, versions 1–10 (up to 213 bytes — a listing
   URL is ~45), automatic mask selection by the standard's four penalty rules. Output is a module matrix plus an
   SVG path, which RegaBlock.astro renders inline at build time so a REGA advertisement carries a scannable link
   to its own page. Self-test: `node scripts/qr-selftest.mjs` (Node ≥ 22.18 imports this file directly).

   Only erasable TypeScript syntax is used (no enums, no parameter properties) so Node can strip the types. */

export interface QrCode {
  /** 1–10 */
  version: number;
  /** Modules per side (17 + 4 × version). */
  size: number;
  /** modules[row][col] — true is dark. */
  modules: boolean[][];
  /** Mask pattern 0–7 that was applied. */
  mask: number;
}

/* ---- Tables (error-correction level M) ------------------------------------------------------------- */

/** Per version: EC codewords per block, then the blocks as [count, dataCodewords] groups. */
const EC_M: [number, [number, number][]][] = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

/** Alignment pattern centre coordinates per version (none for version 1). */
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const MAX_VERSION = 10;
const EC_LEVEL_M_BITS = 0b00; // L=01 M=00 Q=11 H=10
const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

function dataCodewords(version: number): number {
  return EC_M[version - 1][1].reduce((n, [count, len]) => n + count * len, 0);
}
function countBits(version: number): number { return version < 10 ? 8 : 16; }
/** Bytes that fit in a version (mode indicator + count indicator taken off the data codewords). */
export function byteCapacity(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

/* ---- GF(256) and Reed–Solomon ---------------------------------------------------------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a: number, b: number): number { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }

/** Generator polynomial for `degree` EC codewords: Π (x − α^i), i = 0..degree−1. Highest power first. */
function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Remainder of data · x^degree divided by the generator — the EC codewords for one block. */
function rsRemainder(data: number[], gen: number[]): number[] {
  const degree = gen.length - 1;
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < degree; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

/* ---- Bit stream -------------------------------------------------------------------------------------- */

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Byte-mode segment + terminator + pad codewords → exactly the version's data codewords. */
function buildCodewords(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));        // terminator
  while (bits.length % 8 !== 0) bits.push(0);           // byte align
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8); // 0xEC, 0x11, 0xEC …
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  return out;
}

/** Split into blocks, append EC per block, interleave (data columns first, then EC columns). */
function interleave(codewords: number[], version: number): number[] {
  const [ecLen, groups] = EC_M[version - 1];
  const gen = rsGenerator(ecLen);
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(at, at + len);
      at += len;
      dataBlocks.push(block);
      ecBlocks.push(rsRemainder(block, gen));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

/* ---- Matrix ------------------------------------------------------------------------------------------ */

class Matrix {
  size: number;
  modules: boolean[][];
  isFunction: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  setFunction(col: number, row: number, dark: boolean) {
    this.modules[row][col] = dark;
    this.isFunction[row][col] = true;
  }

  drawFinder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy)); // Chebyshev distance: rings
      this.setFunction(x, y, d !== 2 && d !== 4);     // dark 3×3 core, light ring, dark ring, light separator
    }
  }

  drawAlignment(cx: number, cy: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFunctionPatterns(version: number) {
    const n = this.size;
    // Timing patterns (row 6 and column 6): dark on even positions.
    for (let i = 0; i < n; i++) { this.setFunction(6, i, i % 2 === 0); this.setFunction(i, 6, i % 2 === 0); }
    // Finders with separators.
    this.drawFinder(3, 3); this.drawFinder(n - 4, 3); this.drawFinder(3, n - 4);
    // Alignment patterns, skipping the three that would overlap a finder.
    const pos = ALIGN[version - 1];
    const last = pos.length - 1;
    for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      this.drawAlignment(pos[i], pos[j]);
    }
    // Reserve the format areas (written for real once the mask is chosen) and the dark module.
    this.drawFormat(0);
    this.drawVersion(version);
  }

  /** 15 format bits: EC level + mask, BCH(15,5), masked with 0x5412. Two copies. */
  drawFormat(mask: number) {
    const data = (EC_LEVEL_M_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, n - 15 + i, bit(i));
    this.setFunction(8, n - 8, true); // the dark module
  }

  /** 18 version bits (versions 7+): version + BCH(18,6). Two copies, top-right and bottom-left. */
  drawVersion(version: number) {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3), b = Math.floor(i / 3);
      this.setFunction(a, b, bit);
      this.setFunction(b, a, bit);
    }
  }

  /** Codewords into the free modules: two-column strips from the right, zig-zagging up and down, column 6 skipped. */
  drawCodewords(data: number[]) {
    const n = this.size;
    let i = 0;
    const total = data.length * 8;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (this.isFunction[y][x]) continue;
          if (i < total) this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++; // remainder bits (versions 2–6) stay light
        }
      }
    }
  }

  applyMask(mask: number) {
    const n = this.size;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (this.isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) this.modules[y][x] = !this.modules[y][x];
    }
  }

  /** The standard's four penalty rules (lower is better). */
  penalty(): number {
    const n = this.size, m = this.modules;
    let score = 0;
    const line = (get: (i: number) => boolean) => {
      // Rule 1: runs of five or more same-coloured modules.
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) score += PENALTY.N1 + run - 5;
        run = 1;
      }
      // Rule 3: finder-like 1:1:3:1:1 pattern with four light modules on one side.
      const bits: number[] = [];
      for (let i = 0; i < n; i++) bits.push(get(i) ? 1 : 0);
      const s = bits.join('');
      for (let i = 0; i + 11 <= n; i++) {
        const w = s.slice(i, i + 11);
        if (w === '10111010000' || w === '00001011101') score += PENALTY.N3;
      }
    };
    for (let y = 0; y < n; y++) line(x => m[y][x]);
    for (let x = 0; x < n; x++) line(y => m[y][x]);
    // Rule 2: 2×2 blocks of one colour.
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += PENALTY.N2;
    }
    // Rule 4: deviation of the dark proportion from 50%, in 5% steps.
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    score += Math.max(0, k) * PENALTY.N4;
    return score;
  }
}

/* ---- Public API -------------------------------------------------------------------------------------- */

/** Encodes `text` (UTF-8, byte mode, EC level M) into the smallest version 1–10 that fits, best mask by penalty. */
export function encodeQr(text: string): QrCode {
  const bytes = utf8(text);
  let version = 1;
  while (version <= MAX_VERSION && byteCapacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) throw new Error(`qr: ${bytes.length} bytes exceed version ${MAX_VERSION}-M (${byteCapacity(MAX_VERSION)} bytes)`);

  const codewords = interleave(buildCodewords(bytes, version), version);
  const size = 17 + 4 * version;
  const base = new Matrix(size);
  base.drawFunctionPatterns(version);
  base.drawCodewords(codewords);

  let best: Matrix | null = null, bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(size);
    m.modules = base.modules.map(r => r.slice());
    m.isFunction = base.isFunction;
    m.applyMask(mask);
    m.drawFormat(mask);
    const score = m.penalty();
    if (score < bestScore) { best = m; bestMask = mask; bestScore = score; }
  }
  return { version, size, modules: best!.modules, mask: bestMask };
}

/** SVG path data for the dark modules, one unit per module, offset by `quiet` (horizontal runs merged). */
export function qrSvgPath(qr: QrCode, quiet = 0): string {
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.modules[y][x]) { x++; continue; }
      let run = 1;
      while (x + run < qr.size && qr.modules[y][x + run]) run++;
      parts.push(`M${x + quiet} ${y + quiet}h${run}v1h-${run}z`);
      x += run;
    }
  }
  return parts.join('');
}

/** A complete inline SVG (crisp edges, `quiet` modules of margin — the spec asks for 4). */
export function qrSvg(qr: QrCode, opts: { size?: number; quiet?: number; fg?: string; bg?: string; title?: string } = {}): string {
  const quiet = opts.quiet ?? 4;
  const n = qr.size + quiet * 2;
  const px = opts.size ?? 96;
  const title = opts.title ? `<title>${opts.title.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string)}</title>` : '';
  const bg = opts.bg ? `<rect width="${n}" height="${n}" fill="${opts.bg}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img">${title}${bg}<path fill="${opts.fg ?? '#000'}" d="${qrSvgPath(qr, quiet)}"/></svg>`;
}
