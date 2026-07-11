import { ColombiaHolidaysService } from './colombia-holidays.service';

function bogota(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, 0, 0));
}

describe('ColombiaHolidaysService', () => {
  const svc = new ColombiaHolidaysService();

  it('recognizes a fixed 2026 holiday (July 20, Independence)', () => {
    expect(svc.isHoliday(bogota(2026, 7, 20, 12))).toBe(true);
  });

  it('recognizes a moved 2026 holiday (Epiphany -> January 12)', () => {
    expect(svc.isHoliday(bogota(2026, 1, 12, 8))).toBe(true);
    expect(svc.isHoliday(bogota(2026, 1, 6, 8))).toBe(false);
  });

  it('recognizes a 2027 holiday (January 1)', () => {
    expect(svc.isHoliday(bogota(2027, 1, 1, 9))).toBe(true);
  });

  it('a regular weekday is not a holiday', () => {
    expect(svc.isHoliday(bogota(2026, 7, 15, 12))).toBe(false);
  });

  it('respects the timezone boundary (23:00 Bogota on Jul 20 is still a holiday)', () => {
    expect(svc.isHoliday(bogota(2026, 7, 20, 23))).toBe(true);
  });
});
