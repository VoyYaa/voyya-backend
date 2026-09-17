import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const VICTIM_NATIONAL_ID = '900555001';
const DRIVER_PIN = '4321';

suite('Admin console — suspend-driver must stay inside the caller tenant (B-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  let victimCompanyId: number;
  let attackerCompanyId: number;
  let victimDriverId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });

    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: 9151 },
      update: {},
      create: {
        municipalityId: 9151,
        name: '_SuspendMuni',
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

    const victimCompany = await prisma.company.upsert({
      where: { taxId: '_suspend-victim-co' },
      update: { status: 'active' },
      create: {
        legalName: '_SuspendVictimCo',
        taxId: '_suspend-victim-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    victimCompanyId = victimCompany.companyId;

    const attackerCompany = await prisma.company.upsert({
      where: { taxId: '_suspend-attacker-co' },
      update: { status: 'active' },
      create: {
        legalName: '_SuspendAttackerCo',
        taxId: '_suspend-attacker-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    attackerCompanyId = attackerCompany.companyId;

    const vehicle = await prisma.runInTenant(victimCompanyId, (tx) =>
      tx.vehicle.upsert({
        where: { plate: '_SUS001' },
        update: { status: 'active', companyId: victimCompanyId },
        create: { plate: '_SUS001', companyId: victimCompanyId, status: 'active' },
      }),
    );

    const driverUser = await prisma.user.upsert({
      where: { phone: '_suspend-victim-driver' },
      update: {},
      create: {
        firstName: '_Suspend',
        lastName: 'Victim',
        phone: '_suspend-victim-driver',
        role: 'driver',
      },
    });
    victimDriverId = driverUser.userId;

    const pinHash = await bcrypt.hash(DRIVER_PIN, 4);

    await prisma.runInTenant(victimCompanyId, (tx) =>
      tx.driver.upsert({
        where: { driverId: victimDriverId },
        update: {
          companyId: victimCompanyId,
          pin: pinHash,
          status: 'off_shift',
          currentVehicleId: vehicle.vehicleId,
          pinDeliveredAt: new Date(),
        },
        create: {
          driverId: victimDriverId,
          companyId: victimCompanyId,
          nationalId: VICTIM_NATIONAL_ID,
          pin: pinHash,
          status: 'off_shift',
          currentVehicleId: vehicle.vehicleId,
          pinDeliveredAt: new Date(),
        },
      }),
    );
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function bearer(payload: { sub: number; role: string; companyId?: number }): string {
    const token = jwt.sign({
      sub: payload.sub,
      role: payload.role,
      type: 'access',
      ...(payload.companyId !== undefined ? { company_id: payload.companyId } : {}),
    });
    return `Bearer ${token}`;
  }

  async function loginVictimDriver(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/auth/driver/login')
      .send({ national_id: VICTIM_NATIONAL_ID, pin: DRIVER_PIN });
    expect(res.status).toBe(200);
    return res.body.tokens.refresh_token as string;
  }

  async function refreshStatus(refreshToken: string): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: refreshToken });
    return res.status;
  }

  it('the legacy /auth/admin/suspend-driver route is gone; a stranger cannot revoke a session through it', async () => {
    const refreshToken = await loginVictimDriver();

    const attackerAuth = bearer({ sub: 777001, role: 'admin', companyId: 999999 });
    const res = await request(app.getHttpServer())
      .post('/auth/admin/suspend-driver')
      .set('Authorization', attackerAuth)
      .send({ driver_id: victimDriverId, company_id: 999999, reason: 'suspended' });

    expect(res.status).toBe(404);
    expect(await refreshStatus(refreshToken)).toBe(200);
  });

  it('an admin from a different tenant cannot suspend a driver of another company -> 404 DRIVER_NOT_FOUND', async () => {
    const refreshToken = await loginVictimDriver();

    const attackerAuth = bearer({ sub: 777002, role: 'admin', companyId: attackerCompanyId });
    const res = await request(app.getHttpServer())
      .post(`/admin/drivers/${victimDriverId}/suspend`)
      .set('Authorization', attackerAuth)
      .send({ reason: 'suspended' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
    expect(await refreshStatus(refreshToken)).toBe(200);
  });

  it('an admin of the same tenant can suspend its own driver -> 200 ok and revokes all its sessions', async () => {
    const refreshToken = await loginVictimDriver();

    const legitAuth = bearer({ sub: 777003, role: 'admin', companyId: victimCompanyId });
    const res = await request(app.getHttpServer())
      .post(`/admin/drivers/${victimDriverId}/suspend`)
      .set('Authorization', legitAuth)
      .send({ reason: 'suspended' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refresh_token: refreshToken });
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body).toMatchObject({ code: 'REFRESH_REVOKED' });
  });

  it('a non-existent driver id within the same tenant -> 404 DRIVER_NOT_FOUND', async () => {
    const legitAuth = bearer({ sub: 777004, role: 'admin', companyId: victimCompanyId });
    const res = await request(app.getHttpServer())
      .post('/admin/drivers/999999999/suspend')
      .set('Authorization', legitAuth)
      .send({ reason: 'suspended' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });

  it('an invalid reason -> 400 INVALID_DATA', async () => {
    const legitAuth = bearer({ sub: 777005, role: 'admin', companyId: victimCompanyId });
    const res = await request(app.getHttpServer())
      .post(`/admin/drivers/${victimDriverId}/suspend`)
      .set('Authorization', legitAuth)
      .send({ reason: 'not-a-real-reason' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DATA' });
  });

  it('company_id in the body is ignored/rejected: the shared contract no longer accepts it as a scoping field', async () => {
    const legitAuth = bearer({ sub: 777006, role: 'admin', companyId: attackerCompanyId });
    const res = await request(app.getHttpServer())
      .post(`/admin/drivers/${victimDriverId}/suspend`)
      .set('Authorization', legitAuth)
      .send({ reason: 'suspended', company_id: victimCompanyId, driver_id: victimDriverId });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });
});
