export const DEFAULT_HARD_BURN_KCAL: number;
export const DEFAULT_TREND_WINDOW_DAYS: number;
export const SESSION_DAYS: number;
export const PREVIOUS_NOTE_DAYS: number;
export const INTAKE_WINDOW_DAYS: number;

export function roundTo(v: number | null | undefined, digits: number): number | null;

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
): { recent7_avg: MetricTriple; diff_vs_prev7: MetricTriple; recent7_n: MetricTriple; prev7_n: MetricTriple };

export type TrendLabel = 'declining' | 'rising' | 'flat' | 'uncertain';
export interface TrendMetric {
  slope_kg_per_week: number | null;
  se_kg_per_week: number | null;
  n: number;
  label: TrendLabel;
}
export function trendLabel(slopePerWeek: number | null, sePerWeek: number | null): TrendLabel;
export function deriveTrend(
  days: DayRow[],
  date: string,
  opts?: { windowDays?: number; minPoints?: number },
): { window_days: number; weight: TrendMetric; fat: TrendMetric; ffm: TrendMetric };

export interface IntakeDayLike {
  d: string;
  count?: number | null;
  calories?: number | null;
}
export function deriveIntakeAvg(
  days: IntakeDayLike[] | null | undefined,
  date: string,
  opts?: { windowDays?: number; excludeDate?: boolean },
): number | null;

export interface ExerciseDayLike {
  d: string;
  strength_count?: number | null;
  calories_burned?: number | null;
}
export function deriveExerciseContext(
  exerciseDays: ExerciseDayLike[] | null | undefined,
  date: string,
  opts?: { hardBurnKcal?: number },
): {
  strength_streak_days: number;
  hard_streak_days: number;
  strength_streak_days_before_today: number;
  hard_streak_days_before_today: number;
  strength_days_last7: number;
  days_since_last_strength: number | null;
};

export interface SessionLogLike {
  id: string;
  menu_id?: string;
  performed_at: string;
  category: string;
  menu_name: string;
  note?: string | null;
  duration_min?: number | null;
  calories?: number | null;
  group_id?: string | null;
  rounds?: number | null;
  sets?: { reps: number; weight_kg?: number | null; volume?: number | null }[];
}
export interface SessionSummary {
  d: string;
  hh: number;
  kind: string;
  name: string;
  min: number | null;
  kcal: number | null;
  weighted_volume: number;
  bodyweight_volume: number;
  rounds: number | null;
  muscle_group: string | null;
  note: string | null;
}
export function summarizeSessions(
  logs: SessionLogLike[] | null | undefined,
  tzOffsetHours: number,
  opts?: { muscleGroups?: Map<string, string | null> },
): SessionSummary[];

export interface NoteLike {
  kind?: string;
  date?: string;
  content?: string;
}
export function selectPreviousNotes(
  notes: NoteLike[] | null | undefined,
  date: string,
  opts?: { maxChars?: number; minDate?: string },
): { date: string; content: string }[];
