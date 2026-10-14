jest.mock(
  'expo-server-sdk',
  () => ({
    Expo: class {
      static isExpoPushToken(): boolean {
        return true;
      }
      chunkPushNotifications<T>(messages: T[]): T[][] {
        return [messages];
      }
      async sendPushNotificationsAsync(): Promise<Array<{ status: 'ok'; id: string }>> {
        return [];
      }
    },
  }),
);

import { Logger } from '@nestjs/common';
import type { EnvService } from '../../../config/env.service';
import type { PushMessage } from '../ports/push-transport.port';
import type { PushTokenRepository } from '../push-token.repository';
import { ExpoPushTransport } from './expo-push.transport';
import { NoopPushTransport } from './noop-push.transport';
import { createPushTransport } from './push-transport.factory';

function env(vals: Record<string, unknown>): EnvService {
  return { get: (k: string) => vals[k] } as unknown as EnvService;
}

const tokens = {} as PushTokenRepository;

describe('createPushTransport (explicit selection)', () => {
  it('PUSH_PROVIDER=expo with token -> ExpoPushTransport (even in production)', () => {
    const transport = createPushTransport(
      env({ PUSH_PROVIDER: 'expo', EXPO_ACCESS_TOKEN: 'expo-token', NODE_ENV: 'production' }),
      tokens,
    );
    expect(transport).toBeInstanceOf(ExpoPushTransport);
  });

  it('a token with PUSH_PROVIDER=noop in development -> NoopPushTransport', () => {
    const transport = createPushTransport(
      env({ PUSH_PROVIDER: 'noop', EXPO_ACCESS_TOKEN: 'expo-token', NODE_ENV: 'development' }),
      tokens,
    );
    expect(transport).toBeInstanceOf(NoopPushTransport);
  });

  it('guard 2: PUSH_PROVIDER=expo without a token -> throws', () => {
    expect(() =>
      createPushTransport(env({ PUSH_PROVIDER: 'expo', NODE_ENV: 'development' }), tokens),
    ).toThrow(/EXPO_ACCESS_TOKEN/);
  });

  it('guard 1: noop in production -> fail-fast (throw)', () => {
    expect(() =>
      createPushTransport(env({ PUSH_PROVIDER: 'noop', NODE_ENV: 'production' }), tokens),
    ).toThrow(/forbidden in production/);
  });
});

describe('NoopPushTransport', () => {
  const message = { title: 't', body: 'b' } as unknown as PushMessage;
  let lines: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('guard 3: logs only outside production, with ids and no content, and reports disabled', async () => {
    const transport = new NoopPushTransport(env({ NODE_ENV: 'development' }));

    const driver = await transport.send(7, message, { audience: 'driver', assignmentId: 42 });
    const passenger = await transport.send(4529, message, {
      audience: 'passenger',
      tripRequestId: 17,
      type: 'trip_no_driver',
      occurredAtMs: 0,
    });

    expect(driver).toEqual({ outcome: 'disabled' });
    expect(passenger).toEqual({ outcome: 'disabled' });
    expect(lines).toEqual([
      '[push:noop] audience=driver driver=7 assignment=42',
      '[push:noop] audience=passenger passenger=4529 tripRequest=17 type=trip_no_driver',
    ]);
  });

  it('guard 3: in production it does not log at all', async () => {
    const transport = new NoopPushTransport(env({ NODE_ENV: 'production' }));

    const delivery = await transport.send(7, message, { audience: 'driver', assignmentId: 42 });

    expect(delivery).toEqual({ outcome: 'disabled' });
    expect(lines).toEqual([]);
  });
});
