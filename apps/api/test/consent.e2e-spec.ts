import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LOCATION_NOTICE_VERSION } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('POST/GET /consents over real HTTP (ADR-019 §6/§9.3)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passengerAId: number;
  let passengerBId: number;

  const runId = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.AUTH_DEV_HEADERS = 'true';
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);

    const userA = await prisma.user.upsert({
      where: { phone: `_consent-${runId}-a` },
      update: {},
      create: { firstName: '_Consent', lastName: 'A', phone: `_consent-${runId}-a`, role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: userA.userId },
      update: {},
      create: { passengerId: userA.userId },
    });
    passengerAId = userA.userId;

    const userB = await prisma.user.upsert({
      where: { phone: `_consent-${runId}-b` },
      update: {},
      create: { firstName: '_Consent', lastName: 'B', phone: `_consent-${runId}-b`, role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: userB.userId },
      update: {},
      create: { passengerId: userB.userId },
    });
    passengerBId = userB.userId;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  }, 20_000);

  function headers(passengerId: number): Record<string, string> {
    return { 'x-passenger-id': String(passengerId) };
  }

  it('no auth -> 401 SESSION_REQUIRED', async () => {
    const res = await request(app.getHttpServer()).get('/consents');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'SESSION_REQUIRED' });
  });

  it('POST /consents grants a consent and returns it as 200 (idempotent, not 201)', async () => {
    const res = await request(app.getHttpServer())
      .post('/consents')
      .set(headers(passengerAId))
      .send({ purpose: 'location', notice_version: LOCATION_NOTICE_VERSION });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      purpose: 'location',
      notice_version: LOCATION_NOTICE_VERSION,
    });
    expect(res.body.granted_at).toEqual(expect.any(String));
  });

  it('repeating POST /consents with the same tuple keeps the original granted_at', async () => {
    const first = await request(app.getHttpServer())
      .post('/consents')
      .set(headers(passengerBId))
      .send({ purpose: 'location', notice_version: LOCATION_NOTICE_VERSION });
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .post('/consents')
      .set(headers(passengerBId))
      .send({ purpose: 'location', notice_version: LOCATION_NOTICE_VERSION });
    expect(second.status).toBe(200);

    expect(second.body.granted_at).toBe(first.body.granted_at);
  });

  it('GET /consents returns only the requesting user consents', async () => {
    const res = await request(app.getHttpServer())
      .get('/consents')
      .set(headers(passengerAId));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      purpose: 'location',
      notice_version: LOCATION_NOTICE_VERSION,
    });
  });

  it('GET /consents for a user with no consents yet returns an empty list', async () => {
    const userC = await prisma.user.upsert({
      where: { phone: `_consent-${runId}-c` },
      update: {},
      create: { firstName: '_Consent', lastName: 'C', phone: `_consent-${runId}-c`, role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: userC.userId },
      update: {},
      create: { passengerId: userC.userId },
    });

    const res = await request(app.getHttpServer())
      .get('/consents')
      .set(headers(userC.userId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /consents with an invalid notice_version -> 400 INVALID_DATA', async () => {
    const res = await request(app.getHttpServer())
      .post('/consents')
      .set(headers(passengerAId))
      .send({ purpose: 'location', notice_version: 'BAD VERSION' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
  });
});
