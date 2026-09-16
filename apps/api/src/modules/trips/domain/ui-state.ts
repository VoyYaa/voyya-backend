import type { TripStatus, PassengerUiState } from '@voyyaa/shared';

export function passengerUiState(
  status: TripStatus,
  arrivedAt: Date | null,
): PassengerUiState {
  switch (status) {
    case 'pending_assignment':
      return 'searching';
    case 'assigned':
      return 'driver_assigned';
    case 'driver_en_route':
      return arrivedAt === null ? 'driver_en_route' : 'driver_waiting';
    case 'in_progress':
      return 'trip_in_progress';
    case 'completed':
      return 'trip_completed';
    case 'no_show':
      return 'trip_no_show';
    case 'cancelled_by_passenger':
    case 'cancelled_by_driver':
    case 'expired':
      return 'trip_cancelled';
    case 'no_driver':
      return 'no_driver';
  }
}
