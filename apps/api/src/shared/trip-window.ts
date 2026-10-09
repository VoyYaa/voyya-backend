import type { TripStatus } from '@voyyaa/shared';

export const TRIP_WINDOW_STATUSES: readonly TripStatus[] = ['assigned', 'driver_en_route'];

export function isInTripWindow(status: TripStatus): boolean {
  return TRIP_WINDOW_STATUSES.includes(status);
}
