// Page adapters for TikTok Studio and the LinkedIn Page admin, over lib/cdp.mjs sessions.
// Every selector the publisher relies on is in SELECTORS, so a site redesign is one edit here
// (docs/browser-publishing.md lists them and what each one is for).
import { BrowserError, sleep } from './cdp.mjs';

export const URLS = Object.freeze({
  tiktokProfile: handle => `https://www.tiktok.com/@${handle}`,
  tiktokUpload: 'https://www.tiktok.com/tiktokstudio/upload',
  tiktokContent: 'https://www.tiktok.com/tiktokstudio/content',
  linkedinPosts: id => `https://www.linkedin.com/company/${id}/admin/page-posts/published/`,
  linkedinPublic: id => `https://www.linkedin.com/company/${id}/posts/`,
});
export const SELECTORS = Object.freeze({
  tiktok: Object.freeze({
    ownProfile: '[data-e2e="edit-profile-entrance"]',
    profileTitle: '[data-e2e="user-title"]',
    fileInput: 'input[type="file"][accept*="video"]',
    uploadStatus: '[data-e2e="upload_status_container"]',
    caption: '[data-e2e="caption_container"] [contenteditable="true"]',
    post: '[data-e2e="post_video_button"]',
    discard: '[data-e2e="discard_post_button"]',
    dialogButton: '[role="dialog"] button',
    // Popups the upload page throws up after an upload; only buttons inside these are ever dismissed.
    popupButton: '[role="dialog"] button, [class*="popover" i] button, [class*="tooltip" i] button',
    gridItem: '[data-e2e="user-post-item"]',
    videoDesc: '[data-e2e="browse-video-desc"], [data-e2e="video-desc"]',
    captcha: '#captcha-verify-container, .captcha-verify-container, #captcha_container, [class*="captcha_verify"], [id*="secsdk-captcha"], iframe[src*="captcha"]',
  }),
  linkedin: Object.freeze({
    startPost: 'main button',            // the one whose text is "Start a post"
    modal: '.share-box-v2__modal',
    actor: '.share-box-v2__modal .share-unified-settings-entry-button',
    addMedia: '.share-box-v2__modal button[aria-label="Add media"]',
    mediaInput: '#media-editor-file-selector__file-input',
    editor: '.share-box-v2__modal .ql-editor',
    post: '.share-box-v2__modal .share-actions__primary-action',
    dismiss: '.share-box-v2__modal button[aria-label="Dismiss"]',
    confirm: '.artdeco-modal--layer-confirmation button',
    commentary: '.update-components-text, .feed-shared-update-v2__commentary, .feed-shared-inline-show-more-text, [data-test-id="main-feed-activity-card__commentary"]',
    toastLink: '.artdeco-toast-item a[href*="/feed/update/"], [data-test-artdeco-toast-item] a[href*="/feed/update/"]',
  }),
});

const q = s => JSON.stringify(s);
const byText = (sel, text) => `[...document.querySelectorAll(${q(sel)})].find(b => b.offsetParent !== null && (b.innerText || '').trim() === ${q(text)})`;
const norm = s => String(s ?? '').replace(/[\s‎‏⁦-⁩]+/g, ' ').trim();

/** Not logged in / captcha / verification — the run cannot go on and a human has to look. */
export async function tiktokBlocker(s) {
  const url = String(await s.url());
  if (/\/login(\/|\?|$)/.test(url)) return new BrowserError('not-logged-in', `TikTok is not logged in (redirected to ${url.split('?')[0]})`);
  if (await s.ev(`!!document.querySelector(${q(SELECTORS.tiktok.captcha)})`)) return new BrowserError('captcha', 'TikTok is showing a captcha / verification puzzle');
  return null;
}
export async function linkedinBlocker(s) {
  const url = String(await s.url());
  if (/linkedin\.com\/(login|uas\/login|authwall|signup)/.test(url)) return new BrowserError('not-logged-in', 'LinkedIn is not logged in');
  if (/linkedin\.com\/checkpoint\//.test(url)) return new BrowserError('verification', 'LinkedIn is asking for a security verification (checkpoint)');
  const t = String(await s.ev('(document.body?.innerText || "").slice(0, 3000)'));
  if (/quick security check|let.s do a quick|verify you.re human/i.test(t)) return new BrowserError('captcha', 'LinkedIn is showing a security check');
  return null;
}
async function stop(s, check) { const b = await check(s); if (b) throw b; }
/** Marks an error raised before any click reached the Post button: provably nothing was sent. */
const notClicked = e => Object.assign(e, { beforeClick: true });

// ------------------------------------------------------------------------ confirmation binding
/**
 * A post's text as compared for binding: bidi marks and emoji removed, "hashtag#tag" (LinkedIn's
 * hashtag-link text) back to "#tag", a trailing "…more"/"see more" control dropped, whitespace
 * collapsed. Nothing is truncated.
 */
export function bindText(x) {
  return norm(String(x ?? '').replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').replace(/\bhashtag\s*#/gi, '#')
    .replace(/(?:…|\.\.\.)?\s*(?:see more|more|المزيد)\s*$/i, ''));
}
const newer = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
/**
 * The post that is ours: a key that was not in the baseline AND whose OWN text (the post's text
 * node, not quoted posts or comments) contains the FULL submitted caption, normalised by
 * bindText() only, AND the submission's evidence string (the listing id, or the education topic
 * line). A new key without that (a promo, a reshare, a processing video) is not proof. `prefer`
 * (the success toast's key) is taken first, but only when it qualifies the same way.
 */
export function bindNewPost(candidates, before, { caption, evidence }, { prefer = null } = {}) {
  const want = bindText(caption), must = bindText(evidence);
  if (!want || !must) return null;
  const seen = new Set(before);
  const ok = candidates.filter(c => !seen.has(c.key) && bindText(c.text).includes(want) && bindText(c.text).includes(must));
  if (!ok.length) return null;
  if (prefer && ok.some(c => c.key === prefer)) return prefer;
  return ok.map(c => c.key).sort(newer).at(-1);
}

// ---------------------------------------------------------------------------------- TikTok
/** Video ids linked from the current page (profile grid / Studio list). */
export const tiktokVideoIds = (s, handle) => s.ev(`[...new Set([...document.documentElement.innerHTML.matchAll(/@${handle}\\/video\\/(\\d{8,25})/g)].map(m => m[1]))]`);
/** Loaded = the grid rendered items; empty = TikTok's explicit empty state (both of its lines). Anything else is still loading. */
export const profileSettled = `document.querySelectorAll(${q(SELECTORS.tiktok.gridItem)}).length > 0 || (() => { const t = document.querySelector('main, #main-content-others_homepage, body')?.innerText || ''; return /Upload your first video/.test(t) && /Your videos will appear here/.test(t); })()`;
export const studioSettled = `document.querySelectorAll('a[href*="/video/"]').length > 0 || (() => { const t = document.body?.innerText || ''; return /No posts yet/.test(t) && /Your posted and scheduled videos will appear here/.test(t); })()`;
/** The logged-in TikTok account, from TikTok's own session endpoint (same origin, the page's cookies). */
export async function tiktokAccount(s) {
  return s.ev(`fetch('/passport/web/account/info/?aid=1988', { credentials: 'include' }).then(r => r.json()).then(j => j?.data?.username ?? null).catch(() => null)`);
}
async function assertTiktokAccount(s, handle) {
  const who = await tiktokAccount(s);
  if (who !== handle) throw notClicked(new BrowserError('wrong-account', `TikTok session is ${who ? `@${who}` : 'not readable'}, not @${handle}`));
}
/**
 * Proves the session is the Bona account and returns the baseline: every video id on the profile
 * grid AND the Studio content list, each read only after that page has settled. Throws (before any
 * upload) if either cannot be read, because a baseline taken too early makes an old post look new.
 */
export async function tiktokSession(s, handle, { settleMs = 1500 } = {}) {
  await s.navigate(URLS.tiktokProfile(handle));
  await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.profileTitle)}) || /\\/login/.test(location.href)`, 20_000);
  await stop(s, tiktokBlocker);
  const own = await s.waitFor(`!!document.querySelector(${q(SELECTORS.tiktok.ownProfile)})`, 10_000);
  if (!own) throw new BrowserError('not-logged-in', `The browser is not logged in to TikTok as @${handle} (no "Edit profile" on the profile page)`);
  await assertTiktokAccount(s, handle);
  if (!await s.waitFor(profileSettled, 20_000)) throw new BrowserError('baseline', 'TikTok profile video grid did not load');
  await sleep(settleMs);
  const fromProfile = await tiktokVideoIds(s, handle);
  await s.navigate(URLS.tiktokContent);
  if (!await s.waitFor(studioSettled, 25_000)) throw new BrowserError('baseline', 'TikTok Studio content list did not load');
  await sleep(settleMs);
  const fromStudio = await tiktokVideoIds(s, handle);
  return [...new Set([...fromProfile, ...fromStudio])];
}
export async function tiktokDismissPopups(s) {
  // "Turn on automatic content checks?" → Cancel; "New editing features added" → Got it. Only inside a dialog/popover.
  for (const label of ['Cancel', 'Got it', 'Not now']) await s.clickEl(byText(SELECTORS.tiktok.popupButton, label));
}
/** Upload the reel and type the caption. Returns what the caption box holds afterwards. */
export async function tiktokFill(s, winFile, caption, { uploadTimeoutMs = 10 * 60_000 } = {}) {
  await s.navigate(URLS.tiktokUpload);
  await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.fileInput)}) || /\\/login/.test(location.href)`, 30_000);
  await stop(s, tiktokBlocker);
  // "A video you were editing wasn't saved. Continue editing?" — a draft left by an interrupted
  // run (the channel lock keeps a live run from being in flight now). Never continue it: discard.
  if (await s.ev(`/wasn.t saved/i.test(document.body?.innerText || '')`)) {
    await s.clickEl(byText('button', 'Discard'));
    await sleep(1200);
    await s.clickEl(byText(SELECTORS.tiktok.dialogButton, 'Discard'));
    await sleep(1500);
    await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.fileInput)})`, 15_000);
  }
  if (!await s.setFiles(`document.querySelector(${q(SELECTORS.tiktok.fileInput)})`, [winFile])) throw new BrowserError('page-changed', 'TikTok upload page has no video file input');
  const uploaded = await s.waitFor(`(() => { const e = document.querySelector(${q(SELECTORS.tiktok.uploadStatus)}); return e && /Uploaded/i.test(e.innerText) && !!document.querySelector(${q(SELECTORS.tiktok.caption)}); })()`, uploadTimeoutMs, 1500);
  await stop(s, tiktokBlocker);
  if (!uploaded) throw new BrowserError('upload-timeout', 'TikTok did not finish the upload in time');
  // The popups arrive a few seconds after the upload and steal focus mid-typing; clear them, retype if they cut in.
  for (let attempt = 1; ; attempt++) {
    await sleep(3000);
    await tiktokDismissPopups(s);
    // Later attempts type slower: a busy Draft.js editor (link detection, the post-upload content check) can drop fast input.
    if (!await s.typeInto(`document.querySelector(${q(SELECTORS.tiktok.caption)})`, caption, { lineDelayMs: (attempt - 1) * 250 })) throw new BrowserError('page-changed', 'TikTok caption editor not found');
    await sleep(1200);
    await s.key('Escape', 'Escape', 27); // close a hashtag suggestion list if one is open
    await tiktokDismissPopups(s);
    const held = await s.ev(`document.querySelector(${q(SELECTORS.tiktok.caption)}).innerText`);
    try { checkCaptionHeld(held, caption); return held; } catch (e) { if (attempt >= 3) throw e; }
  }
}
/** The editor must hold the caption: same text once whitespace is normalised (editors add blank blocks). */
export function checkCaptionHeld(held, caption) {
  if (norm(held) !== norm(caption)) throw new BrowserError('caption-mismatch', `Caption box does not hold the caption (have ${norm(held).length} chars, want ${norm(caption).length})`);
}
/** The same check right before Post: a mismatch there means nothing was clicked. */
const assertHeldBeforeClick = (held, caption) => { try { checkCaptionHeld(held, caption); } catch (e) { throw notClicked(e); } };
/** The checks made immediately before the Post click (also run by a dry run, which then discards). */
export async function tiktokPreClick(s, { handle, caption } = {}) {
  if (handle) await assertTiktokAccount(s, handle);
  if (caption != null) assertHeldBeforeClick(await s.ev(`document.querySelector(${q(SELECTORS.tiktok.caption)})?.innerText || ''`), caption);
}
/**
 * Press Post — once. If TikTok answers with its "Post now" confirmation (content check still
 * running), that button is the one that publishes, and it too is pressed at most once. Neither is
 * ever pressed again: from here the outcome is confirmed or recorded uncertain, never retried.
 */
export async function tiktokPost(s, { handle, caption, polls = 20, every = 1500 } = {}) {
  const ready = await s.waitFor(`(() => { const b = document.querySelector(${q(SELECTORS.tiktok.post)}); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`, 60_000);
  if (!ready) throw notClicked(new BrowserError('post-disabled', 'TikTok Post button stayed disabled'));
  // After the last wait, immediately before the one click: still our account, still our caption.
  await tiktokPreClick(s, { handle, caption });
  const clicked = await s.clickEl(`document.querySelector(${q(SELECTORS.tiktok.post)})`);
  if (!clicked) throw notClicked(new BrowserError('page-changed', 'TikTok Post button vanished'));
  let postNow = false;
  for (let i = 0; i < polls; i++) {
    await sleep(every);
    if (!postNow && await s.clickEl(byText(SELECTORS.tiktok.dialogButton, 'Post now'))) { postNow = true; continue; }
    const url = String(await s.url());
    if (/tiktokstudio\/content/.test(url)) return postNow ? 'post-now-then-content' : 'redirected-to-content';
    const t = String(await s.ev('(document.body?.innerText || "").slice(0, 4000)'));
    if (/Your video (has been|is being) (uploaded|posted)|Video posted|Manage your posts/i.test(t)) return 'posted-message';
  }
  return postNow ? 'post-now-no-signal' : 'no-signal';
}
/** One video's own page: the video's own description element only (never comments, never truncated meta tags). */
async function tiktokVideoText(s, handle, id) {
  await s.navigate(`https://www.tiktok.com/@${handle}/video/${id}`);
  await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.videoDesc)})`, 15_000);
  return s.ev(`([...document.querySelectorAll(${q(SELECTORS.tiktok.videoDesc)})].find(e => !e.closest('[data-e2e*="comment"], [class*="Comment"]'))?.innerText) || ''`);
}
/** Poll the profile and Studio for a new video id whose own page shows the caption head. URL or null. */
export async function tiktokConfirm(s, handle, before, { caption = '', evidence = '', timeoutMs = 6 * 60_000, every = 20_000, settleMs = 2000 } = {}) {
  const t0 = Date.now(), checked = new Map();
  while (Date.now() - t0 < timeoutMs) {
    for (const [url, settled] of [[URLS.tiktokProfile(handle), profileSettled], [URLS.tiktokContent, studioSettled]]) {
      try {
        await s.navigate(url);
        await s.waitFor(settled, 15_000);
        await sleep(settleMs);
        for (const id of (await tiktokVideoIds(s, handle)).filter(x => !before.includes(x))) {
          if (!checked.get(id)) checked.set(id, await tiktokVideoText(s, handle, id).catch(() => ''));
          const key = bindNewPost([...checked].map(([key, text]) => ({ key, text })), before, { caption, evidence });
          if (key) return `https://www.tiktok.com/@${handle}/video/${key}`;
          checked.delete(id); // not (yet) ours: a processing video may show its description on the next round
        }
      } catch { /* page still loading; try again */ }
    }
    await sleep(every);
  }
  return null;
}
export async function tiktokDiscard(s) {
  if (!await s.clickEl(`document.querySelector(${q(SELECTORS.tiktok.discard)})`)) return false;
  await sleep(1200);
  const ok = await s.clickEl(byText(SELECTORS.tiktok.dialogButton, 'Discard'));
  await sleep(1500);
  return Boolean(ok);
}

// -------------------------------------------------------------------------------- LinkedIn
/**
 * Every post element on the page that carries its own URN, with that element's text:
 * [{ key: 'activity:123', text }]. A URN in markup without its post (promo, overlay) is not a candidate.
 */
export const linkedinPostCandidates = s => s.ev(`(() => { const POST = '[data-urn], [data-id], [data-activity-urn]';
  return [...document.querySelectorAll(POST)].flatMap(e => {
    const v = [e.getAttribute('data-urn'), e.getAttribute('data-id'), e.getAttribute('data-activity-urn')].join(' ');
    const m = /urn:li:(activity|share|ugcPost):(\\d{10,25})/.exec(v);
    if (!m) return [];
    // The post's OWN commentary: the first text block whose nearest post container is this one
    // (a reshared/quoted post has its own container; comments live outside the commentary block).
    const own = [...e.querySelectorAll(${q(SELECTORS.linkedin.commentary)})].find(t => t.closest(POST) === e && !t.closest('.comments-comments-list, .comments-comment-item'));
    return [{ key: m[1] + ':' + m[2], text: own?.innerText || '' }];
  }); })()`);
export const linkedinUrl = key => { const [type, id] = String(key).split(':'); return `https://www.linkedin.com/feed/update/urn:li:${type}:${id}/`; };
/** Admin post list: rendered once its feed has items (a promo card counts: the list has rendered). The "Start a post" box is not a signal. */
export const postsSettled = `document.querySelectorAll('main .feed-shared-update-v2[data-urn], main [data-urn^="urn:li:activity"]').length > 0`;
/** Public posts page: posts rendered, or LinkedIn's explicit empty state. */
export const publicSettled = `document.querySelectorAll('main [data-urn^="urn:li:activity"], main [data-urn^="urn:li:share"], main [data-urn^="urn:li:ugcPost"]').length > 0 || /doesn.t have any posts/.test(document.querySelector('main')?.innerText || '')`;
/** The image asset id in a LinkedIn media URL (…/dms/image/v2/<ASSET>/company-logo_…). */
export const assetOf = url => /\/dms\/image\/v2\/([A-Za-z0-9_-]+)\/company-logo/.exec(String(url ?? ''))?.[1] ?? null;
/**
 * Whether the composer posts as company <id> itself. The actor is read INSIDE the share modal
 * (its name and its logo's asset id); the company is read from LinkedIn's own record for <id>
 * (/voyager/api/organization/companies/<id>: entityUrn, name, logo asset, the viewer's admin
 * permission). The two must agree: same name, same logo asset. Nothing elsewhere in the document
 * is compared. Returns null or the reason.
 */
export function linkedinActorProblem(actor, company, { companyId, pageName }) {
  if (!company || company.entityUrn !== `urn:li:fs_normalized_company:${companyId}`) return `LinkedIn's record for company ${companyId} could not be read (${company?.error ?? company?.entityUrn ?? 'none'})`;
  if (company.canAdmin !== true) return `the logged-in member is not an admin of company ${companyId}`;
  if (norm(company.name) !== norm(pageName)) return `company ${companyId} is "${company.name}", not "${pageName}"`;
  if (norm(actor?.name) !== norm(company.name)) return `composer posts as "${actor?.name}", not "${company.name}"`;
  if (!actor?.asset) return 'composer actor picture is not a company logo (a member profile?)';
  if (`urn:li:digitalmediaAsset:${actor.asset}` !== company.logoAsset) return `composer actor logo ${actor.asset} is not the logo of company ${companyId}`;
  return null;
}
async function linkedinActor(s) {
  return s.ev(`(() => { const a = document.querySelector(${q(SELECTORS.linkedin.actor)}); const src = a?.querySelector('img')?.src || '';
    const m = /\\/dms\\/image\\/v2\\/([A-Za-z0-9_-]+)\\/company-logo/.exec(src);
    return { name: a?.querySelector('.text-body-large-bold, .artdeco-entity-lockup__title span')?.innerText?.trim() || '', asset: m ? m[1] : null }; })()`);
}
async function linkedinCompany(s, companyId) {
  return s.ev(`(async () => { try {
    const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)/) || [])[1] || '';
    const r = await fetch('/voyager/api/organization/companies/${companyId}', { credentials: 'include', headers: { 'csrf-token': csrf, accept: 'application/vnd.linkedin.normalized+json+2.1' } });
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const d = (await r.json()).data || {};
    return { entityUrn: d.entityUrn, name: d.name, logoAsset: d.logos?.logo?.digitalmediaAsset || d.logo?.image?.digitalmediaAsset || null, canAdmin: d.viewerPermissions?.canUpdateOrganizationProfile === true };
  } catch (e) { return { error: String(e.message || e) }; } })()`);
}
async function assertLinkedinActor(s, opts) {
  const why = linkedinActorProblem(await linkedinActor(s), await linkedinCompany(s, opts.companyId), opts);
  if (why) throw notClicked(new BrowserError('wrong-actor', `LinkedIn: ${why}`));
}
/** Admin access + baseline: post URNs on the admin list and on the public posts page, each after it settled. */
export async function linkedinSession(s, companyId, { settleMs = 2500 } = {}) {
  const keys = new Set();
  for (const [url, settled] of [[URLS.linkedinPublic(companyId), publicSettled], [URLS.linkedinPosts(companyId), postsSettled]]) {
    await s.navigate(url);
    await s.waitFor(`/login|authwall|checkpoint/.test(location.href) || (${settled})`, 25_000);
    await stop(s, linkedinBlocker);
    if (!await s.ev(settled)) throw new BrowserError('baseline', `LinkedIn ${url} did not load`);
    await sleep(settleMs);
    for (const c of await linkedinPostCandidates(s)) keys.add(c.key);
  }
  if (!await s.ev(`!!(${byText(SELECTORS.linkedin.startPost, 'Start a post')})`))
    throw new BrowserError('not-admin', 'No "Start a post" on the Page admin: the logged-in LinkedIn member is not an admin of this Page');
  return [...keys];
}
/** Open the Page's composer, attach the images, type the caption. Refuses unless the composer posts AS the Page. */
export async function linkedinFill(s, winFiles, caption, { pageName, companyId }) {
  if (!await s.clickEl(byText(SELECTORS.linkedin.startPost, 'Start a post'))) throw new BrowserError('page-changed', 'LinkedIn "Start a post" not found');
  if (!await s.waitFor(`!!document.querySelector(${q(SELECTORS.linkedin.editor)})`, 20_000)) throw new BrowserError('page-changed', 'LinkedIn composer did not open');
  await assertLinkedinActor(s, { companyId, pageName });
  if (!await s.clickEl(`document.querySelector(${q(SELECTORS.linkedin.addMedia)})`)) throw new BrowserError('page-changed', 'LinkedIn "Add media" not found');
  if (!await s.waitFor(`!!document.querySelector(${q(SELECTORS.linkedin.mediaInput)})`, 15_000)) throw new BrowserError('page-changed', 'LinkedIn media picker did not open');
  await s.setFiles(`document.querySelector(${q(SELECTORS.linkedin.mediaInput)})`, winFiles);
  const n = winFiles.length;
  const loaded = await s.waitFor(`(() => { const m = document.querySelector(${q(SELECTORS.linkedin.modal)}); if (!m) return false; const t = m.innerText; return ${n} === 1 ? !/Select files to begin/.test(t) && !!${byText(`${SELECTORS.linkedin.modal} button`, 'Next')} : t.includes('1 of ${n}'); })()`, 120_000, 1000);
  if (!loaded) throw new BrowserError('upload-timeout', 'LinkedIn did not take the images');
  await sleep(1000);
  if (!await s.clickEl(byText(`${SELECTORS.linkedin.modal} button`, 'Next'))) throw new BrowserError('page-changed', 'LinkedIn media "Next" not found');
  if (!await s.waitFor(`!!document.querySelector(${q(SELECTORS.linkedin.editor)}) && document.querySelectorAll('.share-box-v2__modal img').length > 0`, 30_000)) throw new BrowserError('page-changed', 'LinkedIn composer did not come back with the images');
  if (!await s.typeInto(`document.querySelector(${q(SELECTORS.linkedin.editor)})`, caption)) throw new BrowserError('page-changed', 'LinkedIn editor not found');
  await sleep(1200);
  await s.key('Escape', 'Escape', 27); // a hashtag typeahead, if open
  await sleep(600);
  // Escape may have opened "Save this post as a draft?": go back to editing.
  if (await s.ev(`!!document.querySelector('.artdeco-modal--layer-confirmation')`)) {
    await s.clickEl(`document.querySelector('.artdeco-modal--layer-confirmation button[aria-label="Dismiss"]')`);
    await sleep(600);
  }
  const held = await s.ev(`document.querySelector(${q(SELECTORS.linkedin.editor)}).innerText`);
  checkCaptionHeld(held, caption);
  return held;
}
/** The checks made immediately before the Post click (also run by a dry run, which then discards). */
export async function linkedinPreClick(s, { companyId, pageName, caption } = {}) {
  if (companyId) await assertLinkedinActor(s, { companyId, pageName });
  if (caption != null) assertHeldBeforeClick(await s.ev(`document.querySelector(${q(SELECTORS.linkedin.editor)})?.innerText || ''`), caption);
}
/** Re-validate the actor and the caption, then press Post once. Returns the toast href or a signal. */
export async function linkedinPost(s, { companyId, pageName, caption } = {}) {
  const ready = await s.waitFor(`(() => { const b = document.querySelector(${q(SELECTORS.linkedin.post)}); return b && !b.disabled; })()`, 30_000);
  if (!ready) throw notClicked(new BrowserError('post-disabled', 'LinkedIn Post button stayed disabled'));
  // After the last wait, immediately before the one click: still the Page, still our caption.
  await linkedinPreClick(s, { companyId, pageName, caption });
  if (!await s.clickEl(`document.querySelector(${q(SELECTORS.linkedin.post)})`)) throw notClicked(new BrowserError('page-changed', 'LinkedIn Post button vanished'));
  const link = await s.waitFor(`(() => { const a = document.querySelector(${q(SELECTORS.linkedin.toastLink)}); if (a) return a.href; return document.querySelector(${q(SELECTORS.linkedin.modal)}) ? null : 'modal-closed'; })()`, 60_000, 500);
  if (link === 'modal-closed') { await sleep(1500); return (await s.ev(`document.querySelector(${q(SELECTORS.linkedin.toastLink)})?.href || 'modal-closed'`)); }
  return link || 'no-signal';
}
/** A new URN whose OWN post element shows the caption head, on the admin list or the public page. URL (of its real URN type) or null. */
export async function linkedinConfirm(s, companyId, before, { toast = null, caption = '', evidence = '', timeoutMs = 4 * 60_000, every = 15_000, settleMs = 3000 } = {}) {
  const m = /urn:li:(activity|share|ugcPost):(\d+)/.exec(decodeURIComponent(String(toast ?? '')));
  const prefer = m ? `${m[1]}:${m[2]}` : null;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const [url, settled] of [[URLS.linkedinPosts(companyId), postsSettled], [URLS.linkedinPublic(companyId), publicSettled]]) {
      try {
        await s.navigate(url);
        await s.waitFor(settled, 15_000);
        await sleep(settleMs);
        const key = bindNewPost(await linkedinPostCandidates(s), before, { caption, evidence }, { prefer });
        if (key) return linkedinUrl(key);
      } catch { /* loading */ }
    }
    await sleep(every);
  }
  return null;
}
export async function linkedinDiscard(s) {
  if (!await s.clickEl(`document.querySelector(${q(SELECTORS.linkedin.dismiss)})`)) return false;
  await sleep(1200);
  const ok = await s.clickEl(byText(SELECTORS.linkedin.confirm, 'Discard'));
  await sleep(1000);
  return Boolean(ok) && !await s.ev(`!!document.querySelector(${q(SELECTORS.linkedin.modal)})`);
}
