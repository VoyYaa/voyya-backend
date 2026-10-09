import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { LOCATION_NOTICE_VERSION } from '@voyyaa/shared';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';
import { grantLocationConsent } from './support/grant-location-consent';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';

const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const ownerIt = ownerUrl ? it : it.skip;
const suite = url ? describe : describe.skip;

const MUNICIPALITY_ID = 9221;
const MUNICIPALITY_NAME = '_ConsentRevocationMuni';
const OLD_NOTICE_VERSION = 'location-notice-old';
const POSITION = { lat: 6.9, lng: -75.4 };

suite('Revocable consent over real HTTP as app_voyya (ADR-029 sections 1 to 4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: PrismaClient;
  let companyId: number;
  let seq = 0;
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
    owner = new PrismaClient({ datasourceUrl: ownerUrl ?? url });

    await prisma.municipality.upsert({
      where: { municipalityId: MUNICIPALITY_ID },
      update: {},
      create: {
        municipalityId: MUNICIPALITY_ID,
        name: MUNICIPALITY_NAME,
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
      where: { taxId: '_consent-revocation-co' },
      update: { status: 'active' },
      create: {
        legalName: '_ConsentRevocationCo',
        taxId: '_consent-revocation-co',
        type: 'cooperative',
        municipalityId: MUNICIPALITY_ID,
        status: 'active',
      },
    });
    companyId = company.companyId;
  }, 30_000);

  afterAll(async () => {
    if (prisma) await purgeMunicipalitiesByNamePrefix(prisma, MUNICIPALITY_NAME);
    if (owner && ownerUrl) {
      await owner.consentRecord.deleteMany({ where: { noticeVersion: OLD_NOTICE_VERSION } });
      await owner.consentNotice.deleteMany({ where: { noticeVersion: OLD_NOTICE_VERSION } });
    }
    if (app) await app.close();
    if (owner) await owner.$disconnect();
  }, 20_000);

  function nextId(): number {
    seq += 1;
    return seq;
  }

  async function makePassenger(): Promise<number> {
    const n = nextId();
    const user = await prisma.user.create({
      data: {
        firstName: '_Rev',
        lastName: `Passenger${n}`,
        phone: `_rev-${runId}-p${n}`,
        role: 'passenger',
      },
    });
    await prisma.passenger.create({ data: { passengerId: user.userId } });
    return user.userId;
  }

  async function makeDriver(status: 'off_shift' | 'available' | 'on_trip'): Promise<number> {
    const n = nextId();
    const user = await prisma.user.create({
      data: {
        firstName: '_Rev',
        lastName: `Driver${n}`,
        phone: `_rev-${runId}-d${n}`,
        role: 'driver',
      },
    });
    const vehicle = await prisma.runInTenant(companyId, (tx) =>
      tx.vehicle.create({
        data: { plate: `_R${runId.slice(-9)}${n}`, companyId, status: 'active' },
      }),
    );
    const located = status !== 'off_shift';
    await prisma.runInTenant(companyId, (tx) =>
      tx.driver.create({
        data: {
          driverId: user.userId,
          companyId,
          nationalId: `_REV-DRV-${runId}-${n}`,
          pin: 'x',
          status,
          currentVehicleId: vehicle.vehicleId,
          currentLat: located ? POSITION.lat : null,
          currentLng: located ? POSITION.lng : null,
          locationUpdatedAt: located ? new Date() : null,
        },
      }),
    );
    return user.userId;
  }

  function driverHeaders(driverId: number): Record<string, string> {
    return { 'x-driver-id': String(driverId), 'x-company-id': String(companyId) };
  }

  function passengerHeaders(passengerId: number): Record<string, string> {
    return { 'x-passenger-id': String(passengerId) };
  }

  function grantAs(headers: Record<string, string>, version: string = LOCATION_NOTICE_VERSION) {
    return request(app.getHttpServer())
      .post('/consents')
      .set(headers)
      .send({ purpose: 'location', notice_version: version });
  }

  function revokeAs(headers: Record<string, string>) {
    return request(app.getHttpServer())
      .post('/consents/revoke')
      .set(headers)
      .send({ purpose: 'location' });
  }

  async function readDriver(driverId: number) {
    return prisma.runInTenant(companyId, (tx) =>
      tx.driver.findUniqueOrThrow({ where: { driverId } }),
    );
  }

  describe('notice registry', () => {
    it('registers both audiences with the sha256 of the canonical text', async () => {
      const { canonicalLocationNoticeText } = await import('@voyyaa/shared');
      const { noticeFingerprint } = await import('../src/modules/auth/consent-notice.registry');
      const rows = await prisma.consentNotice.findMany({
        where: { purpose: 'location', noticeVersion: LOCATION_NOTICE_VERSION },
      });

      expect(rows.map((r) => r.audience).sort()).toEqual(['driver', 'passenger']);
      for (const row of rows) {
        expect(row.body).toBe(canonicalLocationNoticeText(row.audience));
        expect(row.sha256).toBe(noticeFingerprint(row.body));
      }
    });

    async function driftedRegistryClass(): Promise<
      new (
        ...args: ConstructorParameters<
          typeof import('../src/modules/auth/consent-notice.registry').ConsentNoticeRegistry
        >
      ) => import('../src/modules/auth/consent-notice.registry').ConsentNoticeRegistry
    > {
      const { ConsentNoticeRegistry } = await import('../src/modules/auth/consent-notice.registry');
      return class DriftedRegistry extends ConsentNoticeRegistry {
        protected noticeBody(audience: Parameters<ConsentNoticeRegistry['isKnown']>[2]): string {
          return `${super.noticeBody(audience)} reescrito sin subir la versión`;
        }
      };
    }

    it('fails the startup when the contract text changed without bumping the version (no shared row is touched)', async () => {
      const { ConsentNoticeRegistry } = await import('../src/modules/auth/consent-notice.registry');
      const { EnvService } = await import('../src/config/env.service');
      const Drifted = await driftedRegistryClass();
      const drifted = new Drifted(prisma, app.get(EnvService));
      const before = await prisma.consentNotice.findMany({
        where: { purpose: 'location', noticeVersion: LOCATION_NOTICE_VERSION },
      });

      await expect(drifted.register()).rejects.toThrow('cambió sin subir la versión del aviso');

      const after = await prisma.consentNotice.findMany({
        where: { purpose: 'location', noticeVersion: LOCATION_NOTICE_VERSION },
      });
      expect(after.map((row) => [row.audience, row.sha256, row.body]).sort()).toEqual(
        before.map((row) => [row.audience, row.sha256, row.body]).sort(),
      );
      await expect(app.get(ConsentNoticeRegistry).register()).resolves.toBeUndefined();
    });

    it('refuses to boot the application while the contract text differs from the stored hash', async () => {
      const { AppModule } = await import('../src/app.module');
      const { ConsentNoticeRegistry } = await import('../src/modules/auth/consent-notice.registry');
      const Drifted = await driftedRegistryClass();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ConsentNoticeRegistry)
        .useClass(Drifted)
        .compile();
      const second = moduleRef.createNestApplication();
      try {
        await expect(second.init()).rejects.toThrow('cambió sin subir la versión del aviso');
      } finally {
        await moduleRef.get(PrismaService).$disconnect();
      }
    });

    it('refuses to boot when the stored body no longer matches the stored hash (CM-03, read-time tamper, no shared row is touched)', async () => {
      const { ConsentNoticeRegistry } = await import('../src/modules/auth/consent-notice.registry');
      const { EnvService } = await import('../src/config/env.service');
      const tamperedPrisma = Object.create(prisma, {
        consentNotice: {
          value: {
            createMany: prisma.consentNotice.createMany.bind(prisma.consentNotice),
            findUniqueOrThrow: async (
              args: Parameters<typeof prisma.consentNotice.findUniqueOrThrow>[0],
            ) => {
              const row = await prisma.consentNotice.findUniqueOrThrow(args);
              return { ...row, body: `${row.body} reescrito` };
            },
          },
        },
      }) as PrismaService;

      await expect(
        new ConsentNoticeRegistry(tamperedPrisma, app.get(EnvService)).register(),
      ).rejects.toThrow('no coincide con su huella');
    });

    it('app_voyya cannot rewrite or delete the ledger or the notices (CM-03)', async () => {
      const passengerId = await makePassenger();
      await grantLocationConsent(prisma, passengerId, 'passenger');
      const denied = /permission denied/i;

      await expect(
        prisma.$executeRaw`UPDATE auth.consent_record SET action = 'revoked' WHERE user_id = ${passengerId}`,
      ).rejects.toThrow(denied);
      await expect(
        prisma.$executeRaw`DELETE FROM auth.consent_record WHERE user_id = ${passengerId}`,
      ).rejects.toThrow(denied);
      await expect(
        prisma.$executeRaw`UPDATE auth.consent_notice SET body = 'x' WHERE audience = 'passenger'::auth."NoticeAudience"`,
      ).rejects.toThrow(denied);
      await expect(prisma.$executeRaw`DELETE FROM auth.consent_notice`).rejects.toThrow(denied);
      expect(
        await prisma.consentRecord.count({ where: { userId: passengerId, action: 'granted' } }),
      ).toBe(1);
    });

    it('app_voyya cannot delete a user, so the consent proof and the user survive (CM-15)', async () => {
      const passengerId = await makePassenger();
      await grantLocationConsent(prisma, passengerId, 'passenger');

      await expect(
        prisma.$executeRaw`DELETE FROM auth."user" WHERE user_id = ${passengerId}`,
      ).rejects.toThrow(/permission denied/i);

      expect(await prisma.user.count({ where: { userId: passengerId } })).toBe(1);
      expect(
        await prisma.consentRecord.count({ where: { userId: passengerId, action: 'granted' } }),
      ).toBe(1);
    });

    ownerIt(
      'even the owner cannot delete a user that has consent records: the foreign key restricts (CM-15)',
      async () => {
        const passengerId = await makePassenger();
        await grantLocationConsent(prisma, passengerId, 'passenger');

        await expect(
          owner.$executeRaw`DELETE FROM auth."user" WHERE user_id = ${passengerId}`,
        ).rejects.toThrow(/foreign key|consent_record_user_id_fkey/i);

        expect(await prisma.consentRecord.count({ where: { userId: passengerId } })).toBe(1);
      },
    );

    ownerIt('the ledger foreign key restricts updating the notice version (CM-03)', async () => {
      const passengerId = await makePassenger();
      await grantLocationConsent(prisma, passengerId, 'passenger');
      await expect(
        owner.$executeRaw`UPDATE auth.consent_notice SET notice_version = 'location-notice-renamed'
                           WHERE notice_version = ${LOCATION_NOTICE_VERSION} AND audience = 'passenger'::auth."NoticeAudience"`,
      ).rejects.toThrow(/consent_record_purpose_notice_version_audience_fkey|violates foreign key/);
    });
  });

  describe('POST /consents', () => {
    it('rejects an unknown version with 422 NOTICE_VERSION_UNKNOWN and writes nothing', async () => {
      const passengerId = await makePassenger();
      for (const version of ['audit-inject-v1', 'location-notice-v1']) {
        const res = await grantAs(passengerHeaders(passengerId), version);
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'NOTICE_VERSION_UNKNOWN' });
      }
      expect(await prisma.consentRecord.count({ where: { userId: passengerId } })).toBe(0);
    });

    it('stores the audience derived from the token role', async () => {
      const driverId = await makeDriver('off_shift');
      const res = await grantAs(driverHeaders(driverId));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'granted', requires_acceptance: false });
      const row = await prisma.consentRecord.findFirstOrThrow({ where: { userId: driverId } });
      expect(row).toMatchObject({ audience: 'driver', action: 'granted' });
    });

    it('answers 403 NOTICE_AUDIENCE_NOT_ALLOWED to staff roles', async () => {
      const { JwtService } = await import('@nestjs/jwt');
      const jwt = app.get(JwtService, { strict: false });
      const token = jwt.sign({ sub: 1, role: 'admin', type: 'access', company_id: companyId });
      const res = await request(app.getHttpServer())
        .post('/consents')
        .set('Authorization', `Bearer ${token}`)
        .send({ purpose: 'location', notice_version: LOCATION_NOTICE_VERSION });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'NOTICE_AUDIENCE_NOT_ALLOWED' });
    });
  });

  describe('passenger revokes (D-3)', () => {
    it('records the revocation, keeps the ledger and allows accepting again', async () => {
      const passengerId = await makePassenger();
      const headers = passengerHeaders(passengerId);
      await grantAs(headers);

      const revoked = await revokeAs(headers);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toMatchObject({ state: 'revoked', requires_acceptance: true });
      expect(revoked.body.revoked_at).toEqual(expect.any(String));
      expect(revoked.body.granted_at).toEqual(expect.any(String));

      const again = await revokeAs(headers);
      expect(again.body.state).toBe('revoked');
      expect(await prisma.consentRecord.count({ where: { userId: passengerId } })).toBe(2);

      const regranted = await grantAs(headers);
      expect(regranted.body).toMatchObject({
        state: 'granted',
        revoked_at: null,
        requires_acceptance: false,
      });

      const list = await request(app.getHttpServer()).get('/consents').set(headers);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].state).toBe('granted');

      const ledger = await prisma.consentRecord.findMany({
        where: { userId: passengerId },
        orderBy: { consentRecordId: 'asc' },
      });
      expect(ledger.map((r) => r.action)).toEqual(['granted', 'revoked', 'granted']);
      expect(ledger.every((r) => r.audience === 'passenger')).toBe(true);
    });

    it('revoking without ever granting inserts nothing', async () => {
      const passengerId = await makePassenger();
      const res = await revokeAs(passengerHeaders(passengerId));
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('none');
      expect(await prisma.consentRecord.count({ where: { userId: passengerId } })).toBe(0);
    });

    it('does not touch the trips of the passenger', async () => {
      const passengerId = await makePassenger();
      await grantAs(passengerHeaders(passengerId));
      const trip = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId: MUNICIPALITY_ID,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'Calle 1',
          dropoffAddress: 'Calle 2',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10000,
          commission: 800,
          status: 'pending_assignment',
        },
      });
      await revokeAs(passengerHeaders(passengerId));
      const after = await prisma.tripRequest.findUniqueOrThrow({
        where: { tripRequestId: trip.tripRequestId },
      });
      expect(after).toMatchObject({
        status: 'pending_assignment',
        pickupLat: 0.1,
        pickupAddress: 'Calle 1',
      });
      await prisma.tripRequest.update({
        where: { tripRequestId: trip.tripRequestId },
        data: { status: 'cancelled_by_passenger' },
      });
    });
  });

  describe('driver server-side gate', () => {
    it('PUT /driver/shift and POST /driver/location answer 403 LOCATION_CONSENT_REQUIRED without consent', async () => {
      const driverId = await makeDriver('off_shift');
      const shift = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driverId))
        .send({ on_shift: true, location: POSITION });
      expect(shift.status).toBe(403);
      expect(shift.body).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });

      const location = await request(app.getHttpServer())
        .post('/driver/location')
        .set(driverHeaders(driverId))
        .send(POSITION);
      expect(location.status).toBe(403);
      expect(location.body).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });

      const stored = await readDriver(driverId);
      expect(stored).toMatchObject({ status: 'off_shift', currentLat: null, currentLng: null });
    });

    it('works once the notice is accepted and ending the shift never needs consent', async () => {
      const driverId = await makeDriver('off_shift');
      await grantAs(driverHeaders(driverId));
      const shift = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driverId))
        .send({ on_shift: true, location: POSITION });
      expect(shift.status).toBe(200);
      expect(shift.body).toMatchObject({ status: 'available' });

      const location = await request(app.getHttpServer())
        .post('/driver/location')
        .set(driverHeaders(driverId))
        .send(POSITION);
      expect(location.status).toBe(200);

      await revokeAs(driverHeaders(driverId));
      const end = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driverId))
        .send({ on_shift: false });
      expect(end.status).toBe(200);
      expect(end.body).toMatchObject({ status: 'off_shift' });
    });

    it('a version older than the current one still reports location but cannot open a shift', async () => {
      const driverId = await makeDriver('available');
      await prisma.consentNotice.createMany({
        data: [
          {
            purpose: 'location',
            noticeVersion: OLD_NOTICE_VERSION,
            audience: 'driver',
            sha256: 'b'.repeat(64),
            body: 'texto anterior del aviso',
          },
        ],
        skipDuplicates: true,
      });
      const old = await prisma.consentNotice.findFirst({
        where: { noticeVersion: OLD_NOTICE_VERSION, audience: 'driver' },
      });
      if (old === null) throw new Error('old notice fixture missing');
      await prisma.consentRecord.create({
        data: {
          userId: driverId,
          purpose: 'location',
          noticeVersion: old.noticeVersion,
          audience: 'driver',
          action: 'granted',
        },
      });

      const location = await request(app.getHttpServer())
        .post('/driver/location')
        .set(driverHeaders(driverId))
        .send(POSITION);
      expect(location.status).toBe(200);

      const shift = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders(driverId))
        .send({ on_shift: true, location: POSITION });
      expect(shift.status).toBe(403);
      expect(shift.body).toMatchObject({ code: 'LOCATION_CONSENT_REQUIRED' });
    });
  });

  describe('driver revokes (D-3, R-7)', () => {
    it('an available driver loses the position at once and goes off_shift', async () => {
      const driverId = await makeDriver('available');
      await grantAs(driverHeaders(driverId));
      const before = await readDriver(driverId);
      expect(before).toMatchObject({ status: 'available', currentLat: POSITION.lat });

      const res = await revokeAs(driverHeaders(driverId));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'revoked', requires_acceptance: true });

      const after = await readDriver(driverId);
      expect(after).toMatchObject({
        status: 'off_shift',
        currentLat: null,
        currentLng: null,
        locationUpdatedAt: null,
      });
    });

    it('a retry after a partial failure completes the effect and stays idempotent', async () => {
      const driverId = await makeDriver('available');
      await grantAs(driverHeaders(driverId));
      await revokeAs(driverHeaders(driverId));
      await prisma.runInTenant(companyId, (tx) =>
        tx.driver.update({
          where: { driverId },
          data: { status: 'available', currentLat: POSITION.lat, currentLng: POSITION.lng },
        }),
      );

      const retry = await revokeAs(driverHeaders(driverId));
      expect(retry.status).toBe(200);
      expect(await readDriver(driverId)).toMatchObject({ status: 'off_shift', currentLat: null });
      expect(
        await prisma.consentRecord.count({ where: { userId: driverId, action: 'revoked' } }),
      ).toBe(1);
    });

    it('with a trip in progress the trip goes on and the driver ends off_shift when it closes', async () => {
      const driverId = await makeDriver('on_trip');
      await grantAs(driverHeaders(driverId));
      const passengerId = await makePassenger();
      const trip = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId: MUNICIPALITY_ID,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'Calle 1',
          dropoffAddress: 'Calle 2',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 10000,
          commission: 800,
          status: 'in_progress',
        },
      });
      const vehicleId = (await readDriver(driverId)).currentVehicleId;
      if (vehicleId === null) throw new Error('driver fixture without vehicle');
      await prisma.runInTenant(companyId, (tx) =>
        tx.assignment.create({
          data: {
            tripRequestId: trip.tripRequestId,
            driverId,
            vehicleId,
            companyId,
            status: 'accepted',
            assignedBy: 'system',
          },
        }),
      );

      const revoked = await revokeAs(driverHeaders(driverId));
      expect(revoked.status).toBe(200);

      const during = await readDriver(driverId);
      expect(during).toMatchObject({ status: 'on_trip', currentLat: null, currentLng: null });
      const tripDuring = await prisma.tripRequest.findUniqueOrThrow({
        where: { tripRequestId: trip.tripRequestId },
      });
      expect(tripDuring.status).toBe('in_progress');

      const blocked = await request(app.getHttpServer())
        .post('/driver/location')
        .set(driverHeaders(driverId))
        .send(POSITION);
      expect(blocked.status).toBe(403);
      expect(await readDriver(driverId)).toMatchObject({ status: 'on_trip', currentLat: null });

      const complete = await request(app.getHttpServer())
        .post(`/trips/${trip.tripRequestId}/complete`)
        .set(driverHeaders(driverId))
        .send({ cash_collected: true });
      expect(complete.status).toBe(200);
      expect(complete.body).toMatchObject({ status: 'completed' });

      expect(await readDriver(driverId)).toMatchObject({ status: 'off_shift', currentLat: null });
    });

    it('no position survives a revocation raced by concurrent reports on an on_trip driver (CM-04)', async () => {
      const { ConsentService } = await import('../src/modules/auth/consent.service');
      const { DriverShiftService } = await import('../src/modules/assignment/driver-shift.service');
      const consents = app.get(ConsentService);
      const shifts = app.get(DriverShiftService);
      const ROUNDS = 25;
      const WORKERS = 10;
      const REPORTS_PER_WORKER = 12;
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      let survivors = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const driverId = await makeDriver('on_trip');
        await grantLocationConsent(prisma, driverId);
        const user = { userId: driverId, role: 'driver' as const, companyId };
        const workers = Array.from({ length: WORKERS }, async () => {
          for (let i = 0; i < REPORTS_PER_WORKER; i += 1) {
            await shifts.reportLocation(driverId, companyId, POSITION).catch(() => undefined);
          }
        });
        const revocation = delay(round % 4).then(() =>
          consents.revoke(user, { purpose: 'location' }),
        );
        const [revoked] = await Promise.all([revocation, ...workers]);
        expect(revoked.state).toBe('revoked');
        const after = await readDriver(driverId);
        if (
          after.currentLat !== null ||
          after.currentLng !== null ||
          after.locationUpdatedAt !== null
        ) {
          survivors += 1;
        }
      }
      expect(survivors).toBe(0);
    }, 120_000);

    it('does not touch another driver of the same company', async () => {
      const revoker = await makeDriver('available');
      const bystander = await makeDriver('available');
      await grantAs(driverHeaders(revoker));
      await grantAs(driverHeaders(bystander));
      await revokeAs(driverHeaders(revoker));
      expect(await readDriver(bystander)).toMatchObject({
        status: 'available',
        currentLat: POSITION.lat,
      });
    });
  });
});
