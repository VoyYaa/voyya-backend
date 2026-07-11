import type { TripStatus, PassengerUiState } from '@voyyaa/shared';

export function passengerUiState(status: TripStatus): PassengerUiState {
  switch (status) {
    case 'pending_assignment':
      return 'searching';
    case 'assigned':
    case 'driver_en_route':
    case 'in_progress':
    case 'completed':
      return 'driver_assigned';
    case 'no_driver':
    case 'cancelled_by_passenger':
    case 'cancelled_by_driver':
    case 'no_show':
    case 'expired':
      return 'no_driver';
  }
}
