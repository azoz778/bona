// Fontconfig bootstrap for the social renderer.
//
// Why this file exists at all: ffmpeg's `drawtext` does not shape or join Arabic — it draws
// isolated letterforms left to right, which is unreadable. sharp is built against Pango
// (1.58) + HarfBuzz (14.3) + FriBidi (1.0.16), so `sharp({ text: ... })` DOES shape and
// reorder Arabic correctly. Every piece of Arabic in a reel/carousel/story is therefore
// rendered to a transparent PNG here and composited/overlaid; ffmpeg only ever moves pixels.
//
// The brand faces ship as .woff2 in public/fonts (the website loads them). Pango reads a
// fontconfig font set, not woff2 blobs, so scripts/social/fonts/ holds the same six faces as
// plain .ttf with corrected name records (Google's static instances call themselves
// "Montserrat Thin SemiBold", which fontconfig then matches badly). See fonts/README.md for
// provenance and the exact conversion.
//
// FONTCONFIG_FILE is set here, at module load, and this module imports nothing heavy — keep
// `import './lib/fonts.mjs'` (or a module that does) FIRST in every entry point so it runs
// before libvips ever touches Pango.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOCIAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SOCIAL_DIR, '../..');
export const FONT_DIR = path.join(SOCIAL_DIR, 'fonts');

/** Pango family names — the corrected nameID 1 of the files in scripts/social/fonts. */
export const FONTS = {
  /** Arabic display: Amiri Bold. Naskh, high contrast, the site's Arabic headline face. */
  arDisplay: 'Amiri',
  arDisplayWeight: 'Bold',
  /** Arabic text: IBM Plex Sans Arabic. Reads at small sizes; carries Arabic-Indic digits. */
  arBody: 'IBM Plex Sans Arabic',
  /** Latin display: Cormorant Garamond SemiBold. The wordmark and English headlines. */
  enDisplay: 'Cormorant Garamond',
  enDisplayWeight: 'SemiBold',
  /** Latin text: Montserrat. Also the fallback that supplies Western digits to Arabic runs —
   *  neither Amiri nor Plex Arabic carries U+0030..0039 (they only have Arabic-Indic). */
  enBody: 'Montserrat',
};

/** Family list handed to Pango so a run of Western digits inside Arabic finds a face. */
export const AR_STACK = `${FONTS.arDisplay},${FONTS.arBody},${FONTS.enBody}`;
export const AR_BODY_STACK = `${FONTS.arBody},${FONTS.enBody}`;
export const EN_STACK = `${FONTS.enDisplay},${FONTS.enBody}`;

const REQUIRED = [
  'Amiri-Bold.ttf',
  'IBMPlexSansArabic-Regular.ttf',
  'IBMPlexSansArabic-Medium.ttf',
  'CormorantGaramond-SemiBold.ttf',
  'Montserrat-Regular.ttf',
  'Montserrat-SemiBold.ttf',
];

function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  try {
    fs.mkdirSync(path.join(base, 'bona-social'), { recursive: true });
    return path.join(base, 'bona-social');
  } catch {
    const tmp = path.join(os.tmpdir(), 'bona-social');
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

let configured = null;

/**
 * Point fontconfig at scripts/social/fonts (plus the system dirs, so Pango still has a
 * fallback for anything the six brand faces do not cover). Idempotent; safe to call often.
 * @returns {{confFile:string, fontDir:string, missing:string[]}}
 */
export function ensureFontConfig() {
  if (configured) return configured;
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(FONT_DIR, f)));
  const cache = cacheRoot();
  const fcCache = path.join(cache, 'fontconfig');
  fs.mkdirSync(fcCache, { recursive: true });
  const systemDirs = ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'), path.join(os.homedir(), '.local/share/fonts')];
  const dirs = [FONT_DIR, ...systemDirs.filter((d) => fs.existsSync(d))];
  const conf =
    '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n' +
    dirs.map((d) => `  <dir>${d}</dir>`).join('\n') +
    `\n  <cachedir>${path.join(fcCache, 'cache')}</cachedir>\n` +
    // Never let fontconfig substitute a face silently when a family is missing: we want the
    // brand faces or a loud fallback, not a surprise.
    '  <match target="pattern"><test name="family"><string>serif</string></test>' +
    `<edit name="family" mode="prepend" binding="strong"><string>${FONTS.enDisplay}</string></edit></match>\n` +
    '  <match target="pattern"><test name="family"><string>sans-serif</string></test>' +
    `<edit name="family" mode="prepend" binding="strong"><string>${FONTS.enBody}</string></edit></match>\n` +
    '</fontconfig>\n';
  const confFile = path.join(fcCache, 'fonts.conf');
  const previous = fs.existsSync(confFile) ? fs.readFileSync(confFile, 'utf8') : null;
  if (previous !== conf) fs.writeFileSync(confFile, conf);
  process.env.FONTCONFIG_FILE = confFile;
  process.env.FONTCONFIG_PATH = fcCache;
  configured = { confFile, fontDir: FONT_DIR, missing };
  return configured;
}

ensureFontConfig();
