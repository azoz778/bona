// Every string the bot sends back into the WhatsApp group. Short, factual, one screen on a
// phone. Kept pure so the tests can assert on them.
import { ROOMS } from '../../../scripts/curate/rooms.mjs';

export const ANNOUNCE = [
  '*Bona intake connected.*',
  '',
  'Send a property brochure PDF here and it goes on the website — the brochure itself comes',
  'back out under Bona branding, on the listing page as *Download brochure*.',
  'Caption hints: `rent` · `off-plan` · `SAR 4,500,000` · `#test` (dry run) · `#nobrochure` (no PDF on the page) · `#hidden`',
  '',
  'Send `help` for the commands.',
].join('\n');

export const READING = 'Reading the brochure…';
export const READING_VIDEO = 'Adding the video…';

const commandsFor = (id) => `Reply \`remove ${id}\` / \`hero ${id} 4\` / \`price ${id} 4500000\` / \`sold ${id}\``;

const priceText = (p) => {
  if (p.onRequest || !p.amount) return 'Price on request';
  return `${p.currency} ${Number(p.amount).toLocaleString('en-US')}${p.period ? ` / ${p.period}` : ''}${p.from ? ' (from)' : ''}`;
};

const coverOf = (listing) => {
  const room = listing._intake?.images?.[0]?.room;
  return room && ROOMS[room] ? ROOMS[room].en : 'first photo';
};

/**
 * Success reply, sent the moment the push lands — the owner does not wait three minutes for
 * a HEAD check to come back. The live check runs detached and only speaks up if the page is
 * STILL missing after BONA_LIVE_CHECK_MS (see `notLive`).
 */
export function published(report) {
  const l = report.listing;
  const lines = [
    `✅ *${l.title.en}*`,
    `Published — live in about 3 minutes: ${report.url}`,
    `${l.images.length} photos · cover: ${coverOf(l)} · ${priceText(l.price)}`,
  ];
  if (l.brochureUrl) {
    const mb = report.brochure?.bytes ? ` (${(report.brochure.bytes / 1048576).toFixed(1)} MB)` : '';
    lines.push(`📄 Brochure re-published under Bona branding${mb}: ${l.brochureUrl}`);
  }
  if (l.hidden) lines.push('_Hidden: it is in the repo but not on the site (`show ' + l.id + '` publishes it)._');
  const warn = (report.warnings || []).filter(Boolean).slice(0, 3);
  if (warn.length) lines.push('', ...warn.map((w) => `⚠️ ${w}`));
  lines.push('', commandsFor(l.id));
  return lines.join('\n');
}

/** #test reply: everything the owner needs to judge it, nothing written. */
export function dryRunSummary(report) {
  const l = report.listingPreview;
  const lines = [
    '🧪 *Dry run* — nothing was published.',
    '',
    `*${l.title.en}*`,
    l.title.ar,
    `${l.type} · ${l.location.district.en}, ${l.location.city.en} · ${priceText(l.price)}`,
    `beds ${l.specs.beds ?? '—'} · baths ${l.specs.baths ?? '—'} · ${l.specs.areaSqm ?? '—'} sqm`,
    '',
    `${report.picks.length} photos would be published, cover: ${report.picks[0] ? (ROOMS[report.picks[0].room]?.en ?? report.picks[0].room) : '—'}`,
  ];
  if (report.blocked) lines.push('', `❌ It would NOT publish: ${report.blocked}`);
  const warn = (report.warnings || []).filter(Boolean).slice(0, 3);
  if (warn.length) lines.push('', ...warn.map((w) => `⚠️ ${w}`));
  lines.push('', 'Send it again without `#test` to publish it.');
  return lines.join('\n');
}

export const rejected = (reason) => `✋ Not published — ${reason}`;

/**
 * Deliberately says nothing about WHY: the detail is git/build/model output, which can quote
 * file contents and secrets. It goes to the journal, where only the owner can read it.
 */
export const failed = () => '⚠️ Something went wrong — nothing was published and the repo was left clean. The details are in the journal (`journalctl --user -u bona-intake -e`).';

/** Follow-up, sent ONLY when the page is still missing long after the push. */
export const notLive = (url, minutes) => `⚠️ The page is still not answering ${minutes} minutes after the push: ${url}\nThe listing is committed — check the GitHub Pages deploy.`;
export const alreadyLive = (info) => `Already published: ${info.url}\n(${info.id})`;
export const notFound = (id) => `No listing called ${id}. Send \`status\` to see what is live.`;

/** `brochure <id>` — the branded PDF was rebuilt from the developer's original. */
export function brochureRebuilt(id, listing, brochure = {}) {
  const mb = brochure.bytes ? `${(brochure.bytes / 1048576).toFixed(1)} MB` : null;
  const shrunk = brochure.srcBytes && brochure.bytes && brochure.srcBytes > brochure.bytes * 1.05
    ? ` (from ${(brochure.srcBytes / 1048576).toFixed(1)} MB)` : '';
  const size = mb ? `${mb}${shrunk} · ${brochure.pages ?? '?'} pages` : '';
  return [
    `📄 Bona-branded brochure rebuilt — *${listing.title.en}* (${id})`,
    size,
    listing.brochureUrl || '',
    '',
    commandsFor(id),
  ].filter(Boolean).join('\n');
}
export const removed = (id, title) => `🗑️ Removed *${title}* (${id}). It comes off the site with the next deploy.`;
export const updated = (id, what, listing) => `✏️ ${what} — *${listing.title.en}* (${id})\n${commandsFor(id)}`;

/** A clip with no id in its caption and no brochure near it in time — recognized, not silently dropped. */
export const videoNoId = () => '✋ Which listing is this video for? Send it right after its brochure, or caption it with the id, e.g. `video BONA-W001`.';
/** Two different listings were published from brochures equally close to the clip. */
export const videoAmbiguous = (ids) => `✋ Two brochures were sent just as close to this video — ${ids.join(' and ')}. Caption it with the one you mean, e.g. \`video ${ids[0]}\`.`;
/** The clip arrived while its brochure is still being published; it is parked, not lost. Sent once. */
export const videoWaiting = (fileName) => `🎬 Got the video — it will be added once *${String(fileName || 'the brochure').replace(/\n/g, ' ')}* is published.`;
export const videoTooLarge = (mb, limitMb) => `✋ The video is ${mb.toFixed(1)} MB — the limit is ${limitMb} MB.`;
/**
 * The clip was looked at frame by frame and still could not be placed. ONE line, naming the
 * listings it was compared against so the owner can just reply with the right id — never a
 * guess, because a walkthrough on the wrong property is worse than a question.
 */
export function videoUnsure(ids = []) {
  const shown = ids.slice(0, 3);
  const example = shown[0] || 'BONA-W001';
  return `✋ I watched the clip and still cannot tell which property it is${shown.length ? ` — the closest I have are ${shown.join(', ')}` : ''}. Caption it with the id, e.g. \`video ${example}\`, or send it right after its brochure.`;
}
/** ffmpeg could not get it under the cap even at 720p — nothing was committed. */
export const videoStillTooLarge = (mb, limitMb) => `✋ Even re-encoded, the video is ${mb.toFixed(1)} MB — the limit for what goes on the site is ${limitMb} MB. Send a shorter clip.`;
/** ffmpeg refused the file outright (not a video, or a container it cannot read). */
export const videoUnreadable = () => '✋ That video could not be re-encoded — the reason is in the journal. Try sending it again, or as MP4.';
/** The identical clip is already on the listing (a re-send, or a replay after a crash) — nothing was committed. */
export const videoAlreadyOn = (id, listing, video = {}) => `🎬 That video is already on *${listing.title.en}* (${id})${video.n ? ` as video ${video.n}` : ''} — nothing to add.`;

/**
 * The clip was downloaded and added to a listing — named by the owner (`video <id>`) or
 * matched to the brochure sent closest to it (`matched.deltaSec`).
 */
export function videoAdded(id, listing, video = {}, { matched = null } = {}) {
  const mb = video.bytes ? ` (${(video.bytes / 1048576).toFixed(1)} MB)` : '';
  const n = listing.videos?.length ?? 1;
  // How it was placed, in the owner's terms: the brochure it came with, or the clip itself.
  const how = matched?.by === 'content' && matched.confidence != null
    ? `Recognised from the video itself — ${Math.round(matched.confidence * 100)}% sure it is this property.`
    : (matched?.deltaSec != null ? `Matched to the brochure sent within ${Math.round(matched.deltaSec)} s of it.` : null);
  return [
    `🎬 Video added${mb} — *${listing.title.en}* (${id})`,
    how,
    `${n} video${n === 1 ? '' : 's'} on this listing now.`,
    '',
    commandsFor(id),
  ].filter((line) => line !== null).join('\n');
}

export function statusReport({ listings, groups, lastError, queueLength }) {
  const lines = ['*Bona intake*', `Watching ${groups.length} group${groups.length === 1 ? '' : 's'}${queueLength ? `, ${queueLength} in the queue` : ''}.`];
  if (!listings.length) lines.push('No listings published from WhatsApp yet.');
  else {
    lines.push('', ...listings.map((l) => `${l.id} · ${l.title.en}${l.hidden ? ' _(hidden)_' : ''}${l.status !== 'available' ? ` _(${l.status})_` : ''}`));
  }
  if (lastError) lines.push('', `Last error: ${lastError.message}`);
  return lines.join('\n');
}
