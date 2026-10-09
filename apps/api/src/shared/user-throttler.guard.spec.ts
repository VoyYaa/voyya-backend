import {
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  type INestApplication,
  Post,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { buildThrottlers } from './throttlers';
import { PER_USER_LIMITS, PerUserLimit } from './user-throttler.guard';

class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: { userId: number } }>();
    const header = req.headers['x-user'];
    if (header) req.user = { userId: Number(header) };
    return true;
  }
}

@Controller()
class ProbeController {
  @Get('status')
  @PerUserLimit(PER_USER_LIMITS.tripStatus)
  status(): { ok: true } {
    return { ok: true };
  }

  @Get('home')
  @PerUserLimit(PER_USER_LIMITS.driverHome)
  home(): { ok: true } {
    return { ok: true };
  }

  @Post('location')
  @PerUserLimit(PER_USER_LIMITS.driverLocation)
  location(): { ok: true } {
    return { ok: true };
  }

  @Post('start')
  @PerUserLimit(PER_USER_LIMITS.tripStart)
  start(): { ok: true } {
    return { ok: true };
  }

  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }
}

describe('per-user limits (ADR-033 C-3): the pattern of MD-13 without the global limit per IP', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlers({ ttlMs: 60_000, limit: 100 }))],
      controllers: [ProbeController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: HeaderAuthGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  const hit = (method: 'get' | 'post', path: string, user: number) =>
    http[method](path).set('x-user', String(user));

  async function statuses(method: 'get' | 'post', path: string, user: number, times: number): Promise<number[]> {
    const result: number[] = [];
    for (let i = 0; i < times; i += 1) result.push((await hit(method, path, user)).status);
    return result;
  }

  it.each([
    ['get', '/status', 30, 1001],
    ['get', '/home', 30, 1002],
    ['post', '/location', 12, 1003],
    ['post', '/start', 10, 1004],
  ] as const)('%s %s allows %i requests per minute per user and then answers 429', async (method, path, limit, user) => {
    const result = await statuses(method, path, user, limit + 2);

    expect(result.slice(0, limit).every((s) => s !== 429)).toBe(true);
    expect(result.slice(limit)).toEqual([429, 429]);
  });

  it('two users behind the same IP do not block each other', async () => {
    await statuses('post', '/start', 2001, 12);

    const other = await hit('post', '/start', 2002);

    expect(other.status).not.toBe(429);
    expect((await hit('post', '/start', 2001)).status).toBe(429);
  });

  it('the limit is not the global limit per IP: 40 users of the same IP, 3 requests each, never reach 429', async () => {
    const all: number[] = [];
    for (let user = 3000; user < 3040; user += 1) all.push(...(await statuses('get', '/status', user, 3)));

    expect(all.filter((s) => s === 429)).toHaveLength(0);
  });

  it('each route keeps its own count for the same user', async () => {
    await statuses('post', '/start', 4001, 11);

    expect((await hit('post', '/location', 4001)).status).not.toBe(429);
    expect((await hit('get', '/status', 4001)).status).not.toBe(429);
  });

  it('the 429 carries Retry-After so the apps can wait the right time', async () => {
    await statuses('post', '/start', 5001, 10);

    const blocked = await hit('post', '/start', 5001);

    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
  });

  it('routes without the decorator keep the global limit per IP', async () => {
    const result: number[] = [];
    for (let i = 0; i < 102; i += 1) result.push((await http.get('/plain')).status);

    expect(result.slice(0, 100).every((s) => s === 200)).toBe(true);
    expect(result.slice(100)).toEqual([429, 429]);
  });
});
