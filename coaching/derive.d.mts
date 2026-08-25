export interface MetricTriple {
  weight: number | null;
  fat_mass: number | null;
  fat_free_mass: number | null;
}
export interface DayRow {
  d: string;
  weight?: number | null;
  fat_mass?: number | null;
  fat_free_mass?: number | null;
}
export function deriveTerms(
  days: DayRow[],
  date: string,
): { recent7_avg: MetricTriple; diff_vs_prev7: MetricTriple };
export interface NoteLike {
  kind?: string;
  date?: string;
  content?: string;
}
export function selectPreviousNotes(
  notes: NoteLike[] | null | undefined,
  date: string,
  opts?: { maxChars?: number },
): { date: string; content: string }[];
