export const HOLIDAYS_PROVIDER = Symbol('HOLIDAYS_PROVIDER');

export interface HolidaysProvider {
  isHoliday(date: Date): boolean;
}
