import type { EnvService } from './config/env.service';
import { HealthController } from './health.controller';
import type { DatabasePreflightService } from './infrastructure/prisma/database-preflight.service';
import type { PrismaService } from './infrastructure/prisma/prisma.service';

function controllerWith(commit: string | undefined): HealthController {
  const env = {
    get: (key: string) => (key === 'RAILWAY_GIT_COMMIT_SHA' ? commit : undefined),
  } as unknown as EnvService;
  return new HealthController({} as PrismaService, {} as DatabasePreflightService, env);
}

describe('GET /health (ADR-034 section 11, C-9, T-16)', () => {
  it('exposes the commit as exactly 7 characters when the variable holds a valid SHA', () => {
    const body = controllerWith('65c2d01e3f5b7a9c1d2e4f60718293a4b5c6d7e8').check();

    expect(body.commit).toBe('65c2d01');
  });

  it('exposes null when the variable is missing', () => {
    expect(controllerWith(undefined).check().commit).toBeNull();
  });

  it.each(['feat/push-pasajero', 'not-a-sha', '65C2D01', ''])('exposes null when the value is %p', (value) => {
    expect(controllerWith(value).check().commit).toBeNull();
  });

  it('adds no other key than commit: nothing else of the build or of Railway', () => {
    const body = controllerWith('65c2d01e3f5b7a9c1d2e4f60718293a4b5c6d7e8').check();

    expect(Object.keys(body).sort()).toEqual(['commit', 'service', 'status', 'ts']);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('voyya-api');
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it('commit is not part of /health/db', async () => {
    const prisma = { $queryRaw: jest.fn(async () => [{ '?column?': 1 }]) } as unknown as PrismaService;
    const preflight = {
      isHealthy: () => true,
      getLastResult: () => null,
    } as unknown as DatabasePreflightService;
    const env = { get: () => '65c2d01e3f5b7a9c1d2e4f60718293a4b5c6d7e8' } as unknown as EnvService;
    const controller = new HealthController(prisma, preflight, env);
    const res = { status: jest.fn() } as unknown as Parameters<HealthController['checkDb']>[0];

    const body = await controller.checkDb(res);

    expect('commit' in body).toBe(false);
  });
});
