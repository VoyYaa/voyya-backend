import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { SMS_PROVIDER } from '../src/modules/assignment/ports/sms-provider.port';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const phoneCache = new Map<number, string>();
const nationalIdCache = new Map<number, string>();
const emailCache = new Map<number, string>();
const plateCache = new Map<number, string>();

function cached(cache: Map<number, string>, n: number, gen: () => string): string {
  if (!cache.has(n)) cache.set(n, gen());
  return cache.get(n) as string;
}

function phoneFor(n: number): string {
  return cached(phoneCache, n, () => `3${randomInt(100_000_000, 999_999_999)}`);
}
function nationalIdFor(n: number): string {
  return cached(nationalIdCache, n, () => `9${randomInt(100_000_000, 999_999_999)}`);
}
function emailFor(n: number): string {
  return cached(emailCache, n, () => `driver.${randomInt(0, 1_000_000_000)}.${n}@voyya-e2e.test`);
}
function plateFor(n: number): string {
  return cached(plateCache, n, () => {
    const letters = `${LETTERS[randomInt(0, 26)]}${LETTERS[randomInt(0, 26)]}${LETTERS[randomInt(0, 26)]}`;
    const digits = String(randomInt(0, 1000)).padStart(3, '0');
    return `${letters}${digits}`;
  });
}

function extractPin(message: string): string {
  const match = /PIN (\d+)/.exec(message);
  if (!match) throw new Error(`Could not find PIN in message: ${message}`);
  return match[1] as string;
}

function createDto(n: number) {
  return {
    first_name: 'Conductor',
    last_name: `E2E${n}`,
    national_id: nationalIdFor(n),
    phone: phoneFor(n),
    email: emailFor(n),
    vehicle: { plate: plateFor(n), model: 'Chevrolet Spark' },
  };
}

suite('Admin console — driver onboarding and PIN delivery invariant (ADR-013)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let sms: { send: jest.Mock };
  let companyId: number;
  let adminAuth: string;

  let driver2Id: number;
  let deliveredPinN1: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    sms = { send: jest.fn().mockResolvedValue(undefined) };

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_PROVIDER)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9121 },
      update: {},
      create: {
        municipalityId: 9121,
        name: '_PinMuni',
        department: 'Test',
        coveragePolygon: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0, 1],
              [1, 1],
              [1, 0],
              [0, 0],
            ],
          ],
        },
        status: 'active',
      },
    });

    const company = await prisma.company.upsert({
      where: { taxId: '_pin-flow-co' },
      update: { status: 'active' },
      create: {
        legalName: '_PinFlowCo',
        taxId: '_pin-flow-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const token = jwt.sign({ sub: 1, role: 'admin', type: 'access', company_id: companyId });
    adminAuth = `Bearer ${token}`;
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('SMS ok -> 201, pin_delivery=sent, the PIN never travels in the response body', async () => {
    sms.send.mockResolvedValueOnce(undefined);

    const res = await request(app.getHttpServer())
      .post('/admin/drivers')
      .set('Authorization', adminAuth)
      .send(createDto(1));

    expect(res.status).toBe(201);
    expect(res.body.pin_delivery).toBe('sent');
    expect(res.body.pin_delivered_at).toEqual(expect.any(String));
    expect(res.body.status).toBe('off_shift');
    expect(res.body.vehicle.plate).toBe(plateFor(1));

    expect(sms.send).toHaveBeenCalledTimes(1);
    deliveredPinN1 = extractPin(sms.send.mock.calls[0][1] as string);
    expect(JSON.stringify(res.body)).not.toContain(deliveredPinN1);
    expect(JSON.stringify(res.body)).not.toMatch(/"pin"/i);
  });

  it('SMS fails -> 201 anyway, pin_delivery=failed, the driver and vehicle still exist', async () => {
    sms.send.mockRejectedValueOnce(new Error('twilio down'));

    const res = await request(app.getHttpServer())
      .post('/admin/drivers')
      .set('Authorization', adminAuth)
      .send(createDto(2));

    expect(res.status).toBe(201);
    expect(res.body.pin_delivery).toBe('failed');
    expect(res.body.pin_delivered_at).toBeNull();
    driver2Id = res.body.driver_id;

    const driver = await prisma.runInTenant(companyId, (tx) =>
      tx.driver.findUnique({ where: { driverId: driver2Id } }),
    );
    expect(driver).not.toBeNull();
    expect(driver?.pinDeliveredAt).toBeNull();
    const vehicle = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.findUnique({ where: { plate: plateFor(2) } }),
    );
    expect(vehicle).not.toBeNull();
  });

  describe('Zod validation (400) rejects a malformed body before it touches the database', () => {
    it('an invalid plate format -> 400 INVALID_DATA, no rows written', async () => {
      const before = await prisma.runInTenant(companyId, (tx) => tx.driver.count());
      const dto = { ...createDto(30), vehicle: { plate: 'not-a-plate', model: 'Renault Logan' } };

      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'vehicle.plate' })]),
      );
      expect(await prisma.runInTenant(companyId, (tx) => tx.driver.count())).toBe(before);
    });

    it('a missing vehicle -> 400 INVALID_DATA', async () => {
      const { vehicle: _omit, ...dto } = createDto(31);

      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
    });
  });

  describe('duplicates: the database is the referee, zero partial rows', () => {
    it('duplicate national_id -> 409 NATIONAL_ID_TAKEN', async () => {
      const dto = { ...createDto(3), national_id: nationalIdFor(1) };
      const before = await prisma.runInTenant(companyId, (tx) => tx.driver.count());

      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NATIONAL_ID_TAKEN' });
      expect(await prisma.runInTenant(companyId, (tx) => tx.driver.count())).toBe(before);
      expect(
        await prisma.runInTenant(companyId, (tx) =>
          tx.vehicle.findUnique({ where: { plate: plateFor(3) } }),
        ),
      ).toBeNull();
    });

    it('duplicate phone -> 409 PHONE_TAKEN', async () => {
      const dto = { ...createDto(4), phone: phoneFor(1) };
      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PHONE_TAKEN' });
    });

    it('duplicate email -> 409 EMAIL_TAKEN', async () => {
      const dto = { ...createDto(5), email: emailFor(1) };
      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'EMAIL_TAKEN' });
    });

    it('duplicate plate -> 409 PLATE_TAKEN', async () => {
      const dto = { ...createDto(6), vehicle: { plate: plateFor(1), model: 'Renault Logan' } };
      const res = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(dto);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLATE_TAKEN' });
    });
  });

  describe('driverLogin honours the pin_delivered_at invariant end to end', () => {
    it('the SMS-failed driver cannot log in even with the exact PIN that was generated -> 403 PIN_NOT_DELIVERED', async () => {
      sms.send.mockRejectedValueOnce(new Error('capture-only'));
      const probe = await request(app.getHttpServer())
        .post('/admin/drivers')
        .set('Authorization', adminAuth)
        .send(createDto(20));
      expect(probe.status).toBe(201);
      const generatedPin = extractPin(sms.send.mock.calls[0][1] as string);

      const res = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: nationalIdFor(20), pin: generatedPin });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'PIN_NOT_DELIVERED' });
    });

    it('resend delivers a new PIN; the new PIN logs in successfully', async () => {
      sms.send.mockResolvedValueOnce(undefined);

      const resend = await request(app.getHttpServer())
        .post(`/admin/drivers/${driver2Id}/pin/resend`)
        .set('Authorization', adminAuth)
        .send({});

      expect(resend.status).toBe(200);
      expect(resend.body.pin_delivery).toBe('sent');
      expect(resend.body.pin_delivered_at).toEqual(expect.any(String));
      expect(JSON.stringify(resend.body)).not.toMatch(/"pin"/i);

      const newPin = extractPin(sms.send.mock.calls[0][1] as string);

      const loginNew = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: nationalIdFor(2), pin: newPin });
      expect(loginNew.status).toBe(200);
      expect(loginNew.body.user.role).toBe('driver');
    });

    it('resend with a failing SMS on an already-delivered driver sets pin_delivered_at back to NULL', async () => {
      sms.send.mockRejectedValueOnce(new Error('twilio down again'));

      const target = await prisma.runInTenant(companyId, (tx) =>
        tx.driver.findFirst({
          where: { nationalId: nationalIdFor(1) },
          select: { driverId: true, pinDeliveredAt: true },
        }),
      );
      expect(target?.pinDeliveredAt).not.toBeNull();

      const resend = await request(app.getHttpServer())
        .post(`/admin/drivers/${target?.driverId}/pin/resend`)
        .set('Authorization', adminAuth)
        .send({});

      expect(resend.status).toBe(200);
      expect(resend.body.pin_delivery).toBe('failed');
      expect(resend.body.pin_delivered_at).toBeNull();

      const reloaded = await prisma.runInTenant(companyId, (tx) =>
        tx.driver.findUnique({ where: { driverId: target?.driverId } }),
      );
      expect(reloaded?.pinDeliveredAt).toBeNull();

      const loginWithOldPin = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: nationalIdFor(1), pin: deliveredPinN1 });
      expect(loginWithOldPin.status).toBe(401);
      expect(loginWithOldPin.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('resend for a driver outside the tenant -> 404 DRIVER_NOT_FOUND', async () => {
      const res = await request(app.getHttpServer())
        .post('/admin/drivers/999999999/pin/resend')
        .set('Authorization', adminAuth)
        .send({});
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
    });
  });
});
