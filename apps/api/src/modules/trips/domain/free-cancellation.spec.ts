import type { TripStatus } from '@voyyaa/shared';
import { freeCancellationDeadline, isFreeCancellation } from './free-cancellation';

const T0 = new Date('2026-10-08T15:00:00.000Z');
const WINDOW_MIN = 2;
const trip = (status: TripStatus, assignedAt: Date | null = T0, updatedAt: Date = T0) => ({
  status,
  assignedAt,
  updatedAt,
});

describe('freeCancellationDeadline', () => {
  it.each(['assigned', 'driver_en_route'] as const)('%s -> assignedAt + window', (status) => {
    expect(freeCancellationDeadline(trip(status), WINDOW_MIN)?.toISOString()).toBe(
      '2026-10-08T15:02:00.000Z',
    );
  });

  it('falls back to updatedAt when assignedAt is missing', () => {
    const updatedAt = new Date('2026-10-08T14:00:00.000Z');
    const deadline = freeCancellationDeadline(trip('assigned', null, updatedAt), WINDOW_MIN);
    expect(deadline?.toISOString()).toBe('2026-10-08T14:02:00.000Z');
  });

  it('prefers assignedAt over updatedAt', () => {
    const updatedAt = new Date('2026-10-08T16:00:00.000Z');
    expect(freeCancellationDeadline(trip('assigned', T0, updatedAt), WINDOW_MIN)?.toISOString()).toBe(
      '2026-10-08T15:02:00.000Z',
    );
  });

  it.each([
    'pending_assignment',
    'in_progress',
    'completed',
    'cancelled_by_passenger',
    'cancelled_by_driver',
    'no_driver',
    'no_show',
    'expired',
  ] as const)('%s -> null', (status) => {
    expect(freeCancellationDeadline(trip(status), WINDOW_MIN)).toBeNull();
  });

  it('honours a fractional window', () => {
    expect(freeCancellationDeadline(trip('assigned'), 0.5)?.toISOString()).toBe('2026-10-08T15:00:30.000Z');
  });
});

describe('isFreeCancellation (boundary: free when received at or before the deadline)', () => {
  const deadlineMs = T0.getTime() + WINDOW_MIN * 60_000;

  it('1 ms before the deadline -> free', () => {
    expect(isFreeCancellation(trip('assigned'), WINDOW_MIN, new Date(deadlineMs - 1))).toBe(true);
  });

  it('exactly at the deadline -> free', () => {
    expect(isFreeCancellation(trip('assigned'), WINDOW_MIN, new Date(deadlineMs))).toBe(true);
  });

  it('1 ms after the deadline -> penalty', () => {
    expect(isFreeCancellation(trip('driver_en_route'), WINDOW_MIN, new Date(deadlineMs + 1))).toBe(false);
  });

  it('pending_assignment is always free', () => {
    expect(
      isFreeCancellation(trip('pending_assignment', null), WINDOW_MIN, new Date(deadlineMs + 3_600_000)),
    ).toBe(true);
  });
});
