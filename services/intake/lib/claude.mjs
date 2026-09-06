// The AI step: one `claude -p` call that reads the contact sheets and the PDF text and
// returns the listing contract as JSON.
//
// Flags verified against claude 2.x on this box (2026-09-06):
//   env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude -p
//     --model sonnet --output-format json --allowedTools Read
//     --permission-prompts none --safe-mode --strict-mcp-config
//     --disable-slash-commands --settings <workdir>/claude-settings.json --add-dir <workdir>
//   `--safe-mode` is what makes this reproducible: it drops the owner's CLAUDE.md, skills,
//   plugins, hooks and MCP servers (auth, model and built-in tools still work), so the
//   pipeline sees only this prompt. Measured: 0.036 USD/call vs 0.105 without it.
//   There is NO `--permission-mode bypassPermissions` any more: it granted the model the
//   whole filesystem for no benefit. Measured on this CLI, no permission mode gates Read at
//   all, so confinement comes from the generated deny rules in lib/confine.mjs (--settings),
//   which were verified to turn `Read /etc/hostname` into a refusal while the work dir stays
//   readable. `--permission-prompts none` denies anything that would otherwise prompt, since
//   a daemon has nobody to ask.
//   EVERYTHING the model returns is untrusted text. Only fields that survive
//   validateAiResult() + copyProblems() + checkListing() are ever written or echoed; free
//   text like `warnings` stays in the work dir's ai.json and never reaches the repo or the
//   WhatsApp reply.
//   `--json-schema` exists too but constrains the FINAL message only and is brittle with
//   nested oneOf; we validate the contract ourselves in validateAiResult() instead, and
//   retry once with a repair prompt when the model returns something off-contract.
//   `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` must be unset or the nested CLI refuses to start.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS } from '../../../scripts/curate/rooms.mjs';
import { FORBIDDEN as COPY_FORBIDDEN, HYPE_WORDS as SHARED_HYPE_WORDS } from '../../../scripts/curate/rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_TEMPLATE = path.join(HERE, 'prompt.md');

export const TYPES = ['villa', 'apartment', 'penthouse', 'mansion', 'land', 'building', 'duplex'];
export const CATEGORIES = ['buy', 'rent', 'off-plan', 'international'];
export const CURRENCIES = ['SAR', 'AED', 'EUR', 'USD', 'OMR'];
export const ROOM_KEYS = Object.keys(ROOMS);
// One definition, shared with scripts/curate/validate.mjs (scripts/curate/copy-rules.mjs).
export const HYPE_WORDS = SHARED_HYPE_WORDS;

const DEFAULT_RUBRIC = `A house rubric file (scripts/curate/IMAGE-RUBRIC.md) was not found, so use this default.

Hero (rank 1) — the single frame that sells the property:
  - Wide, sharp, well lit. Landscape (aspect ratio >= 1.4) whenever one exists.
  - The property's strongest asset stated plainly: pool, waterfront, skyline, façade, or the main living volume.
  - Golden hour beats noon; a lit façade at dusk beats a flat daytime shot.
  - Never a floor plan, site plan, map, logo, text page, collage or watermarked frame.
  - No people, no faces, no cars in the foreground, no clutter, no visible branding.
  - For a developer's unit with only renders, use the cleanest exterior or lobby render.
  - For an apartment, prefer the view, then the main living space, then the façade.

Order after the hero — the way a guest walks the home:
  entrance/hall -> living/majlis -> dining/kitchen -> master suite -> further bedrooms ->
  bathrooms -> terrace/balcony/garden -> building amenities -> aerial last.

Set size: aim for 8, never fewer than 4 or more than 10. Drop near-duplicates and keep the
better frame of any pair. Every image gets the room key that actually describes it.

Score each candidate out of 10 before ranking: composition 3, light 2, sharpness 2,
subject value 2, cleanliness (no text/people/clutter) 1.`;

function fillTemplate(tpl, vars) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

/**
 * Everything lifted out of the PDF or typed by whoever sent it is DATA, not instruction.
 * It goes inside a fence, and the fence marker is stripped from the data itself so nothing
 * inside can close it early and start giving orders.
 */
export const FENCE = 'BONA-UNTRUSTED-DATA';
export function fence(label, body) {
  // Replace the marker with something that does NOT contain it — appending to it would
  // still leave `<<<END BONA-UNTRUSTED-DATA…` intact inside the data.
  const clean = String(body ?? '').split(FENCE).join('[fence marker removed]');
  return [
    `<<<${FENCE}: ${label}>>>`,
    clean,
    `<<<END ${FENCE}: ${label}>>>`,
  ].join('\n');
}

/**
 * @param {{extraction:object, sheets:Array<{file:string,from:number,to:number}>, caption:object,
 *          pageImages?:Array<{page:number,abs:string,width:number,height:number}>,
 *          rubricPath?:string}} input
 */
export function buildPrompt({ extraction, sheets, caption, pageImages = [], rubricPath }) {
  let rubric = DEFAULT_RUBRIC;
  if (rubricPath) {
    try { rubric = fs.readFileSync(rubricPath, 'utf8').trim() || DEFAULT_RUBRIC; } catch { /* default */ }
  }
  const captionLines = [];
  const c = caption || {};
  captionLines.push(fence('the caption the owner typed', c.text ? c.text : '(no caption)'));
  if (c.category) captionLines.push(`- The owner says the category is: ${c.category}${c.period ? ` (per ${c.period})` : ''}. Use it.`);
  if (c.price) captionLines.push(`- The owner gave the price explicitly: ${c.price.amount} ${c.price.currency}. Use it, it overrides the PDF.`);
  if (c.dryRun) captionLines.push('- #test: this is a dry run; produce the listing anyway.');
  if (!c.price) captionLines.push('- No price in the caption: use the price printed in the PDF, or onRequest if there is none.');

  const meta = Object.entries(extraction.meta || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '(none)';
  const candidateList = extraction.candidates
    .map((x) => `- #${x.index}  ${x.abs}  (${x.width}x${x.height}, page ${x.page}, ${x.source})`)
    .join('\n') || '(no image candidates were extracted)';
  const pageText = (extraction.pageText || [])
    .map((t, i) => `### page ${i + 1}\n${t || '(no text)'}`)
    .join('\n\n')
    .slice(0, 60000);

  const pageBlock = pageImages.length
    ? [
      `This PDF has **no usable text layer**, so all ${pageImages.length} of its pages were rendered as images.`,
      '**Read every one of them with the Read tool** and take the specs, the price, the district, the',
      'developer and the project name from what is printed on the pages. If a fact is not printed on any',
      'page, it stays `null` — the rendered pages do not license a guess. If, having read them, this is not',
      'one specific property offered for sale or rent, set `reject: true` with a one-sentence reason.',
      '',
      ...pageImages.map((p) => `  - page ${p.page}: ${p.abs}  (${p.width}x${p.height})`),
      '',
      'A price you take from a page image MUST come with `priceEvidence: { "page": <n>, "quote": "<the',
      'exact printed text>" }`. Without it the listing is published as "price on request".',
    ].join('\n')
    : '(the PDF has a readable text layer — it is reproduced below)';

  return fillTemplate(fs.readFileSync(PROMPT_TEMPLATE, 'utf8'), {
    SHEET_COUNT: sheets.length,
    SHEET_LIST: sheets.map((s) => `  - ${s.file}  (candidates #${s.from}–#${s.to})`).join('\n') || '  (none — no image candidates)',
    RUBRIC: rubric,
    ROOM_KEYS: `  ${ROOM_KEYS.join(', ')}`,
    CAPTION: captionLines.join('\n'),
    META: fence('PDF metadata', meta),
    CANDIDATE_LIST: candidateList,
    PAGE_IMAGES: pageBlock,
    PAGE_TEXT: fence('the text layer of the PDF, page by page', pageText),
  });
}

function extractJson(text) {
  const s = String(text ?? '').trim();
  const fenced = /```(?:json|jsonc)?\s*([\s\S]*?)```/.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the model output');
  return JSON.parse(body.slice(start, end + 1));
}

/** Run one `claude -p` and return the parsed contract object. */
export function runClaudeOnce({ prompt, cwd, model, bin = 'claude', addDirs = [], settingsPath = null, timeoutMs = 600000, spawnImpl = spawn }) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--allowedTools', 'Read',
    '--permission-prompts', 'none',
    '--safe-mode',
    '--disable-slash-commands',
    '--strict-mcp-config',
    ...(settingsPath ? ['--settings', settingsPath] : []),
    ...addDirs.flatMap((d) => ['--add-dir', d]),
  ];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude -p timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A failing `claude -p` still prints its JSON envelope, and the useful part is
      // `result` (e.g. "You've hit your session limit"). Parse before giving up so the
      // owner never sees a slice of the middle of a JSON blob.
      let envelope = null;
      try { envelope = JSON.parse(out); } catch { /* not JSON */ }
      if (envelope?.is_error || (code !== 0 && envelope)) {
        const e = new Error(`claude -p failed: ${String(envelope.result ?? 'unknown error').slice(0, 300)}`);
        e.apiErrorStatus = envelope.api_error_status ?? null;
        e.fatal = envelope.api_error_status === 429 || /session limit|usage limit|rate limit/i.test(String(envelope.result ?? ''));
        return reject(e);
      }
      if (code !== 0) return reject(new Error(`claude -p exited ${code}: ${(err || out).trim().slice(-300)}`));
      if (!envelope) return reject(new Error(`claude -p returned non-JSON: ${out.slice(0, 300)}`));
      try {
        resolve({ result: extractJson(envelope.result), meta: { costUsd: envelope.total_cost_usd, durationMs: envelope.duration_ms, numTurns: envelope.num_turns, sessionId: envelope.session_id } });
      } catch (e) {
        reject(new Error(`${e.message}: ${String(envelope.result).slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const ARABIC = /[؀-ۿ]/;
const isPair = (v) => v && typeof v === 'object' && isStr(v.en) && isStr(v.ar) && ARABIC.test(v.ar);
const isNumOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));

/**
 * Contract check for the model's output. Returns the list of problems (empty = good).
 * This is deliberately strict: the pipeline writes to a public website.
 */
export function validateAiResult(result, { candidateCount = 0 } = {}) {
  const e = [];
  if (!result || typeof result !== 'object') return ['output is not an object'];
  if (typeof result.reject !== 'boolean') e.push('reject must be a boolean');
  if (result.reject) {
    if (!isStr(result.rejectReason)) e.push('rejectReason is required when reject is true');
    return e;
  }
  const l = result.listing;
  if (!l || typeof l !== 'object') return ['listing is required when reject is false'];
  if (!isPair(l.title)) e.push('listing.title.en/ar required (ar must be Arabic script)');
  if (!TYPES.includes(l.type)) e.push(`listing.type must be one of ${TYPES.join('|')}`);
  if (!CATEGORIES.includes(l.category)) e.push(`listing.category must be one of ${CATEGORIES.join('|')}`);
  const loc = l.location || {};
  for (const k of ['district', 'city', 'country']) if (!isPair(loc[k])) e.push(`listing.location.${k}.en/ar required`);
  if (!/^[A-Z]{2}$/.test(loc.countryCode || '')) e.push('listing.location.countryCode must be ISO-2');

  const p = l.price || {};
  if (!CURRENCIES.includes(p.currency)) e.push(`listing.price.currency must be one of ${CURRENCIES.join('|')}`);
  if (typeof p.onRequest !== 'boolean') e.push('listing.price.onRequest must be boolean');
  if (typeof p.from !== 'boolean') e.push('listing.price.from must be boolean');
  if (!isNumOrNull(p.amount)) e.push('listing.price.amount must be a number or null');
  if (!p.onRequest && !(typeof p.amount === 'number' && p.amount > 0)) e.push('listing.price: amount must be > 0 unless onRequest is true');
  if (![null, undefined, 'year', 'month'].includes(p.period)) e.push('listing.price.period must be null, "year" or "month"');
  if (l.category === 'rent' && !p.period && !p.onRequest) e.push('rent listings need price.period');

  const s = l.specs || {};
  for (const k of ['beds', 'baths', 'areaSqm', 'plotSqm', 'yearBuilt', 'floors']) {
    if (!isNumOrNull(s[k] ?? null)) e.push(`listing.specs.${k} must be a number or null`);
  }
  for (const lang of ['en', 'ar']) {
    const d = l.description?.[lang];
    if (!Array.isArray(d) || d.length < 2 || !d.every(isStr)) e.push(`listing.description.${lang} must be an array of >= 2 non-empty paragraphs`);
    else if (lang === 'ar' && !d.every((x) => ARABIC.test(x))) e.push('listing.description.ar must be Arabic script');
    const h = l.highlights?.[lang];
    if (!Array.isArray(h) || h.length < 4 || h.length > 6 || !h.every(isStr)) e.push(`listing.highlights.${lang} needs 4–6 non-empty items`);
    else if (lang === 'ar' && !h.every((x) => ARABIC.test(x))) e.push('listing.highlights.ar must be Arabic script');
  }
  if (Array.isArray(l.highlights?.en) && Array.isArray(l.highlights?.ar) && l.highlights.en.length !== l.highlights.ar.length) {
    e.push('listing.highlights.en and .ar must have the same length');
  }
  if (l.project !== null && l.project !== undefined && !(isPair(l.project?.name) && isPair(l.project?.developer))) {
    e.push('listing.project must be null or { name:{en,ar}, developer:{en,ar} }');
  }

  if (!Array.isArray(result.images)) e.push('images must be an array');
  else {
    const seen = new Set();
    let heroes = 0;
    for (const im of result.images) {
      if (!Number.isInteger(im?.index) || im.index < 0 || (candidateCount && im.index >= candidateCount)) e.push(`images: bad index ${im?.index}`);
      else if (seen.has(im.index)) e.push(`images: duplicate index ${im.index}`);
      else seen.add(im.index);
      if (!ROOM_KEYS.includes(im?.room) && !im?.exclude) e.push(`images[#${im?.index}]: unknown room key "${im?.room}"`);
      if (im?.hero) heroes += 1;
    }
    if (heroes > 1) e.push('images: more than one hero');
    const kept = result.images.filter((im) => !im.exclude);
    if (kept.length) {
      const top = kept.slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
      if (heroes === 1 && !top.hero) e.push('images: the hero must be the image ranked 1');
    }
  }
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) e.push('confidence must be a number between 0 and 1');
  // Optional, and only meaningful for a PDF with no text layer. Shape-checked here; whether
  // the evidence is TRUE is decided by pipeline.mjs, which looks at the page itself.
  const ev = result.priceEvidence;
  if (ev !== null && ev !== undefined) {
    if (!(typeof ev === 'object' && Number.isInteger(ev.page) && ev.page >= 1 && isStr(ev.quote))) {
      e.push('priceEvidence must be null or { page: <1-based page number>, quote: "<printed text>" }');
    }
  }
  return e;
}

/**
 * Second opinion on ONE page render: is the price the model claimed actually printed there?
 * Used only for brochures with no text layer, where nothing local can corroborate a number
 * and TAQEEM says we may not publish one we cannot see.
 * @returns {Promise<{confirmed:boolean, error?:string}>}
 */
export async function confirmPriceEvidence({
  pageImage, amount, currency, quote, bin = 'claude', model = 'sonnet', cwd,
  addDirs = [], settingsPath = null, timeoutMs = 300000, spawnImpl = spawn,
}) {
  const prompt = [
    'Read the image file below with the Read tool. It is one page of a property brochure.',
    '',
    `  ${pageImage}`,
    '',
    `Question: does that page VISIBLY PRINT the price ${amount} ${currency} for the property?`,
    'A number you have to compute, infer or assume does not count. A price for a different unit',
    'on the same page does not count unless the page makes clear it is this property\'s price.',
    '',
    fence('what the first pass claimed it saw', quote ?? '(nothing quoted)'),
    '',
    'Answer with one JSON object and nothing else: {"confirmed": true|false}',
  ].join('\n');
  try {
    const { result } = await runClaudeOnce({ prompt, cwd, model, bin, addDirs, settingsPath, timeoutMs, spawnImpl });
    return { confirmed: result?.confirmed === true };
  } catch (err) {
    return { confirmed: false, error: err.message };
  }
}

/** Copy hygiene: no other agency's brand, no phone numbers, no hype. */
export function copyProblems(listing) {
  const bad = [];
  const FORBIDDEN = [...COPY_FORBIDDEN, /\bwhatsapp\b/i];
  const fields = [
    ['title.en', listing?.title?.en], ['title.ar', listing?.title?.ar],
    ['project.name.en', listing?.project?.name?.en], ['project.name.ar', listing?.project?.name?.ar],
    ...(listing?.description?.en || []).map((x, i) => [`description.en[${i}]`, x]),
    ...(listing?.description?.ar || []).map((x, i) => [`description.ar[${i}]`, x]),
    ...(listing?.highlights?.en || []).map((x, i) => [`highlights.en[${i}]`, x]),
    ...(listing?.highlights?.ar || []).map((x, i) => [`highlights.ar[${i}]`, x]),
  ];
  for (const [label, value] of fields) {
    if (!isStr(value)) continue;
    for (const re of FORBIDDEN) if (re.test(value)) bad.push(`${label} mentions "${value.match(re)[0]}"`);
    for (const w of HYPE_WORDS) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value)) bad.push(`${label} uses hype word "${w}"`);
  }
  return bad;
}

/** Run the AI step with one repair retry, then one model fallback. */
export async function runListingAi({ prompt, cwd, model, fallbackModel, bin, addDirs, settingsPath, timeoutMs, candidateCount, spawnImpl, logger }) {
  const attempts = [];
  const models = fallbackModel && fallbackModel !== model ? [model, model, fallbackModel] : [model, model];
  let lastErr;
  for (const [i, m] of models.entries()) {
    const text = i === 0
      ? prompt
      : `${prompt}\n\n---\nYour previous answer was rejected. Fix EXACTLY these problems and answer again with the complete JSON object only:\n${attempts[attempts.length - 1].join('\n')}`;
    try {
      const { result, meta } = await runClaudeOnce({ prompt: text, cwd, model: m, bin, addDirs, settingsPath, timeoutMs, spawnImpl });
      const problems = validateAiResult(result, { candidateCount });
      if (!result.reject) problems.push(...copyProblems(result.listing));
      if (!problems.length) return { result, meta, attempt: i + 1 };
      attempts.push(problems);
      logger?.warn('ai.contract_failed', { attempt: i + 1, model: m, problems });
      lastErr = new Error(`model output failed the contract: ${problems.join('; ')}`);
    } catch (err) {
      attempts.push([err.message]);
      logger?.warn('ai.call_failed', { attempt: i + 1, model: m, error: err.message });
      lastErr = err;
      // A quota/session limit will not clear in the next second — stop burning attempts
      // and let the caller tell the owner to try again later.
      if (err.fatal) throw err;
    }
  }
  throw lastErr;
}
