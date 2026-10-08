import type { DriverPinStatus } from '@voyyaa/shared';

export interface DriverPinState {
  pinDeliveredAt: Date | null;
  pinMustChange: boolean;
  temporaryPinExpiresAt: Date | null;
}

export function driverPinStatus(state: DriverPinState, now: number): DriverPinStatus {
  if (state.pinDeliveredAt === null) return 'not_delivered';
  if (!state.pinMustChange) return 'personal';
  const expired =
    state.temporaryPinExpiresAt !== null && state.temporaryPinExpiresAt.getTime() <= now;
  return expired ? 'temporary_expired' : 'temporary';
}
