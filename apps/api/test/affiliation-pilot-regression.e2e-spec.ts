import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { randomInt } from 'node:crypto';
import request from 'supertest';
import { REQUIRED_DRIVER_DOCUMENT_TYPES } from '@voyyaa/shared';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { stagingKey } from '../src/modules/affiliation/document-key';
import { FILE_STORAGE, type FileStorageProvider } from '../src/modules/affiliation/ports/file-storage.port';
import { ActiveCompanyResolver } from '../src/modules/tenancy/active-company.resolver';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

const PDF_BYTES = Buffer.from('%PDF-1.4\n%E2E pilot-regression test document\n');
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function uniqueSuffix(): string {
  return `${Date.now()}${randomInt(100_000, 999_999)}`;
}

function randomPhone(): string {
  return `3${randomInt(100_000_000, 999_999_999)}`;
}

function randomPlate(): string {
  const letters = `${LETTERS[randomInt(0, 26)]}${LETTERS[randomInt(0, 26)]}${LETTERS[randomInt(0, 26)]}`;
  const digits = String(randomInt(0, 1000)).padStart(3, '0');
  return `${letters}${digits}`;
}

async function stageDriverDocuments(
  storage: FileStorageProvider,
): Promise<Array<{ type: (typeof REQUIRED_DRIVER_DOCUMENT_TYPES)[number]; storage_key: string; expires_at: string }>> {
  const documents = [];
  for (const type of REQUIRED_DRIVER_DOCUMENT_TYPES) {
    const key = stagingKey('application/pdf');
    await storage.put({ key, body: PDF_BYTES, contentType: 'application/pdf' });
    documents.push({ type, storage_key: key, expires_at: '2030-01-01' });
  }
  return documents;
}

suite(
  'Regresión del piloto (Cootrayal/Yarumal-like) tras ADR-021: vehicle_count NULL, cotizar/asignar/completar (ADR-021 §9.7 #13)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let activeCompanies: ActiveCompanyResolver;
    let storage: FileStorageProvider;
    let companyId: number;
    let municipalityId: number;
    let passengerId: number;
    let adminAuth: string;

    const SQUARE = {
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
    const PICKUP = { lat: 6.96, lng: -75.42, address: 'Calle 1' };
    const DROPOFF = { lat: 6.97, lng: -75.43, address: 'Calle 2' };

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
      activeCompanies = moduleRef.get(ActiveCompanyResolver);
      storage = moduleRef.get(FILE_STORAGE);

      const suffix = uniqueSuffix();
      const municipality = await prisma.municipality.create({
        data: {
          name: `_PilotRegressionMuni-${suffix}`,
          department: 'Antioquia',
          coveragePolygon: SQUARE,
          status: 'active',
        },
      });
      municipalityId = municipality.municipalityId;

      const company = await prisma.company.create({
        data: {
          legalName: `_PilotRegressionCo-${suffix}`,
          taxId: `_pilot-regression-${suffix}`,
          type: 'cooperative',
          municipalityId,
          status: 'active',
          vehicleCount: null,
        },
      });
      companyId = company.companyId;

      const adminUser = await prisma.user.create({
        data: {
          firstName: '_Pilot',
          lastName: 'Admin',
          phone: `_pilot-admin-${suffix}`,
          role: 'admin',
          companyId,
        },
      });
      const jwt = moduleRef.get(JwtService, { strict: false });
      adminAuth = `Bearer ${jwt.sign({ sub: adminUser.userId, role: 'admin', type: 'access', company_id: companyId })}`;

      await prisma.runInTenant(companyId, (tx) =>
        tx.fareConfig.create({
          data: {
            companyId,
            serviceType: 'taxi',
            baseFare: 8000,
            validFrom: new Date(),
            validTo: null,
          },
        }),
      );

      const passengerUser = await prisma.user.create({
        data: {
          firstName: '_Pilot',
          lastName: 'Passenger',
          phone: `_pilot-passenger-${suffix}`,
          role: 'passenger',
        },
      });
      await prisma.passenger.upsert({
        where: { passengerId: passengerUser.userId },
        update: {},
        create: { passengerId: passengerUser.userId },
      });
      passengerId = passengerUser.userId;
    }, 20_000);

    afterAll(async () => {
      if (app) await app.close();
    });

    it('ActiveCompanyResolver resuelve esta empresa como la única activa de su municipio (regresión de Cootrayal/Yarumal)', async () => {
      const resolved = await activeCompanies.resolve(municipalityId);
      expect(resolved).toBe(companyId);
    });

    it('vehicle_count NULL: registrar varios conductores por HTTP nunca dispara FLEET_LIMIT_REACHED', async () => {
      const created: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const suffix = uniqueSuffix();
        const res = await request(app.getHttpServer())
          .post('/admin/drivers')
          .set('Authorization', adminAuth)
          .send({
            first_name: '_Pilot',
            last_name: `Driver${i}-${suffix}`,
            national_id: `9${randomInt(100_000_000, 999_999_999)}`,
            phone: randomPhone(),
            vehicle: { plate: randomPlate(), model: 'Chevrolet Spark' },
            documents: await stageDriverDocuments(storage),
          });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('off_shift');
        created.push(res.body.driver_id);
      }
      expect(created).toHaveLength(3);

      const quota = await request(app.getHttpServer())
        .get('/admin/fleet-quota')
        .set('Authorization', adminAuth);
      expect(quota.status).toBe(200);
      expect(quota.body).toMatchObject({ declared: null, available: null });
      expect(quota.body.used).toBeGreaterThanOrEqual(3);
    }, 30_000);

    it('cotizar -> crear solicitud -> asignar -> ciclo de vida completo sigue funcionando end to end', async () => {
      const driverSuffix = uniqueSuffix();
      const driverUser = await prisma.user.create({
        data: {
          firstName: '_Pilot',
          lastName: 'AssignedDriver',
          phone: `_pilot-assigned-driver-${driverSuffix}`,
          role: 'driver',
        },
      });
      const driverId = driverUser.userId;

      const vehicle = await prisma.runInTenant(companyId, (tx) =>
        tx.vehicle.create({ data: { plate: randomPlate(), companyId, status: 'active' } }),
      );
      await prisma.runInTenant(companyId, (tx) =>
        tx.driver.create({
          data: {
            driverId,
            companyId,
            nationalId: `_pilot-natid-${driverSuffix}`,
            pin: 'x',
            status: 'off_shift',
            currentVehicleId: vehicle.vehicleId,
          },
        }),
      );

      function driverHeaders(): Record<string, string> {
        return { 'x-driver-id': String(driverId), 'x-company-id': String(companyId) };
      }

      const onShift = await request(app.getHttpServer())
        .put('/driver/shift')
        .set(driverHeaders())
        .send({ on_shift: true, location: { lat: PICKUP.lat, lng: PICKUP.lng } });
      expect(onShift.status).toBe(200);
      expect(onShift.body.status).toBe('available');

      const quote = await request(app.getHttpServer())
        .post('/trips/quote')
        .set('x-passenger-id', String(passengerId))
        .send({
          origin: PICKUP,
          destination: DROPOFF,
          municipality_id: municipalityId,
        });
      expect(quote.status).toBe(200);
      expect(quote.body.quote_token).toEqual(expect.any(String));
      expect(quote.body.fare.total).toEqual(expect.any(Number));

      const tripRequest = await prisma.tripRequest.create({
        data: {
          passengerId,
          municipalityId,
          serviceType: 'taxi',
          paymentMethod: 'cash',
          pickupAddress: PICKUP.address,
          dropoffAddress: DROPOFF.address,
          pickupLat: PICKUP.lat,
          pickupLng: PICKUP.lng,
          dropoffLat: DROPOFF.lat,
          dropoffLng: DROPOFF.lng,
          fare: quote.body.fare.total,
          commission: quote.body.fare.commission,
          status: 'assigned',
        },
      });
      const tripRequestId = tripRequest.tripRequestId;

      await prisma.runInTenant(companyId, (tx) =>
        tx.driver.update({ where: { driverId }, data: { status: 'on_trip' } }),
      );
      await prisma.runInTenant(companyId, (tx) =>
        tx.assignment.create({
          data: {
            tripRequestId,
            driverId,
            vehicleId: vehicle.vehicleId,
            companyId,
            status: 'accepted',
            assignedBy: 'system',
          },
        }),
      );

      const enRoute = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/en-route`)
        .set(driverHeaders())
        .send({});
      expect(enRoute.status).toBe(200);

      const arrived = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/arrived`)
        .set(driverHeaders())
        .send({});
      expect(arrived.status).toBe(200);

      const started = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/start`)
        .set(driverHeaders())
        .send({});
      expect(started.status).toBe(200);
      expect(started.body.status).toBe('in_progress');

      const completed = await request(app.getHttpServer())
        .post(`/trips/${tripRequestId}/complete`)
        .set(driverHeaders())
        .send({ cash_collected: true });
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe('completed');

      const finalStatus = await request(app.getHttpServer())
        .get(`/trips/${tripRequestId}`)
        .set('x-passenger-id', String(passengerId));
      expect(finalStatus.status).toBe(200);
      expect(finalStatus.body.status).toBe('completed');
    }, 30_000);
  },
);
