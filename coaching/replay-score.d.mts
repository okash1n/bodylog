export interface NoteScore {
  rest: number;
  cardio_cap: number;
  carb_up: number;
  ffm_reason: number;
  gram_change: number;
  no_change: number;
  chars: number;
}
export function scoreNote(content: string | null | undefined): NoteScore;
export interface ReplayRow {
  date: string;
  original: NoteScore | null;
  regenerated: NoteScore | null;
}
export function summarizeRows(
  rows: ReplayRow[],
  opts: { from: string; to: string; promptOnly: boolean },
): {
  from: string;
  to: string;
  days: number;
  with_original: number;
  original: Record<string, number>;
  regenerated: Record<string, number> | null;
  rows: ReplayRow[];
};
