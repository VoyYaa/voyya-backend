import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import { AssignmentService } from '../src/modules/assignment/assignment.service';
import { CandidateRepository } from '../src/modules/assignment/candidate.repository';
import { OperationalParamsService } from '../src/modules/assignment/operational-params.service';
import type { PushProvider } from '../src/modules/assignment/ports/push-provider.port';
import { TripClosingService } from '../src/modules/assignment/trip-closing.service';
import { ActiveCompanyResolver } from '../src/modules/tenancy/active-company.resolver';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

function uniquePhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
}

const poly = {
  type: 'Polygon',
  coordinates: [
    [
      [-75.45, 6.94],
      [-75.39, 6.94],
      [-75.39, 6.99],
      [-75.45, 6.99],
      [-75.45, 6.94],
    ],
  ],
};

const ORIGIN = { lat: 6.96, lng: -75.42, address: 'Origin' };
const DESTINATION = { lat: 6.97, lng: -75.41, address: 'Destination' };

suite('ADR-018 · trips.fare_config and admin.system_parameter are company-owned', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('RLS direct — same reproduction method as docs/security/reporte-consola-admin.md (B-01)', () => {
    it('a nonexistent tenant sees 0 rows in trips.fare_config and admin.system_parameter', async () => {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company', '999999', true)`;
        const fareConfig = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM trips.fare_config
        `;
        const systemParameter = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT count(*) AS count FROM admin.system_parameter
        `;
        return { fareConfig, systemParameter };
      });

      expect(Number(rows.fareConfig[0]?.count)).toBe(0);
      expect(Number(rows.systemParameter[0]?.count)).toBe(0);
    });
  });

  describe('B-01 regression, rewritten for RLS + WHERE (no more a shared "owner" to check)', () => {
    let municipalityId: number;
    let companyAId: number;
    let companyBId: number;
    let adminAAuth: string;
    let adminBAuth: string;

    beforeAll(async () => {
      const municipality = await prisma.municipality.upsert({
        where: { municipalityId: 9181 },
        update: { coveragePolygon: poly, status: 'active' },
        create: {
          municipalityId: 9181,
          name: '_Adr018SettingsMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });
      municipalityId = municipality.municipalityId;

      const companyA = await prisma.company.upsert({
        where: { taxId: '_adr018-settings-co-a' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018CoA',
          taxId: '_adr018-settings-co-a',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      companyAId = companyA.companyId;

      const companyB = await prisma.company.upsert({
        where: { taxId: '_adr018-settings-co-b' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018CoB',
          taxId: '_adr018-settings-co-b',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      companyBId = companyB.companyId;

      await seedFullSettings(prisma, companyAId, { baseFare: 8000 });
      await seedFullSettings(prisma, companyBId, { baseFare: 8500 });

      const adminA = await prisma.user.upsert({
        where: { phone: '_9990000701' },
        update: { companyId: companyAId, role: 'admin' },
        create: { firstName: '_Adr018', lastName: 'AdminA', phone: '_9990000701', role: 'admin', companyId: companyAId },
      });
      const adminB = await prisma.user.upsert({
        where: { phone: '_9990000702' },
        update: { companyId: companyBId, role: 'admin' },
        create: { firstName: '_Adr018', lastName: 'AdminB', phone: '_9990000702', role: 'admin', companyId: companyBId },
      });

      adminAAuth = `Bearer ${jwt.sign({ sub: adminA.userId, role: 'admin', type: 'access', company_id: companyAId })}`;
      adminBAuth = `Bearer ${jwt.sign({ sub: adminB.userId, role: 'admin', type: 'access', company_id: companyBId })}`;
    }, 20_000);

    it("company B's admin changes its own fare -> 200, company A's fare and version are untouched", async () => {
      const before = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', adminBAuth);
      const beforeA = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', adminAAuth);

      const res = await request(app.getHttpServer())
        .put('/admin/settings')
        .set('Authorization', adminBAuth)
        .send({
          version: before.body.version,
          base_fare: 1500,
          night_surcharge_pct: before.body.night_surcharge_pct,
          holiday_surcharge_pct: before.body.holiday_surcharge_pct,
          search_radius_km: before.body.search_radius_km,
          acceptance_timeout_sec: before.body.acceptance_timeout_sec,
        });

      expect(res.status).toBe(200);
      expect(res.body.base_fare).toBe(1500);

      const afterA = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', adminAAuth);
      expect(afterA.body.base_fare).toBe(beforeA.body.base_fare);
      expect(afterA.body.version).toBe(beforeA.body.version);
    });
  });

  describe('B-13 — two concurrent PUT for the SAME company, only one wins (partial unique index)', () => {
    let companyId: number;
    let adminAuth: string;

    beforeAll(async () => {
      const municipality = await prisma.municipality.upsert({
        where: { municipalityId: 9182 },
        update: { coveragePolygon: poly, status: 'active' },
        create: {
          municipalityId: 9182,
          name: '_Adr018ConcurrencyMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });

      const company = await prisma.company.upsert({
        where: { taxId: '_adr018-concurrency-co' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018ConcurrencyCo',
          taxId: '_adr018-concurrency-co',
          type: 'cooperative',
          municipalityId: municipality.municipalityId,
          status: 'active',
        },
      });
      companyId = company.companyId;

      await seedFullSettings(prisma, companyId, { baseFare: 8000 });

      const admin = await prisma.user.upsert({
        where: { phone: '_9990000703' },
        update: { companyId, role: 'admin' },
        create: { firstName: '_Adr018', lastName: 'ConcurrencyAdmin', phone: '_9990000703', role: 'admin', companyId },
      });
      adminAuth = `Bearer ${jwt.sign({ sub: admin.userId, role: 'admin', type: 'access', company_id: companyId })}`;
    }, 20_000);

    it('2 concurrent PUT with the same version -> one 200, one 409, exactly 1 open fare_config row remains', async () => {
      const before = await request(app.getHttpServer())
        .get('/admin/settings')
        .set('Authorization', adminAuth);

      const N = 2;
      const results = await Promise.all(
        Array.from({ length: N }, (_v, i) =>
          request(app.getHttpServer())
            .put('/admin/settings')
            .set('Authorization', adminAuth)
            .send({
              version: before.body.version,
              base_fare: 8100 + i,
              night_surcharge_pct: before.body.night_surcharge_pct,
              holiday_surcharge_pct: before.body.holiday_surcharge_pct,
              search_radius_km: before.body.search_radius_km,
              acceptance_timeout_sec: before.body.acceptance_timeout_sec,
            }),
        ),
      );

      const ok = results.filter((r) => r.status === 200);
      const conflict = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(N - 1);

      const openRows = await prisma.runInTenant(companyId, (tx) =>
        tx.fareConfig.count({ where: { companyId, serviceType: 'taxi', validTo: null } }),
      );
      expect(openRows).toBe(1);
    });
  });

  describe('POST /trips/quote — company resolution before the tarifa exists (ADR-018 §3)', () => {
    let passengerAuth: string;

    beforeAll(async () => {
      const passengerPhone = uniquePhone();
      const passenger = await prisma.user.upsert({
        where: { phone: passengerPhone },
        update: {},
        create: { firstName: '_Adr018', lastName: 'Passenger', phone: passengerPhone, role: 'passenger' },
      });
      await prisma.passenger.upsert({
        where: { passengerId: passenger.userId },
        update: {},
        create: { passengerId: passenger.userId },
      });
      passengerAuth = `Bearer ${jwt.sign({ sub: passenger.userId, role: 'passenger', type: 'access' })}`;
    }, 20_000);

    function quoteBody(municipalityId: number): Record<string, unknown> {
      return {
        origin: ORIGIN,
        destination: DESTINATION,
        municipality_id: municipalityId,
        service_type: 'taxi',
      };
    }

    it('two active companies in the same municipality -> resolves deterministically to the lower company_id fare', async () => {
      const municipality = await prisma.municipality.upsert({
        where: { municipalityId: 9183 },
        update: { coveragePolygon: poly, status: 'active' },
        create: {
          municipalityId: 9183,
          name: '_Adr018QuoteMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });

      const companyX = await prisma.company.upsert({
        where: { taxId: '_adr018-quote-co-x' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018QuoteCoX',
          taxId: '_adr018-quote-co-x',
          type: 'cooperative',
          municipalityId: municipality.municipalityId,
          status: 'active',
        },
      });
      const companyY = await prisma.company.upsert({
        where: { taxId: '_adr018-quote-co-y' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018QuoteCoY',
          taxId: '_adr018-quote-co-y',
          type: 'cooperative',
          municipalityId: municipality.municipalityId,
          status: 'active',
        },
      });

      const lowerCompanyId = Math.min(companyX.companyId, companyY.companyId);
      const higherCompanyId = Math.max(companyX.companyId, companyY.companyId);

      await seedOpenFareConfig(prisma, lowerCompanyId, 8800);
      await seedOpenFareConfig(prisma, higherCompanyId, 9900);

      const res = await request(app.getHttpServer())
        .post('/trips/quote')
        .set('Authorization', passengerAuth)
        .send(quoteBody(municipality.municipalityId));

      expect(res.status).toBe(200);
      expect(res.body.fare.base_fare).toBe(8800);
      expect(res.body.fare.total).toBe(8800);
    });

    it('no active company in the municipality -> 409 NO_COMPANY_AVAILABLE', async () => {
      const municipality = await prisma.municipality.upsert({
        where: { municipalityId: 9184 },
        update: { coveragePolygon: poly, status: 'active' },
        create: {
          municipalityId: 9184,
          name: '_Adr018NoCompanyMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/trips/quote')
        .set('Authorization', passengerAuth)
        .send(quoteBody(municipality.municipalityId));

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NO_COMPANY_AVAILABLE' });
    });
  });

  describe('AssignmentService.start() resolves the SAME company as TripsService.quote() (single ActiveCompanyResolver, §2)', () => {
    it('with two active companies, the assignment engine dispatches through the lower company_id — never diverges from the quote', async () => {
      const municipality = await prisma.municipality.upsert({
        where: { municipalityId: 9185 },
        update: { coveragePolygon: poly, status: 'active' },
        create: {
          municipalityId: 9185,
          name: '_Adr018DispatchMuni',
          department: 'Test',
          coveragePolygon: poly,
          status: 'active',
        },
      });
      const municipalityId = municipality.municipalityId;

      const companyX = await prisma.company.upsert({
        where: { taxId: '_adr018-dispatch-co-x' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018DispatchCoX',
          taxId: '_adr018-dispatch-co-x',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      const companyY = await prisma.company.upsert({
        where: { taxId: '_adr018-dispatch-co-y' },
        update: { status: 'active' },
        create: {
          legalName: '_Adr018DispatchCoY',
          taxId: '_adr018-dispatch-co-y',
          type: 'cooperative',
          municipalityId,
          status: 'active',
        },
      });
      const lowerCompanyId = Math.min(companyX.companyId, companyY.companyId);

      const driverPhone = uniquePhone();
      const driverUser = await prisma.user.upsert({
        where: { phone: driverPhone },
        update: {},
        create: { firstName: '_Adr018', lastName: 'Driver', phone: driverPhone, role: 'driver' },
      });
      const vehicle = await prisma.runInTenant(lowerCompanyId, (tx) =>
        tx.vehicle.upsert({
          where: { plate: '_ADR18D1' },
          update: { status: 'active', companyId: lowerCompanyId },
          create: { plate: '_ADR18D1', companyId: lowerCompanyId, status: 'active' },
        }),
      );
      await prisma.runInTenant(lowerCompanyId, (tx) =>
        tx.driver.updateMany({
          where: {
            companyId: lowerCompanyId,
            currentLat: 0.1,
            currentLng: 0.1,
            driverId: { not: driverUser.userId },
          },
          data: { status: 'off_shift' },
        }),
      );
      await prisma.runInTenant(lowerCompanyId, (tx) =>
        tx.driver.upsert({
          where: { driverId: driverUser.userId },
          update: {
            companyId: lowerCompanyId,
            status: 'available',
            currentVehicleId: vehicle.vehicleId,
            currentLat: 0.1,
            currentLng: 0.1,
            locationUpdatedAt: new Date(),
          },
          create: {
            driverId: driverUser.userId,
            companyId: lowerCompanyId,
            nationalId: `_ADR18-DRV-${driverPhone}`,
            pin: 'x',
            status: 'available',
            currentVehicleId: vehicle.vehicleId,
            currentLat: 0.1,
            currentLng: 0.1,
            locationUpdatedAt: new Date(),
          },
        }),
      );

      const passengerPhone = uniquePhone();
      const passengerUser = await prisma.user.upsert({
        where: { phone: passengerPhone },
        update: {},
        create: { firstName: '_Adr018', lastName: 'DispatchPassenger', phone: passengerPhone, role: 'passenger' },
      });
      await prisma.passenger.upsert({
        where: { passengerId: passengerUser.userId },
        update: {},
        create: { passengerId: passengerUser.userId },
      });

      const trip = await prisma.tripRequest.create({
        data: {
          passengerId: passengerUser.userId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: 'A',
          dropoffAddress: 'B',
          pickupLat: 0.1,
          pickupLng: 0.1,
          dropoffLat: 0.2,
          dropoffLng: 0.2,
          fare: 8000,
          commission: 640,
          status: 'pending_assignment',
        },
      });

      const activeCompanyResolver = new ActiveCompanyResolver(prisma);
      const assignmentRepo = new AssignmentRepository(prisma);
      const tripClosing = new TripClosingService(prisma, assignmentRepo, activeCompanyResolver);
      const candidateRepo = new CandidateRepository();
      const paramsService = new OperationalParamsService(prisma, {
        get: (k: string) => defaultEnv[k],
      } as never);
      const push: PushProvider = { async sendAssignment() {} };
      const emitter = new EventEmitter2();
      const assignmentService = new AssignmentService(
        prisma,
        candidateRepo,
        assignmentRepo,
        paramsService,
        emitter,
        push,
        tripClosing,
        activeCompanyResolver,
      );

      await assignmentService.onTripRequestCreated({
        trip_request_id: trip.tripRequestId,
        passenger_id: passengerUser.userId,
        municipality_id: municipalityId,
        service_type: 'taxi',
        origin: { lat: 0.1, lng: 0.1 },
        occurred_at: new Date().toISOString(),
      });

      const assignment = await prisma.runInTenant(lowerCompanyId, (tx) =>
        tx.assignment.findFirst({ where: { tripRequestId: trip.tripRequestId } }),
      );
      expect(assignment?.companyId).toBe(lowerCompanyId);
      expect(assignment?.driverId).toBe(driverUser.userId);
    });
  });
});

const defaultEnv: Record<string, number> = {
  SEARCH_RADIUS_KM: 2,
  EXPANSION_RADIUS_KM: 6,
  ACCEPTANCE_TIMEOUT_SEC: 15,
  MAX_AUTO_RETRIES: 3,
  TIEBREAK_WINDOW_HOURS: 3,
  AVG_SPEED_KMH: 20,
  NO_SHOW_GRACE_MIN: 5,
  LOCATION_STALE_MIN: 15,
};

async function seedOpenFareConfig(
  prisma: PrismaService,
  companyId: number,
  baseFare: number,
): Promise<void> {
  await prisma.runInTenant(companyId, async (tx) => {
    await tx.fareConfig.deleteMany({ where: { companyId, serviceType: 'taxi' } });
    await tx.fareConfig.create({
      data: {
        companyId,
        serviceType: 'taxi',
        baseFare,
        nightSurchargePct: 0,
        holidaySurchargePct: 0,
        commissionPct: 8,
      },
    });
  });
}

async function seedFullSettings(
  prisma: PrismaService,
  companyId: number,
  opts: { baseFare: number },
): Promise<void> {
  await prisma.runInTenant(companyId, async (tx) => {
    await tx.fareConfig.deleteMany({ where: { companyId, serviceType: 'taxi' } });
    await tx.fareConfig.create({
      data: {
        companyId,
        serviceType: 'taxi',
        baseFare: opts.baseFare,
        nightSurchargePct: 20,
        holidaySurchargePct: 15,
        commissionPct: 8,
      },
    });
    await tx.systemParameter.upsert({
      where: { key_companyId: { key: 'search_radius_km', companyId } },
      update: { value: '2' },
      create: { key: 'search_radius_km', value: '2', companyId },
    });
    await tx.systemParameter.upsert({
      where: { key_companyId: { key: 'acceptance_timeout_sec', companyId } },
      update: { value: '15' },
      create: { key: 'acceptance_timeout_sec', value: '15', companyId },
    });
    await tx.systemParameter.upsert({
      where: { key_companyId: { key: 'expansion_radius_km', companyId } },
      update: { value: '6' },
      create: { key: 'expansion_radius_km', value: '6', companyId },
    });
  });
}
