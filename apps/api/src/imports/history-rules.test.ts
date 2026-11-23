import { describe, expect, it } from 'vitest';
import { balanceMismatch, checkHistoryFile, type HistoryPerson } from './history-rules.js';

const people = new Map<string, HistoryPerson>([
  [
    'IDS-0100',
    {
      personId: 'p1',
      engagementId: 'e1',
      joiningDate: '2023-04-10',
      status: 'active',
      lastWorkingDate: null,
    },
  ],
  [
    'IDS-0101',
    {
      personId: 'p2',
      engagementId: 'e2',
      joiningDate: '2023-05-01',
      status: 'exited',
      lastWorkingDate: '2025-09-30',
    },
  ],
]);
const rec = (employee_code: string, date: string, event: string, detail = '') => ({
  employee_code,
  date,
  event,
  detail,
});

describe('the history file (decision #95)', () => {
  it('accepts sourced events for people already in iPro', () => {
    const r = checkHistoryFile(
      [
        rec('IDS-0100', '2023-10-10', 'confirmed'),
        rec('IDS-0100', '2024-04-01', 'designation_changed', 'Senior Software Engineer'),
        rec('IDS-0101', '2025-09-30', 'exited'),
      ],
      people,
      '2026-11-23',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.line, x.event])).toEqual([
      [2, 'confirmed'],
      [3, 'designation_changed'],
      [4, 'exited'],
    ]);
  });

  it('rejects what doesn’t fit the record', () => {
    const r = checkHistoryFile(
      [
        rec('IDS-0999', '2024-01-01', 'confirmed'),
        rec('IDS-0100', '2022-01-01', 'confirmed'),
        rec('IDS-0100', '2024-04-01', 'promoted'),
        rec('IDS-0100', '2024-04-01', 'designation_changed'),
        rec('IDS-0100', '2024-05-01', 'exited'),
        rec('IDS-0101', '2025-09-01', 'exited'),
        rec('IDS-0100', '2027-01-01', 'confirmed'),
        rec('IDS-0100', '2023-10-10', 'confirmed'),
        rec('IDS-0100', '2023-10-10', 'confirmed'),
      ],
      people,
      '2026-11-23',
    );
    expect(r.errors).toEqual([
      { line: 2, message: 'No one with employee_code IDS-0999; load people first' },
      { line: 3, message: 'date 2022-01-01 is before joining on 2023-04-10' },
      {
        line: 4,
        message:
          'event promoted must be one of confirmed, designation_changed, team_changed, exited',
      },
      { line: 5, message: 'designation_changed needs a detail (the new designation)' },
      { line: 6, message: "IDS-0100 hasn't left in iPro" },
      {
        line: 7,
        message: 'exited on 2025-09-01, but iPro has 2025-09-30 as the last working day',
      },
      { line: 8, message: "date 2027-01-01 hasn't happened yet" },
      { line: 10, message: 'The same event is on line 9' },
    ]);
  });
});

describe('balances that must add up (decision #95)', () => {
  it('passes when only the balance is given, or the parts add up', () => {
    expect(balanceMismatch({ balance: '12' })).toBeNull();
    expect(balanceMismatch({ opening: '10', accrued: '6', taken: '4', balance: '12' })).toBeNull();
    expect(
      balanceMismatch({ opening: '10', accrued: '6', taken: '3', lapsed: '0.5', balance: '12.5' }),
    ).toBeNull();
  });

  it('names the sum when it doesn’t', () => {
    expect(balanceMismatch({ opening: '10', accrued: '6', taken: '3', balance: '12' })).toBe(
      "The balance doesn't add up: 10 + 6 − 3 = 13, not 12",
    );
    expect(balanceMismatch({ opening: 'ten', balance: '12' })).toBe(
      'opening "ten" isn\'t a whole or half day',
    );
  });
});
