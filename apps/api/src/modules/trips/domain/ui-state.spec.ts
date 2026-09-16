import { passengerUiState } from './ui-state';

describe('passengerUiState', () => {
  it('pending_assignment -> searching', () => {
    expect(passengerUiState('pending_assignment', null)).toBe('searching');
  });

  it('assigned -> driver_assigned', () => {
    expect(passengerUiState('assigned', null)).toBe('driver_assigned');
  });

  it('driver_en_route without arrival -> driver_en_route', () => {
    expect(passengerUiState('driver_en_route', null)).toBe('driver_en_route');
  });

  it('driver_en_route with arrival -> driver_waiting', () => {
    expect(passengerUiState('driver_en_route', new Date())).toBe('driver_waiting');
  });

  it('in_progress -> trip_in_progress', () => {
    expect(passengerUiState('in_progress', null)).toBe('trip_in_progress');
  });

  it('completed -> trip_completed', () => {
    expect(passengerUiState('completed', null)).toBe('trip_completed');
  });

  it('no_show -> trip_no_show', () => {
    expect(passengerUiState('no_show', new Date())).toBe('trip_no_show');
  });

  it.each(['cancelled_by_passenger', 'cancelled_by_driver', 'expired'] as const)(
    '%s -> trip_cancelled',
    (status) => {
      expect(passengerUiState(status, null)).toBe('trip_cancelled');
    },
  );

  it('no_driver -> no_driver', () => {
    expect(passengerUiState('no_driver', null)).toBe('no_driver');
  });
});
