import type { AssignmentNotification } from '@voyyaa/shared';
import { formatCop, maskToken, toAssignmentPushMessage } from './expo-push.provider';

const NOTIFICATION: AssignmentNotification = {
  assignment_id: 42,
  trip_request_id: 99,
  origin: {
    address: 'Calle 50 #30-20, Barrio El Prado',
    lat: 6.9647,
    lng: -75.4197,
  },
  dropoff_neighborhood: 'El Prado',
  total_fare: 8000,
  distance_to_origin_m: 350,
  expires_at: '2026-09-25T12:00:15.000Z',
  seconds_to_respond: 15,
};

describe('toAssignmentPushMessage', () => {
  it('never includes the pickup address in the serialized payload', () => {
    const message = toAssignmentPushMessage(NOTIFICATION);
    const serialized = JSON.stringify(message);
    expect(serialized).not.toContain(NOTIFICATION.origin.address);
    expect(serialized).not.toContain('El Prado');
  });

  it('carries only the pointer fields in data', () => {
    const message = toAssignmentPushMessage(NOTIFICATION);
    expect(message.data).toEqual({
      type: 'assignment_offer',
      assignment_id: 42,
      trip_request_id: 99,
      expires_at: '2026-09-25T12:00:15.000Z',
    });
  });

  it('formats the fare with thousands separator and the distance in meters', () => {
    const message = toAssignmentPushMessage(NOTIFICATION);
    expect(message.body).toBe('$8.000 · recogida a 350 m');
  });
});

describe('formatCop', () => {
  it('adds a thousands separator without depending on toLocaleString', () => {
    expect(formatCop(8000)).toBe('8.000');
    expect(formatCop(950)).toBe('950');
    expect(formatCop(1234567)).toBe('1.234.567');
  });
});

describe('maskToken', () => {
  it('keeps only the last 6 characters', () => {
    expect(maskToken('ExponentPushToken[abcdefghij123456]')).toBe('…23456]');
  });

  it('does not mask tokens that are already short', () => {
    expect(maskToken('abcdef')).toBe('abcdef');
  });
});
