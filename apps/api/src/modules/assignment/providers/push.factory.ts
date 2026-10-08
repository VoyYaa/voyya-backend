import { EnvService } from '../../../config/env.service';
import type { PushProvider } from '../ports/push-provider.port';
import { PushTokenRepository } from '../push-token.repository';
import { ExpoPushProvider } from './expo-push.provider';
import { NoopPushProvider } from './noop-push.provider';

export function createPushProvider(env: EnvService, tokens: PushTokenRepository): PushProvider {
  if (env.get('PUSH_PROVIDER') === 'expo') {
    const accessToken = env.get('EXPO_ACCESS_TOKEN');
    if (!accessToken) {
      throw new Error('PUSH: PUSH_PROVIDER=expo requires EXPO_ACCESS_TOKEN.');
    }
    return new ExpoPushProvider(env, tokens, accessToken);
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error('PUSH: the stub is forbidden in production. Set PUSH_PROVIDER=expo.');
  }

  return new NoopPushProvider(env);
}
