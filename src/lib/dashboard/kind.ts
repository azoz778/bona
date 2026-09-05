/* Round-2 listing fields (kind, project, unit, map, virtualTourUrl) as the
   dashboard reads them. `kind` is REQUIRED by the schema but other agents are
   still back-filling it, so every consumer goes through deriveKind() and never
   trusts the raw field. Kept here, not in lib/listings.ts, because that file is
   owned by the site agent. */
import type { Listing, Localised } from '../listings';

export type Kind = 'house' | 'apartment' | 'land' | 'building';
export type KindOrOther = Kind | 'other';

export interface ListingExt extends Listing {
  kind?: string | null;
  project?: { name?: Partial<Localised> | null; developer?: Partial<Localised> | null } | null;
  unit?: { floor?: string | number | null; block?: string | null; unitRef?: string | null } | null;
  map?: { lat: number; lng: number } | null;
}

export const KINDS: { key: Kind; label: string; plural: string }[] = [
  { key: 'house', label: 'House', plural: 'Houses' },
  { key: 'apartment', label: 'Apartment', plural: 'Apartments' },
  { key: 'land', label: 'Land', plural: 'Land' },
  { key: 'building', label: 'Building', plural: 'Buildings' },
];

const VALID = new Set<string>(KINDS.map(k => k.key));

/** type -> kind, mirroring LISTING-SCHEMA.md "Round 2 additions". */
const TYPE_TO_KIND: Record<string, Kind> = {
  villa: 'house', mansion: 'house', duplex: 'house', palais: 'house', townhouse: 'house', chalet: 'house',
  apartment: 'apartment', penthouse: 'apartment', residence: 'apartment',
  land: 'land', plot: 'land',
  building: 'building', office: 'building',
};

/** The listing's kind: the explicit field when valid, else derived from `type`. */
export function deriveKind(l: Pick<ListingExt, 'kind' | 'type'>): KindOrOther {
  const k = (l.kind ?? '').toString().trim().toLowerCase();
  if (VALID.has(k)) return k as Kind;
  return TYPE_TO_KIND[(l.type ?? '').toString().trim().toLowerCase()] ?? 'other';
}

export function kindLabel(k: string): string {
  return KINDS.find(x => x.key === k)?.label ?? (k === 'other' ? 'Other' : k);
}

/** Matterport (or any) tour URL, or null when unset/blank/not http(s). */
export function tourUrl(l: Pick<ListingExt, 'virtualTourUrl'>): string | null {
  const u = (l.virtualTourUrl ?? '').toString().trim();
  return /^https?:\/\//i.test(u) ? u : null;
}

export function projectName(l: Pick<ListingExt, 'project'>): string {
  const n = l.project?.name;
  return (n?.en || n?.ar || '').toString().trim();
}

/** "Floor 3 · Block B · A-12" for units; empty when no unit info. */
export function unitLine(l: Pick<ListingExt, 'unit'>): string {
  const u = l.unit;
  if (!u) return '';
  const parts: string[] = [];
  if (u.floor != null && u.floor !== '') parts.push(`Floor ${u.floor}`);
  if (u.block) parts.push(`Block ${u.block}`);
  if (u.unitRef) parts.push(String(u.unitRef));
  return parts.join(' · ');
}
