/**
 * Effective dating (CLAUDE.md, decisions #21 and #32). Business dates are ISO `YYYY-MM-DD` strings, so
 * string order is date order. `effectiveTo` is inclusive; null means open-ended. History is never edited
 * in place: a change closes the covering row the day before and opens a new one.
 */
export interface DatedRow {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function covers(row: DatedRow, date: string): boolean {
  return row.effectiveFrom <= date && (row.effectiveTo === null || date <= row.effectiveTo);
}

/** The row in force on `date`, if any. */
export function rowAt<T extends DatedRow>(rows: readonly T[], date: string): T | undefined {
  return rows.find((row) => covers(row, date));
}

export type ChangePlan =
  | {
      ok: true;
      /** Row to close (its effectiveTo becomes the day before the change). */
      close: { id: string; effectiveTo: string } | null;
      /** The new row runs until the day before the next existing row starts, or stays open. */
      newRow: { effectiveFrom: string; effectiveTo: string | null };
      /** The row the change is based on (its values carry forward), if any. */
      basedOn: string | null;
    }
  | { ok: false; problem: string };

/** How to apply a change effective from `from` to a history of non-overlapping rows. */
export function planChange(rows: readonly DatedRow[], from: string): ChangePlan {
  if (rows.some((row) => row.effectiveFrom === from)) {
    return { ok: false, problem: 'A version already starts on this date' };
  }
  const covering = rowAt(rows, from);
  const next = rows
    .filter((row) => row.effectiveFrom > from)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const newTo = next ? addDays(next.effectiveFrom, -1) : (covering?.effectiveTo ?? null);
  return {
    ok: true,
    close: covering ? { id: covering.id, effectiveTo: addDays(from, -1) } : null,
    newRow: { effectiveFrom: from, effectiveTo: newTo },
    basedOn: covering?.id ?? null,
  };
}

/** Today's business date in a timezone (Asia/Kolkata for Phase 1). */
export function businessDate(now: Date, timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
