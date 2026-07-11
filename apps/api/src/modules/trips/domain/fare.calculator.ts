import type { FareBreakdown } from '@voyyaa/shared';
import type { HolidaysProvider } from '../holidays/holidays.provider';
import { isSundayInBogota, hourInBogota } from './bogota-time';

export interface FareParams {
  baseFare: number;
  nightSurchargePct: number;
  holidaySurchargePct: number;
  commissionPct: number;
}

export interface FareContext {
  date: Date;
}

export const NIGHT_START_HOUR = 21;
export const NIGHT_END_HOUR = 5;

export function isNightTime(date: Date): boolean {
  const hour = hourInBogota(date);
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

export function isHoliday(date: Date, holidays: HolidaysProvider): boolean {
  return isSundayInBogota(date) || holidays.isHoliday(date);
}

const percentage = (base: number, pct: number): number => Math.round((base * pct) / 100);

export function calculateFare(
  params: FareParams,
  ctx: FareContext,
  holidays: HolidaysProvider,
): FareBreakdown {
  const baseFare = Math.round(params.baseFare);

  const nightSurcharge = isNightTime(ctx.date)
    ? percentage(baseFare, params.nightSurchargePct)
    : 0;

  const holidaySurcharge = isHoliday(ctx.date, holidays)
    ? percentage(baseFare, params.holidaySurchargePct)
    : 0;

  const total = baseFare + nightSurcharge + holidaySurcharge;
  const commission = percentage(total, params.commissionPct);

  return {
    base_fare: baseFare,
    night_surcharge: nightSurcharge,
    holiday_surcharge: holidaySurcharge,
    total,
    commission,
    currency: 'COP',
  };
}
