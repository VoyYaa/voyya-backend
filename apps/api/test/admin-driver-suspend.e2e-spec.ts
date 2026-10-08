import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { RefreshTokenService } from '../src/modules/auth/refresh-token.service';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const VICTIM_NATIONAL_ID = '900555001';
const DRIVER_PIN = '4321';

suite('Admin console — suspend-driver must stay inside the caller tenant (B-02)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let refreshTokens: RefreshTokenService;

  let victimCompanyId: number;
  let attackerCompanyId: number;
  let victimDriverId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.LOCATION_STALE_MIN = '0';
    process.env.LOCATION_PURGE_HOURS = '0';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    refreshTokens = moduleRef.get(RefreshTokenService);

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

  describe('C-01: suspension really blocks the driver', () => {
    const adminAuth = () => bearer({ sub: 777010, role: 'admin', companyId: victimCompanyId });

    async function driverStatus(): Promise<string | undefined> {
      const row = await prisma.runInTenant(victimCompanyId, (tx) =>
        tx.driver.findFirst({ where: { driverId: victimDriverId }, select: { status: true } }),
      );
      return row?.status;
    }

    async function setDriverStatus(status: 'off_shift' | 'on_trip'): Promise<void> {
      await prisma.runInTenant(victimCompanyId, (tx) =>
        tx.driver.update({ where: { driverId: victimDriverId }, data: { status } }),
      );
    }

    async function liveRefreshTokens(): Promise<number> {
      return prisma.refreshToken.count({ where: { userId: victimDriverId, revoked: false } });
    }

    async function waitForRevokedSessions(): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && (await liveRefreshTokens()) > 0) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    beforeEach(async () => {
      await setDriverStatus('off_shift');
    });

    it('persists the status, revokes every session row and blocks login, refresh and shift', async () => {
      const refreshToken = await refreshTokens.issue(victimDriverId);
      const secondRefresh = await refreshTokens.issue(victimDriverId);
      const accessToken = bearer({ sub: victimDriverId, role: 'driver', companyId: victimCompanyId });
      expect(await liveRefreshTokens()).toBeGreaterThanOrEqual(2);

      const res = await request(app.getHttpServer())
        .post(`/admin/drivers/${victimDriverId}/suspend`)
        .set('Authorization', adminAuth())
        .send({ reason: 'suspended' });
      expect(res.status).toBe(200);

      expect(await driverStatus()).toBe('suspended');
      await waitForRevokedSessions();
      expect(await liveRefreshTokens()).toBe(0);
      expect(await refreshStatus(refreshToken)).toBe(401);
      expect(await refreshStatus(secondRefresh)).toBe(401);

      const relogin = await request(app.getHttpServer())
        .post('/auth/driver/login')
        .send({ national_id: VICTIM_NATIONAL_ID, pin: DRIVER_PIN });
      expect(relogin.status).toBe(403);
      expect(relogin.body).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

      const shift = await request(app.getHttpServer())
        .put('/driver/shift')
        .set('Authorization', accessToken)
        .send({ on_shift: true, location: { lat: 6.96, lng: -75.42 } });
      expect(shift.status).toBe(409);
      expect(shift.body).toMatchObject({ code: 'DRIVER_NOT_ELIGIBLE' });
      expect(await driverStatus()).toBe('suspended');
    });

    it.each(['documents_blocked', 'inactive'] as const)('reason %s is stored as the status', async (reason) => {
      const res = await request(app.getHttpServer())
        .post(`/admin/drivers/${victimDriverId}/suspend`)
        .set('Authorization', adminAuth())
        .send({ reason });
      expect(res.status).toBe(200);
      expect(await driverStatus()).toBe(reason);
    });

    it('is idempotent: suspending twice answers 200 both times and keeps the status', async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await request(app.getHttpServer())
          .post(`/admin/drivers/${victimDriverId}/suspend`)
          .set('Authorization', adminAuth())
          .send({ reason: 'suspended' });
        expect(res.status).toBe(200);
      }
      expect(await driverStatus()).toBe('suspended');
    });

    it('a driver on an active trip -> 409 DRIVER_HAS_ACTIVE_TRIP, status and sessions untouched', async () => {
      const refreshToken = await refreshTokens.issue(victimDriverId);
      await setDriverStatus('on_trip');

      const res = await request(app.getHttpServer())
        .post(`/admin/drivers/${victimDriverId}/suspend`)
        .set('Authorization', adminAuth())
        .send({ reason: 'suspended' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'DRIVER_HAS_ACTIVE_TRIP' });
      expect(await driverStatus()).toBe('on_trip');
      expect(await refreshStatus(refreshToken)).toBe(200);
    });

    it('a concurrent suspension never leaves an on_trip driver half-suspended', async () => {
      await setDriverStatus('on_trip');
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          request(app.getHttpServer())
            .post(`/admin/drivers/${victimDriverId}/suspend`)
            .set('Authorization', adminAuth())
            .send({ reason: 'suspended' }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([409, 409, 409]);
      expect(await driverStatus()).toBe('on_trip');
    });
  });
});
