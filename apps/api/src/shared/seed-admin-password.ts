import { assertSeedTargetIsLocal } from './seed-target';

export const DEV_ADMIN_PASSWORD_PLACEHOLDER = 'DEV_ONLY_change_me_1234!';

export function resolveSeedAdminPassword(env: NodeJS.ProcessEnv): string {
  assertSeedTargetIsLocal(env);
  const fromEnv = env.SEED_ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEV_ADMIN_PASSWORD_PLACEHOLDER;
}
