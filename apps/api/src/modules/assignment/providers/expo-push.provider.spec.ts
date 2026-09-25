import type { ExpoPushTicket } from 'expo-server-sdk';
import type { AssignmentNotification } from '@voyyaa/shared';
import type { EnvService } from '../../../config/env.service';
import type { PushTokenRepository } from '../push-token.repository';

let sendResult: (() => Promise<ExpoPushTicket[]>) | ExpoPushTicket[] = [];
let sendCallCount = 0;

jest.mock(
  'expo-server-sdk',
  () => ({
    Expo: class {
      constructor(_opts: unknown) {}
      static isExpoPushToken(token: string): boolean {
        return typeof token === 'string' && token.startsWith('ExponentPushToken[');
      }
      chunkPushNotifications<T>(messages: T[]): T[][] {
        return [messages];
      }
      async sendPushNotificationsAsync(): Promise<ExpoPushTicket[]> {
        sendCallCount += 1;
        return typeof sendResult === 'function' ? sendResult() : sendResult;
      }
    },
  }),
  { virtual: true },
);

import { ExpoPushProvider, formatCop, maskToken, toAssignmentPushMessage } from './expo-push.provider';

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

function fakeEnv(pushSendTimeoutMs: number): EnvService {
  return { get: (k: string) => (k === 'PUSH_SEND_TIMEOUT_MS' ? pushSendTimeoutMs : undefined) } as unknown as EnvService;
}

function fakeTokens(overrides: Partial<PushTokenRepository> = {}): PushTokenRepository {
  return {
    listByUser: jest.fn().mockResolvedValue(['ExponentPushToken[abcdefghij123456]']),
    drop: jest.fn().mockResolvedValue(undefined),
    revoke: jest.fn().mockResolvedValue(undefined),
    register: jest.fn().mockResolvedValue(undefined),
    purgeStale: jest.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as PushTokenRepository;
}

function errorTicket(error: NonNullable<Extract<ExpoPushTicket, { status: 'error' }>['details']>['error']): ExpoPushTicket {
  return { status: 'error', message: error ?? 'unknown', details: { error } };
}

describe('ExpoPushProvider.sendAssignment · failure modes (ADR-022 §3.2, §3.5, §10.5 items 4-8)', () => {
  beforeEach(() => {
    sendResult = [];
    sendCallCount = 0;
  });

  it('DeviceNotRegistered ticket -> the token row is physically deleted (item 4)', async () => {
    sendResult = [errorTicket('DeviceNotRegistered')];
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');

    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);

    expect(tokens.drop).toHaveBeenCalledWith('ExponentPushToken[abcdefghij123456]');
  });

  it('MismatchSenderId ticket -> the token row is physically deleted (§3.5)', async () => {
    sendResult = [errorTicket('MismatchSenderId')];
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');

    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);

    expect(tokens.drop).toHaveBeenCalledWith('ExponentPushToken[abcdefghij123456]');
  });

  it('InvalidCredentials ticket -> the token is NOT deleted; it is our misconfiguration, not the device (item 5)', async () => {
    sendResult = [errorTicket('InvalidCredentials')];
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');

    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);

    expect(tokens.drop).not.toHaveBeenCalled();
  });

  it('MessageTooBig and MessageRateExceeded tickets also leave the token untouched (§3.5)', async () => {
    sendResult = [errorTicket('MessageTooBig')];
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');
    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);
    expect(tokens.drop).not.toHaveBeenCalled();

    sendResult = [errorTicket('MessageRateExceeded')];
    const tokens2 = fakeTokens();
    const provider2 = new ExpoPushProvider(fakeEnv(3000), tokens2, 'expo-token');
    await provider2.sendAssignment({ driverId: 7 }, NOTIFICATION);
    expect(tokens2.drop).not.toHaveBeenCalled();
  });

  it('sendAssignment never rejects, even when the SDK throws (item 6)', async () => {
    sendResult = () => Promise.reject(new Error('exp.host is down'));
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');

    await expect(provider.sendAssignment({ driverId: 7 }, NOTIFICATION)).resolves.toBeUndefined();
  });

  it('bounds a hanging SDK call to PUSH_SEND_TIMEOUT_MS instead of blocking the caller (item 7)', async () => {
    sendResult = () => new Promise<ExpoPushTicket[]>(() => {});
    const tokens = fakeTokens();
    const provider = new ExpoPushProvider(fakeEnv(30), tokens, 'expo-token');

    const start = Date.now();
    await provider.sendAssignment({ driverId: 7 }, NOTIFICATION);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(1000);
  });

  it('no token registered -> resolves without calling the Expo SDK; it is not an error (item 8)', async () => {
    const tokens = fakeTokens({ listByUser: jest.fn().mockResolvedValue([]) });
    const provider = new ExpoPushProvider(fakeEnv(3000), tokens, 'expo-token');

    await expect(provider.sendAssignment({ driverId: 7 }, NOTIFICATION)).resolves.toBeUndefined();
    expect(sendCallCount).toBe(0);
  });
});
