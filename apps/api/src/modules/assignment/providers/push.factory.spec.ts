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
  { virtual: true },
);

import type { EnvService } from '../../../config/env.service';
import { ExpoPushProvider } from './expo-push.provider';
import { NoopPushProvider } from './noop-push.provider';
import { createPushProvider } from './push.factory';
import type { PushTokenRepository } from '../push-token.repository';

function env(vals: Record<string, unknown>): EnvService {
  return { get: (k: string) => vals[k] } as unknown as EnvService;
}

const tokens = {} as PushTokenRepository;

describe('createPushProvider (explicit selection)', () => {
  it('PUSH_PROVIDER=expo with token -> ExpoPushProvider (even in production)', () => {
    const p = createPushProvider(
      env({ PUSH_PROVIDER: 'expo', EXPO_ACCESS_TOKEN: 'expo-token', NODE_ENV: 'production' }),
      tokens,
    );
    expect(p).toBeInstanceOf(ExpoPushProvider);
  });

  it('a token with PUSH_PROVIDER=noop in development -> NoopPushProvider', () => {
    const p = createPushProvider(
      env({ PUSH_PROVIDER: 'noop', EXPO_ACCESS_TOKEN: 'expo-token', NODE_ENV: 'development' }),
      tokens,
    );
    expect(p).toBeInstanceOf(NoopPushProvider);
  });

  it('PUSH_PROVIDER=expo without a token -> throws', () => {
    expect(() =>
      createPushProvider(env({ PUSH_PROVIDER: 'expo', NODE_ENV: 'development' }), tokens),
    ).toThrow();
  });

  it('noop in production -> fail-fast (throw)', () => {
    expect(() =>
      createPushProvider(env({ PUSH_PROVIDER: 'noop', NODE_ENV: 'production' }), tokens),
    ).toThrow();
  });
});
