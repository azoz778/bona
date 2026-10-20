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

// ---------------------------------------------------------------------------------- TikTok
/** Every video id the page links to or embeds for this handle. */
export const tiktokVideoIds = (s, handle) => s.ev(`[...new Set([...document.documentElement.innerHTML.matchAll(/@${handle}\\/video\\/(\\d{8,25})/g)].map(m => m[1]))]`);

/** Open our own profile: proves the session is the Bona account (only the owner sees "Edit profile"); returns the video ids already there. */
export async function tiktokSession(s, handle) {
  await s.navigate(URLS.tiktokProfile(handle));
  await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.profileTitle)}) || /\\/login/.test(location.href)`, 20_000);
  await stop(s, tiktokBlocker);
  const own = await s.waitFor(`!!document.querySelector(${q(SELECTORS.tiktok.ownProfile)})`, 10_000);
  if (!own) throw new BrowserError('not-logged-in', `The browser is not logged in to TikTok as @${handle} (no "Edit profile" on the profile page)`);
  return tiktokVideoIds(s, handle);
}
async function tiktokDismissPopups(s) {
  for (const label of ['Cancel', 'Got it', 'Not now']) {
    // "Turn on automatic content checks?" → Cancel; "New editing features added" → Got it.
    await s.clickEl(byText('button', label));
  }
}
/** Upload the reel and type the caption. Returns what the caption box holds afterwards. */
export async function tiktokFill(s, winFile, caption, { uploadTimeoutMs = 10 * 60_000 } = {}) {
  await s.navigate(URLS.tiktokUpload);
  await s.waitFor(`document.querySelector(${q(SELECTORS.tiktok.fileInput)}) || /\\/login/.test(location.href)`, 30_000);
  await stop(s, tiktokBlocker);
  // "A video you were editing wasn't saved. Continue editing?" — a draft left by an interrupted
  // run. Never continue someone else's draft: discard it and start clean.
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
  // The "automatic content checks" modal and the "new editing features" tip pop up a few seconds
  // after the upload and steal focus mid-typing; clear them first, and retype once if they cut in.
  for (let attempt = 1; ; attempt++) {
    await sleep(3000);
    await tiktokDismissPopups(s);
    if (!await s.typeInto(`document.querySelector(${q(SELECTORS.tiktok.caption)})`, caption)) throw new BrowserError('page-changed', 'TikTok caption editor not found');
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
/** Press Post. From here on, the outcome is unknown until confirmed. */
export async function tiktokPost(s) {
  const ready = await s.waitFor(`(() => { const b = document.querySelector(${q(SELECTORS.tiktok.post)}); return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'; })()`, 60_000);
  if (!ready) throw notClicked(new BrowserError('post-disabled', 'TikTok Post button stayed disabled'));
  const clicked = await s.clickEl(`document.querySelector(${q(SELECTORS.tiktok.post)})`);
  if (!clicked) throw notClicked(new BrowserError('page-changed', 'TikTok Post button vanished'));
  // A follow-up confirmation ("Post now" when the content check is still running) is accepted once.
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    if (await s.clickEl(byText(SELECTORS.tiktok.dialogButton, 'Post now'))) continue;
    const url = String(await s.url());
    if (/tiktokstudio\/content/.test(url)) return 'redirected-to-content';
    const t = String(await s.ev('(document.body?.innerText || "").slice(0, 4000)'));
    if (/Your video (has been|is being) (uploaded|posted)|Video posted|Manage your posts/i.test(t)) return 'posted-message';
  }
  return 'no-signal';
}
/** Poll the profile for a video id that was not there before. Returns its URL or null. */
export async function tiktokConfirm(s, handle, before, { timeoutMs = 6 * 60_000, every = 20_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const url of [URLS.tiktokProfile(handle), URLS.tiktokContent]) {
      try {
        await s.navigate(url);
        await sleep(4000);
        const fresh = (await tiktokVideoIds(s, handle)).filter(id => !before.includes(id));
        if (fresh.length) return `https://www.tiktok.com/@${handle}/video/${fresh.sort().at(-1)}`;
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
/** Every activity URN on the page (posts, their links, data attributes). */
export const linkedinActivityIds = s => s.ev(`[...new Set([...document.documentElement.innerHTML.matchAll(/urn:li:(?:activity|share|ugcPost):(\\d{10,25})/g)].map(m => m[1]))]`);

export async function linkedinSession(s, companyId) {
  await s.navigate(URLS.linkedinPosts(companyId));
  await s.waitFor(`/login|authwall|checkpoint/.test(location.href) || ${byText(SELECTORS.linkedin.startPost, 'Start a post')}`, 25_000);
  await stop(s, linkedinBlocker);
  if (!await s.ev(`!!(${byText(SELECTORS.linkedin.startPost, 'Start a post')})`))
    throw new BrowserError('not-admin', 'No "Start a post" on the Page admin: the logged-in LinkedIn member is not an admin of this Page');
  await sleep(2500);
  return linkedinActivityIds(s);
}
/** Open the Page's composer, attach the images, type the caption. Refuses unless the composer posts AS the Page. */
export async function linkedinFill(s, winFiles, caption, { pageName }) {
  if (!await s.clickEl(byText(SELECTORS.linkedin.startPost, 'Start a post'))) throw new BrowserError('page-changed', 'LinkedIn "Start a post" not found');
  if (!await s.waitFor(`!!document.querySelector(${q(SELECTORS.linkedin.editor)})`, 20_000)) throw new BrowserError('page-changed', 'LinkedIn composer did not open');
  const actor = norm(await s.ev(`(document.querySelector(${q(SELECTORS.linkedin.actor)})?.innerText || '')`));
  if (!actor.startsWith(norm(pageName))) throw new BrowserError('wrong-actor', `LinkedIn composer posts as "${actor.split(' Post to')[0]}", not the Page "${pageName}"`);
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
  await s.key('Escape', 'Escape', 27); // a hashtag typeahead, if open (Escape on the composer itself asks to discard: handled below)
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
export async function linkedinPost(s) {
  const ready = await s.waitFor(`(() => { const b = document.querySelector(${q(SELECTORS.linkedin.post)}); return b && !b.disabled; })()`, 30_000);
  if (!ready) throw notClicked(new BrowserError('post-disabled', 'LinkedIn Post button stayed disabled'));
  if (!await s.clickEl(`document.querySelector(${q(SELECTORS.linkedin.post)})`)) throw notClicked(new BrowserError('page-changed', 'LinkedIn Post button vanished'));
  const link = await s.waitFor(`(() => { const a = document.querySelector(${q(SELECTORS.linkedin.toastLink)}); if (a) return a.href; return document.querySelector(${q(SELECTORS.linkedin.modal)}) ? null : 'modal-closed'; })()`, 60_000, 500);
  // The toast is gone in a few seconds; give it one more look after the modal closes.
  if (link === 'modal-closed') { await sleep(1500); return (await s.ev(`document.querySelector(${q(SELECTORS.linkedin.toastLink)})?.href || 'modal-closed'`)); }
  return link || 'no-signal';
}
/**
 * A new activity URN on the Page's post lists whose post shows the caption's first line (the
 * admin page also carries promos and the messaging overlay, so a bare new id is not proof);
 * the toast's "View post" URN counts once it is on the page too. Returns the post URL or null.
 */
export async function linkedinConfirm(s, companyId, before, { toast = null, captionHead = '', timeoutMs = 4 * 60_000, every = 15_000 } = {}) {
  const fromToast = /urn:li:(?:activity|share|ugcPost):(\d+)/.exec(String(toast ?? ''));
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const url of [URLS.linkedinPosts(companyId), URLS.linkedinPublic(companyId)]) {
      try {
        await s.navigate(url);
        await sleep(4000);
        const ids = await linkedinActivityIds(s);
        const fresh = ids.filter(id => !before.includes(id));
        if (fromToast && ids.includes(fromToast[1])) return `https://www.linkedin.com/feed/update/urn:li:activity:${fromToast[1]}/`;
        for (const id of fresh.sort().reverse()) {
          const shows = await s.ev(`(() => { const want = ${q(norm(captionHead).slice(0, 50))}; const n = x => String(x || '').replace(/[\\s\\u200e\\u200f\\u2066-\\u2069]+/g, ' ').trim();
            return [...document.querySelectorAll('[data-urn*="${id}"], [data-id*="${id}"], [data-activity-urn*="${id}"]')].some(e => n(e.innerText).includes(want)); })()`);
          if (shows) return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
        }
        // Markup without per-post data attributes: one new id and the caption on the page's main column.
        if (fresh.length === 1 && captionHead && await s.ev(`(document.querySelector('main')?.innerText || '').replace(/[\\s\\u200e\\u200f\\u2066-\\u2069]+/g, ' ').includes(${q(norm(captionHead).slice(0, 50))})`))
          return `https://www.linkedin.com/feed/update/urn:li:activity:${fresh[0]}/`;
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
