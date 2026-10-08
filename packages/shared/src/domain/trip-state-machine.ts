import {
  type TripStatus,
  TRIP_STATUS_TRANSITIONS,
  canTransitionTripStatus,
} from '../contracts/trips';
import {
  type AssignmentStatus,
  ASSIGNMENT_STATUS_TRANSITIONS,
  canTransitionAssignmentStatus,
} from '../contracts/assignment';

export class InvalidTransitionError extends Error {
  constructor(
    public readonly machine: 'tripRequest' | 'assignment',
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid transition in ${machine}: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export const TripStateMachine = {
  tripRequest: {
    transitions: TRIP_STATUS_TRANSITIONS,
    canTransition: canTransitionTripStatus,
    next: (from: TripStatus): readonly TripStatus[] => TRIP_STATUS_TRANSITIONS[from],
    assert: (from: TripStatus, to: TripStatus): void => {
      if (!canTransitionTripStatus(from, to)) {
        throw new InvalidTransitionError('tripRequest', from, to);
      }
    },
  },
  assignment: {
    transitions: ASSIGNMENT_STATUS_TRANSITIONS,
    canTransition: canTransitionAssignmentStatus,
    next: (from: AssignmentStatus): readonly AssignmentStatus[] =>
      ASSIGNMENT_STATUS_TRANSITIONS[from],
    assert: (from: AssignmentStatus, to: AssignmentStatus): void => {
      if (!canTransitionAssignmentStatus(from, to)) {
        throw new InvalidTransitionError('assignment', from, to);
      }
    },
  },
} as const;

export const TERMINAL_TRIP_STATUSES: readonly TripStatus[] = [
  'completed',
  'cancelled_by_passenger',
  'cancelled_by_driver',
  'no_driver',
  'no_show',
  'expired',
];

export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = [
  'pending_assignment',
  'assigned',
  'driver_en_route',
  'in_progress',
];

export function isTerminalTripStatus(status: TripStatus): boolean {
  return TERMINAL_TRIP_STATUSES.includes(status);
}

export function isActiveTripStatus(status: TripStatus): boolean {
  return ACTIVE_TRIP_STATUSES.includes(status);
}
