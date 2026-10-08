import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';

const prismaStub = {
  onModuleInit: async () => undefined,
  onModuleDestroy: async () => undefined,
  $connect: async () => undefined,
  $disconnect: async () => undefined,
};

describe('Throttler scope (BUG-1: the hourly documents limit must not leak to the whole API)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves 40 requests to an unrelated route without a single 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await request(app.getHttpServer()).get('/health')).status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('does not attach the hourly documents limit to an unrelated route', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.headers['x-ratelimit-limit-affiliation_docs_hour']).toBeUndefined();
  });

  it('attaches the hourly 30 limit to the documents upload route and still enforces 5/min', async () => {
    const statuses: number[] = [];
    let hourlyLimit: string | undefined;
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app.getHttpServer()).post('/affiliation/documents');
      statuses.push(res.status);
      hourlyLimit ??= res.headers['x-ratelimit-limit-affiliation_docs_hour'];
    }
    expect(hourlyLimit).toBe('30');
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
