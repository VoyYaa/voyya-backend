import type { HolidaysProvider } from '../holidays/holidays.provider';
import {
  calculateFare,
  isHoliday,
  isNightTime,
  type FareParams,
} from './fare.calculator';

const PARAMS: FareParams = {
  baseFare: 8000,
  nightSurchargePct: 20,
  holidaySurchargePct: 15,
  commissionPct: 8,
};

const NO_HOLIDAYS: HolidaysProvider = { isHoliday: () => false };
const ALWAYS_HOLIDAY: HolidaysProvider = { isHoliday: () => true };

function bogota(year: number, month: number, day: number, hour: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 5, 0, 0));
}
const monday = (h: number): Date => bogota(2026, 1, 5, h);
const sunday = (h: number): Date => bogota(2026, 1, 4, h);

describe('isNightTime (Bogota hour)', () => {
  it.each([
    [22, true],
    [21, true],
    [3, true],
    [4, true],
    [5, false],
    [12, false],
    [20, false],
  ])('Bogota %ih -> night=%s', (hour, expected) => {
    expect(isNightTime(monday(hour))).toBe(expected);
  });
});

describe('isHoliday (Bogota + holidays port)', () => {
  it('sunday is a holiday (even if the port says no)', () => {
    expect(isHoliday(sunday(12), NO_HOLIDAYS)).toBe(true);
  });
  it('weekday without calendar holiday is not a holiday', () => {
    expect(isHoliday(monday(12), NO_HOLIDAYS)).toBe(false);
  });
  it('calendar holiday even on a weekday', () => {
    expect(isHoliday(monday(12), ALWAYS_HOLIDAY)).toBe(true);
  });
});

describe('calculateFare', () => {
  it('weekday DAY: only base fare', () => {
    const t = calculateFare(PARAMS, { date: monday(12) }, NO_HOLIDAYS);
    expect(t).toEqual({
      base_fare: 8000,
      night_surcharge: 0,
      holiday_surcharge: 0,
      total: 8000,
      commission: 640,
      currency: 'COP',
    });
  });

  it('weekday NIGHT: +20% night', () => {
    const t = calculateFare(PARAMS, { date: monday(22) }, NO_HOLIDAYS);
    expect(t.night_surcharge).toBe(1600);
    expect(t.holiday_surcharge).toBe(0);
    expect(t.total).toBe(9600);
    expect(t.commission).toBe(768);
  });

  it('HOLIDAY (sunday) day: +15% holiday', () => {
    const t = calculateFare(PARAMS, { date: sunday(12) }, NO_HOLIDAYS);
    expect(t.night_surcharge).toBe(0);
    expect(t.holiday_surcharge).toBe(1200);
    expect(t.total).toBe(9200);
  });

  it('calendar HOLIDAY (weekday) day: +15% via port', () => {
    const t = calculateFare(PARAMS, { date: monday(12) }, ALWAYS_HOLIDAY);
    expect(t.holiday_surcharge).toBe(1200);
    expect(t.total).toBe(9200);
  });

  it('HOLIDAY + NIGHT (sunday 22h): both surcharges', () => {
    const t = calculateFare(PARAMS, { date: sunday(22) }, NO_HOLIDAYS);
    expect(t.night_surcharge).toBe(1600);
    expect(t.holiday_surcharge).toBe(1200);
    expect(t.total).toBe(10800);
    expect(t.commission).toBe(864);
  });

  it('commission is recorded on the total (not added to what the passenger pays)', () => {
    const t = calculateFare(PARAMS, { date: monday(12) }, NO_HOLIDAYS);
    expect(t.total).toBe(t.base_fare + t.night_surcharge + t.holiday_surcharge);
    expect(t.commission).toBeLessThan(t.total);
  });
});
