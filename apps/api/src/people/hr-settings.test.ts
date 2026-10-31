import { describe, expect, it } from 'vitest';
import {
  formatEmployeeCode,
  noticePeriodDays,
  probationEndDate,
  settingDefaults,
  settingSchemas,
} from './hr-settings.js';

describe('HR setting defaults', () => {
  it('match their schemas', () => {
    for (const [key, schema] of Object.entries(settingSchemas)) {
      expect(
        schema.safeParse(settingDefaults[key as keyof typeof settingDefaults]).success,
        key,
      ).toBe(true);
    }
  });
});

describe('formatEmployeeCode', () => {
  it('pads to the configured width', () => {
    expect(formatEmployeeCode(1, settingDefaults.employee_code)).toBe('IDS-0001');
    expect(formatEmployeeCode(12345, settingDefaults.employee_code)).toBe('IDS-12345');
  });
});

describe('probationEndDate', () => {
  const months = settingDefaults.probation_months;

  it('is six months less a day for permanent staff', () => {
    expect(probationEndDate('2026-01-15', 'permanent', months)).toBe('2026-07-14');
  });

  it('clamps month ends', () => {
    expect(probationEndDate('2025-08-31', 'permanent', months)).toBe('2026-02-27');
    expect(probationEndDate('2023-08-31', 'permanent', months)).toBe('2024-02-28');
  });

  it('is none for retainers and for types with no configured length', () => {
    expect(probationEndDate('2026-01-15', 'retainer', months)).toBeNull();
    expect(probationEndDate('2026-01-15', 'intern', months)).toBeNull();
  });
});

describe('noticePeriodDays', () => {
  const notice = settingDefaults.notice_days;
  it('follows probation, confirmation and the Manager+ band', () => {
    expect(noticePeriodDays(true, 'associate', notice)).toBe(30);
    expect(noticePeriodDays(false, 'senior_lead', notice)).toBe(60);
    expect(noticePeriodDays(true, 'manager_plus', notice)).toBe(90);
  });
});
