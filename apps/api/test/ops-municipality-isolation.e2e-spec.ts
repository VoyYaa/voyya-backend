import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('trips.trip_request has no RLS: municipality isolation is a bare WHERE (ADR-012 §5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  let companyAId: number;
  let municipalityAId: number;
  let municipalityBId: number;
  let passengerId: number;

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

    const poly = {
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
    };

    const municipalityA = await prisma.municipality.upsert({
      where: { municipalityId: 9111 },
      update: {},
      create: {
        municipalityId: 9111,
        name: '_IsoMuniA',
        department: 'Test',
        coveragePolygon: poly,
        status: 'active',
      },
    });
    municipalityAId = municipalityA.municipalityId;

    const municipalityB = await prisma.municipality.upsert({
      where: { municipalityId: 9112 },
      update: {},
      create: {
        municipalityId: 9112,
        name: '_IsoMuniB',
        department: 'Test',
        coveragePolygon: poly,
        status: 'active',
      },
    });
    municipalityBId = municipalityB.municipalityId;

    const companyA = await prisma.company.upsert({
      where: { taxId: '_iso-co-a' },
      update: { status: 'active' },
      create: {
        legalName: '_IsoCoA',
        taxId: '_iso-co-a',
        type: 'cooperative',
        municipalityId: municipalityAId,
        status: 'active',
      },
    });
    companyAId = companyA.companyId;

    await prisma.company.upsert({
      where: { taxId: '_iso-co-b' },
      update: { status: 'active' },
      create: {
        legalName: '_IsoCoB',
        taxId: '_iso-co-b',
        type: 'cooperative',
        municipalityId: municipalityBId,
        status: 'active',
      },
    });

    const passengerUser = await prisma.user.upsert({
      where: { phone: '_9990000401' },
      update: {},
      create: { firstName: '_Iso', lastName: 'Passenger', phone: '_9990000401', role: 'passenger' },
    });
    await prisma.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId: municipalityAId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'Muni A pickup',
        dropoffAddress: 'Muni A dropoff',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status: 'pending_assignment',
      },
    });

    await prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId: municipalityBId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'Muni B pickup',
        dropoffAddress: 'Muni B dropoff',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status: 'pending_assignment',
      },
    });
  }, 20_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function operatorTokenForCompanyA(): string {
    const token = jwt.sign({ sub: 900101, role: 'operator', type: 'access', company_id: companyAId });
    return `Bearer ${token}`;
  }

  it("the operator of company A's queue never contains municipality B's requests", async () => {
    const res = await request(app.getHttpServer())
      .get('/ops/trip-requests')
      .set('Authorization', operatorTokenForCompanyA());

    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(
      res.body.rows.every((r: { pickup_address: string }) => r.pickup_address !== 'Muni B pickup'),
    ).toBe(true);
    expect(res.body.rows.some((r: { pickup_address: string }) => r.pickup_address === 'Muni A pickup')).toBe(
      true,
    );
  });
});
