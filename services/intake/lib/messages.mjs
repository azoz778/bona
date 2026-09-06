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

export function statusReport({ listings, groups, lastError, queueLength }) {
  const lines = ['*Bona intake*', `Watching ${groups.length} group${groups.length === 1 ? '' : 's'}${queueLength ? `, ${queueLength} in the queue` : ''}.`];
  if (!listings.length) lines.push('No listings published from WhatsApp yet.');
  else {
    lines.push('', ...listings.map((l) => `${l.id} · ${l.title.en}${l.hidden ? ' _(hidden)_' : ''}${l.status !== 'available' ? ` _(${l.status})_` : ''}`));
  }
  if (lastError) lines.push('', `Last error: ${lastError.message}`);
  return lines.join('\n');
}
