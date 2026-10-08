import type { TripStatus } from '@voyyaa/shared';

const MS_PER_MINUTE = 60_000;
const WINDOWED_STATUSES: readonly TripStatus[] = ['assigned', 'driver_en_route'];

export interface FreeCancellationSubject {
  status: TripStatus;
  assignedAt: Date | null;
  updatedAt: Date;
}

export function freeCancellationDeadline(
  trip: FreeCancellationSubject,
  windowMin: number,
): Date | null {
  if (!WINDOWED_STATUSES.includes(trip.status)) return null;
  const reference = trip.assignedAt ?? trip.updatedAt;
  return new Date(reference.getTime() + windowMin * MS_PER_MINUTE);
}

export function isFreeCancellation(
  trip: FreeCancellationSubject,
  windowMin: number,
  receivedAt: Date,
): boolean {
  const deadline = freeCancellationDeadline(trip, windowMin);
  return deadline === null || receivedAt.getTime() <= deadline.getTime();
}
