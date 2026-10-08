import type { EnvService } from '../../config/env.service';

export function lockoutAfterFailure(env: EnvService, failedAttempts: number): Date | null {
  const attempts = failedAttempts + 1;
  if (attempts < env.get('LOGIN_MAX_ATTEMPTS')) return null;
  return new Date(Date.now() + env.get('LOGIN_BLOCK_MINUTES') * 60_000);
}
