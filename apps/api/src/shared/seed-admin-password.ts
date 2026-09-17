export const DEV_ADMIN_PASSWORD_PLACEHOLDER = 'DEV_ONLY_change_me_1234!';

export function resolveSeedAdminPassword(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.SEED_ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (env.NODE_ENV === 'production') {
    throw new Error('SEED_ADMIN_PASSWORD es obligatoria cuando NODE_ENV=production');
  }
  return DEV_ADMIN_PASSWORD_PLACEHOLDER;
}
