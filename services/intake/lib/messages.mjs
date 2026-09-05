// Every string the bot sends back into the WhatsApp group. Short, factual, one screen on a
// phone. Kept pure so the tests can assert on them.
import { ROOMS } from '../../../scripts/curate/rooms.mjs';

export const ANNOUNCE = [
  '*Bona intake connected.*',
  '',
  'Send a property brochure PDF here and it goes on the website.',
  'Caption hints: `rent` · `off-plan` · `SAR 4,500,000` · `#test` (dry run) · `#brochure` (also publish the PDF) · `#hidden`',
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

/** Success reply after a real publish. */
export function published(report, { live }) {
  const l = report.listing;
  const lines = [
    `✅ *${l.title.en}*`,
    `${report.url}`,
    `${l.images.length} photos · cover: ${coverOf(l)} · ${priceText(l.price)}`,
  ];
  if (!live) lines.push('_Published — the page goes live a few minutes after the deploy._');
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
export const failed = (message) => `⚠️ Something went wrong — ${message}`;
export const alreadyLive = (info) => `Already published: ${info.url}\n(${info.id})`;
export const notFound = (id) => `No listing called ${id}. Send \`status\` to see what is live.`;
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
