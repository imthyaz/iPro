import { describe, expect, it } from 'vitest';
import {
  checkPeopleFile,
  isRealDate,
  rupeesToPaise,
  type ImportLookups,
} from './people-import-rules.js';

const lookups: ImportLookups = {
  today: '2026-11-20',
  existingCodes: new Set(['IDS-0001']),
  existingEmails: new Set(['taken@example.test']),
  designations: new Map([['software engineer', 'des-1']]),
  departments: new Map([
    ['engineering', 'dep-1'],
    ['eng', 'dep-1'],
  ]),
  locations: new Map([['chennai office', 'loc-1']]),
  legalEntities: new Map([['ideassion', 'le-1']]),
  defaultLegalEntityId: 'le-1',
  buckets: ['billable', 'bench'],
  engagementTypes: ['permanent', 'intern'],
};

const row = (over: Record<string, string> = {}) => ({
  employee_code: 'IDS-0100',
  legal_name: 'Anbu Arasu',
  engagement_type: 'permanent',
  joining_date: '2024-01-08',
  designation: 'Software Engineer',
  department: 'Eng',
  location: 'Chennai office',
  bucket: 'billable',
  manager_code: '',
  status: '',
  last_working_date: '',
  work_email: '',
  ...over,
});

describe('the A6 people file (decision #94)', () => {
  it('accepts good rows and orders managers before their reports', () => {
    const r = checkPeopleFile(
      [
        row({ employee_code: 'IDS-0102', manager_code: 'IDS-0101' }),
        row({ employee_code: 'IDS-0101', manager_code: 'IDS-0100' }),
        row({ employee_code: 'IDS-0100', ctc_amount: '6,00,000', ctc_rate_unit: 'Year' }),
      ],
      lookups,
    );
    expect(r.errors).toEqual([]);
    expect(r.order).toEqual(['IDS-0100', 'IDS-0101', 'IDS-0102']);
    expect(r.rows.find((x) => x.employeeCode === 'IDS-0100')!.ctc).toEqual({
      amount: '60000000',
      rateUnit: 'year',
    });
  });

  it('rejects duplicates, missing managers, invalid dates and inconsistent statuses', () => {
    const r = checkPeopleFile(
      [
        row({ employee_code: 'IDS-0100', work_email: 'a@example.test' }),
        row({ employee_code: 'IDS-0100', work_email: 'a@example.test' }),
        row({ employee_code: 'IDS-0001' }),
        row({ employee_code: 'IDS-0103', manager_code: 'IDS-9999' }),
        row({ employee_code: 'IDS-0104', joining_date: '2026-02-30' }),
        row({ employee_code: 'IDS-0105', status: 'exited' }),
        row({ employee_code: 'IDS-0106', status: 'exited', last_working_date: '2023-01-01' }),
        row({
          employee_code: 'IDS-0107',
          department: 'Marketing',
          work_email: 'taken@example.test',
        }),
      ],
      lookups,
    );
    expect(r.errors).toEqual([
      { line: 3, message: 'Duplicate employee_code IDS-0100 (also on line 2)' },
      { line: 3, message: 'Duplicate work_email a@example.test (also on line 2)' },
      { line: 4, message: 'employee_code IDS-0001 is already in iPro' },
      { line: 5, message: "Manager IDS-9999 isn't in the file or in iPro" },
      { line: 6, message: "joining_date 2026-02-30 isn't a real date (use YYYY-MM-DD)" },
      { line: 7, message: 'exited needs a last_working_date' },
      { line: 8, message: 'last_working_date is before joining_date' },
      { line: 9, message: 'work_email taken@example.test is already in iPro' },
      { line: 9, message: 'Unknown department Marketing' },
    ]);
  });

  it('finds manager loops', () => {
    const r = checkPeopleFile(
      [
        row({ employee_code: 'A1', manager_code: 'B1' }),
        row({ employee_code: 'B1', manager_code: 'A1' }),
      ],
      lookups,
    );
    expect(r.errors.map((e) => e.message)).toEqual(['Managers loop: A1 → B1 → A1']);
  });

  it('names missing columns, and an empty file', () => {
    expect(checkPeopleFile([{ employee_code: 'X' }], lookups).errors[0]!.message).toBe(
      'Missing columns: legal_name, engagement_type, joining_date, designation, department, location, bucket',
    );
    expect(checkPeopleFile([], lookups).errors).toEqual([
      { line: 1, message: 'The file has no rows' },
    ]);
  });
});

describe('values', () => {
  it('real dates and rupee amounts only', () => {
    expect(isRealDate('2024-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('20-01-2026')).toBe(false);
    expect(rupeesToPaise('₹6,00,000.50')).toBe('60000050');
    expect(rupeesToPaise('six lakh')).toBeNull();
  });
});
