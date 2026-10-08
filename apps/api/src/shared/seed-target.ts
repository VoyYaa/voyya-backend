export const DEV_DRIVER_PIN = '1234';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOST_OVERRIDE_PARAMS = ['host', 'hostaddr'];

export function isProvablyLocalSeedTarget(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return false;
  if (!env.DATABASE_URL) return false;
  try {
    const url = new URL(env.DATABASE_URL);
    const hasHostOverride = HOST_OVERRIDE_PARAMS.some((param) => url.searchParams.has(param));
    return LOCAL_HOSTS.has(url.hostname) && !hasHostOverride;
  } catch {
    return false;
  }
}

export function assertSeedTargetIsLocal(env: NodeJS.ProcessEnv): void {
  if (isProvablyLocalSeedTarget(env)) return;
  throw new Error(
    'El seed solo corre contra una base local demostrable (DATABASE_URL en localhost/127.0.0.1/[::1] y NODE_ENV distinto de production). En producción se provisiona con scripts/provision-company.ts',
  );
}

export function resolveSeedDriverPin(env: NodeJS.ProcessEnv): string {
  assertSeedTargetIsLocal(env);
  return DEV_DRIVER_PIN;
}
