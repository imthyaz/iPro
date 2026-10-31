import { describe, expect, it } from 'vitest';
import { appliesToMatches, runIsComplete, taskDueOn } from './checklist-rules.js';

const facts = {
  legalEntityId: 'le-1',
  engagementType: 'permanent',
  departmentId: 'eng',
  locationId: 'chn',
};

describe('appliesToMatches', () => {
  it('an empty filter applies to everyone', () => {
    expect(appliesToMatches({}, facts)).toBe(true);
    expect(appliesToMatches({ engagementTypes: [] }, facts)).toBe(true);
  });

  it('every given list must contain the value', () => {
    expect(
      appliesToMatches({ engagementTypes: ['permanent', 'intern'], departmentIds: ['eng'] }, facts),
    ).toBe(true);
    expect(appliesToMatches({ engagementTypes: ['retainer'] }, facts)).toBe(false);
    expect(appliesToMatches({ locationIds: ['blr'] }, facts)).toBe(false);
    expect(appliesToMatches({ departmentIds: ['eng'] }, { ...facts, departmentId: null })).toBe(
      false,
    );
  });
});

describe('taskDueOn', () => {
  it('counts calendar days before and after the anchor date', () => {
    expect(taskDueOn('2026-12-01', -7)).toBe('2026-11-24');
    expect(taskDueOn('2026-12-01', 0)).toBe('2026-12-01');
    expect(taskDueOn('2026-12-01', 30)).toBe('2026-12-31');
  });
});

describe('runIsComplete', () => {
  it('needs every mandatory task done or waived; optional ones don’t block', () => {
    expect(
      runIsComplete([
        { mandatory: true, status: 'done' },
        { mandatory: true, status: 'waived' },
        { mandatory: false, status: 'open' },
      ]),
    ).toBe(true);
    expect(runIsComplete([{ mandatory: true, status: 'open' }])).toBe(false);
  });
});
