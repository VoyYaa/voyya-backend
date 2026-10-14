import type { AssignmentNotification } from '@voyyaa/shared';
import type { PushLogRef, PushMessage, PushTransport } from '../../notifications/ports/push-transport.port';
import {
  AssignmentPushProvider,
  formatCop,
  toAssignmentPushMessage,
} from './assignment-push.provider';

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
    const serialized = JSON.stringify(toAssignmentPushMessage(NOTIFICATION));

    expect(serialized).not.toContain(NOTIFICATION.origin.address);
    expect(serialized).not.toContain('El Prado');
  });

  it('carries only the pointer fields in data', () => {
    expect(toAssignmentPushMessage(NOTIFICATION).data).toEqual({
      type: 'assignment_offer',
      assignment_id: 42,
      trip_request_id: 99,
      expires_at: '2026-09-25T12:00:15.000Z',
    });
  });

  it('formats the fare with thousands separator and the distance in meters', () => {
    expect(toAssignmentPushMessage(NOTIFICATION).body).toBe('$8.000 · recogida a 350 m');
  });

  it('keeps the delivery settings the driver always had and asks for no replacement', () => {
    expect(toAssignmentPushMessage(NOTIFICATION)).toMatchObject({
      title: 'Nuevo viaje disponible',
      channelId: 'assignment-offers',
      ttlSec: 15,
      priority: 'high',
      sound: 'default',
      replaceKey: null,
    });
  });
});

describe('formatCop', () => {
  it('adds a thousands separator without depending on toLocaleString', () => {
    expect(formatCop(8000)).toBe('8.000');
    expect(formatCop(950)).toBe('950');
    expect(formatCop(1234567)).toBe('1.234.567');
  });
});

describe('AssignmentPushProvider', () => {
  it('hands the driver message to the shared transport with a numeric driver reference', async () => {
    const send = jest.fn(async () => ({ outcome: 'disabled' as const }));
    const provider = new AssignmentPushProvider({ send } as unknown as PushTransport);

    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);

    const [userId, message, ref] = send.mock.calls[0] as unknown as [number, PushMessage, PushLogRef];
    expect(userId).toBe(7);
    expect(message).toEqual(toAssignmentPushMessage(NOTIFICATION));
    expect(ref).toEqual({ audience: 'driver', assignmentId: 42 });
  });

  it('never rejects, even if a transport breaks its own contract', async () => {
    const provider = new AssignmentPushProvider({
      send: jest.fn().mockRejectedValue(new Error('transport bug')),
    } as unknown as PushTransport);

    await expect(provider.sendAssignment({ driverId: 7 }, NOTIFICATION)).resolves.toBeUndefined();
  });
});
