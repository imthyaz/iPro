import { isRealDate, type ImportError } from './people-import-rules.js';

/**
 * Migration step 5 (spec; decision #95): past events from the old system become journey events
 * marked migrated. Only what can be sourced reliably; anything else is left out, and the journey
 * says history before a date isn't recorded.
 */
export const HISTORY_EVENTS = {
  confirmed: { eventType: 'probation_confirmed', category: 'lifecycle', title: () => 'Confirmed' },
  designation_changed: {
    eventType: 'designation_changed',
    category: 'career',
    title: (detail: string) => `Became ${detail}`,
  },
  team_changed: {
    eventType: 'team_changed',
    category: 'team',
    title: (detail: string) => `Moved to ${detail}`,
  },
  exited: { eventType: 'exited', category: 'lifecycle', title: () => 'Left' },
} as const;
export type HistoryEvent = keyof typeof HISTORY_EVENTS;

export interface HistoryPerson {
  personId: string;
  engagementId: string;
  joiningDate: string;
  status: string;
  lastWorkingDate: string | null;
}

export interface HistoryRow {
  line: number;
  employeeCode: string;
  date: string;
  event: HistoryEvent;
  detail: string;
}

/** Checks the history file against the people now in iPro. */
export function checkHistoryFile(
  records: Record<string, string>[],
  people: ReadonlyMap<string, HistoryPerson>,
  today: string,
): { rows: HistoryRow[]; errors: ImportError[] } {
  const errors: ImportError[] = [];
  if (records.length === 0)
    return { rows: [], errors: [{ line: 1, message: 'The file has no rows' }] };
  const header = Object.keys(records[0]!);
  const missing = ['employee_code', 'date', 'event'].filter((c) => !header.includes(c));
  if (missing.length) {
    return { rows: [], errors: [{ line: 1, message: `Missing columns: ${missing.join(', ')}` }] };
  }
  const rows: HistoryRow[] = [];
  const seen = new Map<string, number>();
  records.forEach((r, i) => {
    const line = i + 2;
    const before = errors.length;
    const fail = (message: string) => errors.push({ line, message });
    const code = (r.employee_code ?? '').trim();
    const date = (r.date ?? '').trim();
    const event = (r.event ?? '').trim().toLowerCase();
    const detail = (r.detail ?? '').trim();
    const person = people.get(code);
    if (!person) fail(`No one with employee_code ${code || '(empty)'}; load people first`);
    if (!isRealDate(date)) fail(`date ${date || '(empty)'} isn't a real date (use YYYY-MM-DD)`);
    if (!(event in HISTORY_EVENTS)) {
      fail(`event ${event || '(empty)'} must be one of ${Object.keys(HISTORY_EVENTS).join(', ')}`);
    }
    if ((event === 'designation_changed' || event === 'team_changed') && !detail) {
      fail(
        `${event} needs a detail (the new ${event === 'designation_changed' ? 'designation' : 'team'})`,
      );
    }
    if (detail.length > 200) fail('detail is longer than 200 characters');
    if (person && isRealDate(date)) {
      if (date < person.joiningDate)
        fail(`date ${date} is before joining on ${person.joiningDate}`);
      if (date > today) fail(`date ${date} hasn't happened yet`);
      if (event === 'exited') {
        if (person.status !== 'exited') fail(`${code} hasn't left in iPro`);
        else if (person.lastWorkingDate && date !== person.lastWorkingDate) {
          fail(`exited on ${date}, but iPro has ${person.lastWorkingDate} as the last working day`);
        }
      }
    }
    const key = `${code}:${event}:${date}`;
    if (seen.has(key)) fail(`The same event is on line ${seen.get(key)}`);
    else seen.set(key, line);
    if (errors.length === before) {
      rows.push({ line, employeeCode: code, date, event: event as HistoryEvent, detail });
    }
  });
  return { rows, errors };
}

/**
 * Balances that must add up (migration step 3; decision #95): when the leave file gives the parts,
 * opening + accrued − taken − lapsed − encashed must equal the balance. Returns an error or null.
 */
export function balanceMismatch(record: Record<string, string>): string | null {
  const parts = ['opening', 'accrued', 'taken', 'lapsed', 'encashed'] as const;
  const given = parts.filter((p) => (record[p] ?? '').trim() !== '');
  if (given.length === 0) return null;
  const value = (k: string) => Number((record[k] ?? '').trim() || '0');
  for (const p of given) {
    const n = value(p);
    if (!Number.isFinite(n) || !Number.isInteger(n * 2) || n < 0) {
      return `${p} "${record[p]}" isn't a whole or half day`;
    }
  }
  const expected =
    value('opening') + value('accrued') - value('taken') - value('lapsed') - value('encashed');
  const balance = value('balance');
  if (Math.abs(expected - balance) > 0.001) {
    const words = [
      `${value('opening')}`,
      `+ ${value('accrued')}`,
      `− ${value('taken')}`,
      ...(value('lapsed') ? [`− ${value('lapsed')}`] : []),
      ...(value('encashed') ? [`− ${value('encashed')}`] : []),
    ].join(' ');
    return `The balance doesn't add up: ${words} = ${expected}, not ${balance}`;
  }
  return null;
}
