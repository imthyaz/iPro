import { describe, expect, it } from 'vitest';
import { buildDay, distanceMetres, lastDayOf, minutesInIndia } from './attendance.service.js';

const shift = { startTime: '09:30', graceMinutes: 15, breakMinutes: 60, halfDayMinutes: 240 };
const at = (time: string, day = '2026-11-09') => new Date(`${day}T${time}:00+05:30`);
const punch = (
  time: string,
  extra: Partial<Parameters<typeof buildDay>[0]['punches'][0]> = {},
) => ({
  at: at(time),
  source: 'web' as const,
  mode: 'office' as const,
  latitude: 13.08,
  outsideGeofence: false,
  ...extra,
});
const base = {
  day: '2026-11-09',
  today: '2026-11-10',
  working: true,
  holiday: null,
  shift,
  punches: [],
};

describe('the attendance build for one day', () => {
  it('a full office day is present, with worked time less the break', () => {
    expect(buildDay({ ...base, punches: [punch('09:20'), punch('18:40')] })).toMatchObject({
      status: 'present',
      workedMinutes: 9 * 60 + 20 - 60,
      mode: 'office',
      flags: [],
    });
  });

  it('late after the grace period; half-day under the threshold', () => {
    const day = buildDay({ ...base, punches: [punch('09:50'), punch('12:30')] })!;
    expect(day.status).toBe('half_day');
    expect(day.flags).toContain('late');
  });

  it('WFH and client-site days keep their mode', () => {
    expect(
      buildDay({ ...base, punches: [punch('09:00', { mode: 'wfh', latitude: null })] })?.status,
    ).toBe('wfh');
    expect(buildDay({ ...base, punches: [punch('09:00', { mode: 'client_site' })] })?.status).toBe(
      'client_site',
    );
  });

  it('flags outside the geofence, no location, and a missing check-out on a past day', () => {
    const day = buildDay({
      ...base,
      punches: [punch('09:10', { outsideGeofence: true }), punch('09:12', { latitude: null })],
    })!;
    expect(day.flags).toEqual(expect.arrayContaining(['outside_geofence', 'no_location']));
    expect(buildDay({ ...base, punches: [punch('09:10')] })!.flags).toContain('missing_check_out');
    expect(buildDay({ ...base, today: base.day, punches: [punch('09:10')] })!.flags).not.toContain(
      'missing_check_out',
    );
  });

  it('no punch: holiday, weekly off, absent in the past, nothing yet today', () => {
    expect(buildDay({ ...base, holiday: { name: 'Pongal', optional: false } })?.status).toBe(
      'holiday',
    );
    expect(buildDay({ ...base, holiday: { name: 'Optional', optional: true } })?.status).toBe(
      'absent',
    );
    expect(buildDay({ ...base, working: false })?.status).toBe('weekly_off');
    expect(buildDay(base)?.status).toBe('absent');
    expect(buildDay({ ...base, today: base.day })).toBeNull();
  });

  it('working on a day off is recorded and flagged', () => {
    const day = buildDay({ ...base, working: false, punches: [punch('10:00'), punch('15:00')] })!;
    expect(day.status).toBe('present');
    expect(day.flags).toContain('worked_on_day_off');
  });
});

describe('helpers', () => {
  it('distance between two points in metres', () => {
    expect(distanceMetres({ lat: 13.0827, lng: 80.2707 }, { lat: 13.0827, lng: 80.2707 })).toBe(0);
    const d = distanceMetres({ lat: 13.0827, lng: 80.2707 }, { lat: 13.0917, lng: 80.2707 });
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });

  it('time of day in India and month ends', () => {
    expect(minutesInIndia(new Date('2026-11-09T04:00:00Z'))).toBe(9 * 60 + 30);
    expect(lastDayOf('2026-02')).toBe('2026-02-28');
    expect(lastDayOf('2028-02')).toBe('2028-02-29');
    expect(lastDayOf('2026-12')).toBe('2026-12-31');
  });
});
