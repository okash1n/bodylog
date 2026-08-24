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
