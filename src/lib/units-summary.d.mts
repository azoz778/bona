export const MAX_SHEET_AGE_DAYS: number;
export type SummaryRow = { key: string; label: { en: string; ar: string }; count: number; areaMin: number; areaMax: number; cashFrom: number };
export function unitSummary(record: unknown): null | { rows: SummaryRow[]; count: number; areaMin: number; areaMax: number; cashFrom: number; delivery: string | null; updated: string | null };
export function sheetAgeDays(updated: string, now?: Date): number;
