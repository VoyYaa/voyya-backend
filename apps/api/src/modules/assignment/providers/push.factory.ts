import { EnvService } from '../../../config/env.service';
import type { PushProvider } from '../ports/push-provider.port';
import { PushTokenRepository } from '../push-token.repository';
import { ExpoPushProvider } from './expo-push.provider';
import { NoopPushProvider } from './noop-push.provider';

export function createPushProvider(env: EnvService, tokens: PushTokenRepository): PushProvider {
  const accessToken = env.get('EXPO_ACCESS_TOKEN');

  if (accessToken) {
    return new ExpoPushProvider(env, tokens, accessToken);
  }

  if (env.get('NODE_ENV') === 'production') {
    throw new Error(
      'PUSH: missing Expo access token (EXPO_ACCESS_TOKEN) and the stub is forbidden in production. ' +
        'Configure it to enable driver assignment notifications.',
    );
  }

  return new NoopPushProvider(env);
}
