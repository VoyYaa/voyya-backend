import { EnvService } from '../../../config/env.service';
import type { PushTransport } from '../ports/push-transport.port';
import { PushTokenRepository } from '../push-token.repository';
import { ExpoPushTransport } from './expo-push.transport';
import { NoopPushTransport } from './noop-push.transport';

export function createPushTransport(env: EnvService, tokens: PushTokenRepository): PushTransport {
  if (env.get('PUSH_PROVIDER') === 'expo') {
    const accessToken = env.get('EXPO_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('PUSH: PUSH_PROVIDER=expo requires EXPO_ACCESS_TOKEN.');
    }
    return new ExpoPushTransport(env, tokens, accessToken);
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error('PUSH: the stub is forbidden in production. Set PUSH_PROVIDER=expo.');
  }

  return new NoopPushTransport(env);
}
