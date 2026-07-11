export const BOGOTA_TZ = 'America/Bogota';

export function hourInBogota(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BOGOTA_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return h === 24 ? 0 : h;
}

export function bogotaDateISO(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BOGOTA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function isSundayInBogota(date: Date): boolean {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: BOGOTA_TZ,
    weekday: 'short',
  }).format(date);
  return wd === 'Sun';
}
