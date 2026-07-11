import { isSundayInBogota, bogotaDateISO, hourInBogota } from './bogota-time';

function bogota(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, 0, 0));
}

describe('hourInBogota', () => {
  it('converts to Bogota hour (UTC-5) regardless of the process timezone', () => {
    expect(hourInBogota(bogota(2026, 1, 5, 22))).toBe(22);
    expect(hourInBogota(bogota(2026, 1, 5, 0))).toBe(0);
    expect(hourInBogota(bogota(2026, 1, 5, 5))).toBe(5);
  });
});

describe('bogotaDateISO', () => {
  it('returns YYYY-MM-DD in Bogota respecting the day boundary', () => {
    expect(bogotaDateISO(bogota(2026, 7, 20, 23))).toBe('2026-07-20');
    expect(bogotaDateISO(bogota(2026, 7, 20, 12))).toBe('2026-07-20');
  });
});

describe('isSundayInBogota', () => {
  it('detects sunday in Bogota', () => {
    expect(isSundayInBogota(bogota(2026, 1, 4, 12))).toBe(true);
    expect(isSundayInBogota(bogota(2026, 1, 5, 12))).toBe(false);
  });
});
