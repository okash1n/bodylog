export function localYmd(nowMs: number, tzOffsetHours: number): string;
export function isValidYmd(s: unknown): boolean;
export function addDaysYmd(ymd: string, days: number): string;
export type TargetDate = { ok: true; date: string } | { ok: false; error: string };
export function resolveTargetDate(raw: string | undefined, today: string): TargetDate;
export function fetchRange(date: string, days: number): { from: string; to: string };
export function scheduleTargetDate(nowMs: number, tzOffsetHours: number, slotUtcMinutes?: number): string;
