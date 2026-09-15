export const DEFAULT_MAX_HARD_STREAK: number;
export const DEEP_DEFICIT_KCAL: number;
export const RAISE_CEILING_BELOW_TDEE_KCAL: number;
export const POLICY: string;
export const SYSTEM_PROMPT: string;
export interface CoachingProfile {
  text: string | null;
  max_hard_streak: number;
  min_kcal: number | null;
  min_protein_g: number | null;
}
export function parseProfile(raw: string | null | undefined): CoachingProfile | null;
export function commonRules(opts: { maxHardStreak: number; minKcal?: number | null; minProteinG?: number | null }): string;
export function buildPrompt(
  data: { profile?: CoachingProfile | null; [key: string]: unknown },
  date: string,
  opts: { fetchDays: number },
): string;
