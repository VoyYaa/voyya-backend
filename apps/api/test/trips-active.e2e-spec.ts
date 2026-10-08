import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ACTIVE_TRIP_STATUSES, TRIPS_EVENTS } from '@voyyaa/shared';
import request from 'supertest';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import { AllExceptionsFilter } from '../src/shared/all-exceptions.filter';
import { createFreshPassenger } from './support/fresh-passenger';
import { ensureCommission, ensureOpenFare } from './support/platform-fixtures';

const url = process.env.PG_TEST_URL;
const TEST_TIMEOUT_MS = 30_000;
jest.setTimeout(TEST_TIMEOUT_MS);
const suite = url ? describe : describe.skip;

const ORIGIN = { lat: 6.95, lng: -75.42, address: 'Parque principal' };
const DESTINATION = { lat: 6.96, lng: -75.41, address: 'Hospital' };
const MUNICIPALITY_ID = 9141;
const CONCURRENT_REQUESTS = 5;

suite('Passenger active trip: GET /trips/active, 409 with reference and the unique index (ADR-030)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jwt: JwtService;
  let tripsRepository: TripsRepository;
  let companyId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    moduleRef.get(EventEmitter2).removeAllListeners(TRIPS_EVENTS.TRIP_REQUEST_CREATED);

    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtService, { strict: false });
    tripsRepository = moduleRef.get(TripsRepository, { strict: false });

    const coveragePolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-75.5, 6.9],
          [-75.5, 7.0],
          [-75.3, 7.0],
          [-75.3, 6.9],
          [-75.5, 6.9],
        ],
      ],
    };
    const municipality = await prisma.municipality.upsert({
      where: { municipalityId: MUNICIPALITY_ID },
      update: { coveragePolygon },
      create: {
        municipalityId: MUNICIPALITY_ID,
        name: '_ActiveTripMuni',
        department: 'Test',
        coveragePolygon,
        status: 'active',
      },
    });
    const company = await prisma.company.upsert({
      where: { taxId: '_trips-active-co' },
      update: { status: 'active' },
      create: {
        legalName: '_TripsActiveCo',
        taxId: '_trips-active-co',
        type: 'cooperative',
        municipalityId: municipality.municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;
    await ensureOpenFare(prisma, municipality.municipalityId, 'taxi', 8000);
    await ensureCommission(prisma, companyId);
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function auth(passengerId: number): string {
    return `Bearer ${jwt.sign({ sub: passengerId, role: 'passenger', type: 'access' })}`;
  }

  async function newPassenger(): Promise<{ id: number; auth: string }> {
    const id = await createFreshPassenger(prisma);
    return { id, auth: auth(id) };
  }

  async function insertTrip(passengerId: number, status: 'pending_assignment' | 'driver_en_route' | 'in_progress' | 'completed') {
    return prisma.tripRequest.create({
      data: {
        passengerId,
        municipalityId: MUNICIPALITY_ID,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        pickupLat: 0.2,
        pickupLng: 0.2,
        dropoffLat: 0.3,
        dropoffLng: 0.3,
        fare: 8000,
        commission: 640,
        status,
      },
    });
  }

  async function createBody() {
    const quote = await request(app.getHttpServer())
      .post('/trips/quote')
      .set('Authorization', auth(1))
      .send({
        origin: ORIGIN,
        destination: DESTINATION,
        municipality_id: MUNICIPALITY_ID,
        service_type: 'taxi',
      });
    expect(quote.status).toBe(200);
    return {
      origin: ORIGIN,
      destination: DESTINATION,
      municipality_id: MUNICIPALITY_ID,
      service_type: 'taxi',
      payment_method: 'cash',
      quote_token: quote.body.quote_token as string,
    };
  }

  describe('GET /trips/active', () => {
    it('without an active trip -> 200 { active_trip: null }', async () => {
      const passenger = await newPassenger();
      const res = await request(app.getHttpServer()).get('/trips/active').set('Authorization', passenger.auth);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ active_trip: null });
    });

    it('with an active trip -> the same TripRequestStatus that GET /trips/:id returns', async () => {
      const passenger = await newPassenger();
      const trip = await insertTrip(passenger.id, 'pending_assignment');

      const active = await request(app.getHttpServer()).get('/trips/active').set('Authorization', passenger.auth);
      const byId = await request(app.getHttpServer())
        .get(`/trips/${trip.tripRequestId}`)
        .set('Authorization', passenger.auth);

      expect(active.status).toBe(200);
      expect({ ...active.body.active_trip, server_time: null }).toEqual({ ...byId.body, server_time: null });
      expect(active.body.active_trip).toMatchObject({
        trip_request_id: trip.tripRequestId,
        status: 'pending_assignment',
        ui: 'searching',
        driver: null,
      });
    });

    it('a finished trip is not an active trip', async () => {
      const passenger = await newPassenger();
      await insertTrip(passenger.id, 'completed');
      const res = await request(app.getHttpServer()).get('/trips/active').set('Authorization', passenger.auth);
      expect(res.body).toEqual({ active_trip: null });
    });

    it('is isolated between passengers and ignores any identifier sent by the client', async () => {
      const owner = await newPassenger();
      const other = await newPassenger();
      const trip = await insertTrip(owner.id, 'driver_en_route');

      const asOther = await request(app.getHttpServer())
        .get('/trips/active')
        .query({ passenger_id: owner.id, passengerId: owner.id })
        .set('Authorization', other.auth);
      expect(asOther.status).toBe(200);
      expect(asOther.body).toEqual({ active_trip: null });

      const asOwner = await request(app.getHttpServer()).get('/trips/active').set('Authorization', owner.auth);
      expect(asOwner.body.active_trip.trip_request_id).toBe(trip.tripRequestId);
    });

    it('is resolved before /trips/:id (no 400 from ParseIntPipe) and rejects other roles and anonymous callers', async () => {
      const driverToken = jwt.sign({ sub: 7, role: 'driver', type: 'access', company_id: companyId });
      const asDriver = await request(app.getHttpServer())
        .get('/trips/active')
        .set('Authorization', `Bearer ${driverToken}`);
      expect(asDriver.status).toBe(403);
      expect(asDriver.body.code).toBe('FORBIDDEN');

      const anonymous = await request(app.getHttpServer()).get('/trips/active');
      expect(anonymous.status).toBe(401);
    });

    it('after cancelling the trip it is gone and a new request is accepted', async () => {
      const passenger = await newPassenger();
      const body = await createBody();
      const created = await request(app.getHttpServer())
        .post('/trips')
        .set('Authorization', passenger.auth)
        .send(body);
      expect(created.status).toBe(201);

      const cancelled = await request(app.getHttpServer())
        .post(`/trips/${created.body.trip_request_id}/cancel`)
        .set('Authorization', passenger.auth)
        .send({});
      expect(cancelled.status).toBe(200);

      const active = await request(app.getHttpServer()).get('/trips/active').set('Authorization', passenger.auth);
      expect(active.body).toEqual({ active_trip: null });

      const again = await request(app.getHttpServer()).post('/trips').set('Authorization', passenger.auth).send(body);
      expect(again.status).toBe(201);
    });
  });

  describe('free_cancellation_until and server_time (BUG-1, contract 0.8.1)', () => {
    const WINDOW_MS = 2 * 60_000;
    const SKEW_MS = 20_000;

    async function insertAssigned(passengerId: number, status: 'assigned' | 'driver_en_route', assignedAt: Date) {
      const trip = await insertTrip(passengerId, 'pending_assignment');
      await prisma.tripRequest.update({ where: { tripRequestId: trip.tripRequestId }, data: { status, assignedAt } });
      return trip;
    }

    it('GET /trips/:id and GET /trips/active expose assignedAt + window and a server_time', async () => {
      const passenger = await newPassenger();
      const assignedAt = new Date(Date.now() - 30_000);
      const trip = await insertAssigned(passenger.id, 'driver_en_route', assignedAt);

      const byId = await request(app.getHttpServer()).get(`/trips/${trip.tripRequestId}`).set('Authorization', passenger.auth);
      const active = await request(app.getHttpServer()).get('/trips/active').set('Authorization', passenger.auth);

      const expectedUntil = new Date(assignedAt.getTime() + WINDOW_MS).toISOString();
      expect(byId.body.free_cancellation_until).toBe(expectedUntil);
      expect(active.body.active_trip.free_cancellation_until).toBe(expectedUntil);
      expect(Math.abs(Date.now() - new Date(byId.body.server_time).getTime())).toBeLessThan(10_000);
      expect(active.body.active_trip.server_time).toEqual(expect.any(String));
    });

    it('is null while searching and in progress', async () => {
      const searching = await newPassenger();
      const pending = await insertTrip(searching.id, 'pending_assignment');
      const pendingRes = await request(app.getHttpServer()).get(`/trips/${pending.tripRequestId}`).set('Authorization', searching.auth);
      expect(pendingRes.body.free_cancellation_until).toBeNull();

      const riding = await newPassenger();
      const inProgress = await insertTrip(riding.id, 'in_progress');
      const ridingRes = await request(app.getHttpServer()).get(`/trips/${inProgress.tripRequestId}`).set('Authorization', riding.auth);
      expect(ridingRes.body.free_cancellation_until).toBeNull();
    });

    it.each([
      ['just before the limit', SKEW_MS, true],
      ['just after the limit', -SKEW_MS, false],
    ])('cancelling %s agrees with free_cancellation_until', async (_label, marginMs, expectedFree) => {
      const passenger = await newPassenger();
      const assignedAt = new Date(Date.now() - WINDOW_MS + marginMs);
      const trip = await insertAssigned(passenger.id, 'assigned', assignedAt);

      const status = await request(app.getHttpServer()).get(`/trips/${trip.tripRequestId}`).set('Authorization', passenger.auth);
      const promisedFree = new Date(status.body.server_time).getTime() <= new Date(status.body.free_cancellation_until).getTime();
      expect(promisedFree).toBe(expectedFree);

      const cancelled = await request(app.getHttpServer())
        .post(`/trips/${trip.tripRequestId}/cancel`)
        .set('Authorization', passenger.auth)
        .send({});
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.free_of_charge).toBe(expectedFree);
      expect(cancelled.body.penalty_recorded).toBe(!expectedFree);
    });
  });

  describe('POST /trips with an active trip', () => {
    it('-> 409 ACTIVE_TRIP_REQUEST_EXISTS carrying the passenger own active trip only', async () => {
      const passenger = await newPassenger();
      const stranger = await newPassenger();
      const own = await insertTrip(passenger.id, 'driver_en_route');
      const foreign = await insertTrip(stranger.id, 'in_progress');
      const body = await createBody();

      const res = await request(app.getHttpServer()).post('/trips').set('Authorization', passenger.auth).send(body);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: 'ACTIVE_TRIP_REQUEST_EXISTS',
        message: 'Ya tienes un viaje en curso',
        active_trip: { trip_request_id: own.tripRequestId, status: 'driver_en_route' },
      });
      expect(JSON.stringify(res.body)).not.toContain(String(foreign.tripRequestId));
    });

    it('the database itself rejects a second active trip (P2002 from the partial unique index)', async () => {
      const passenger = await newPassenger();
      await insertTrip(passenger.id, 'pending_assignment');
      const attempt = tripsRepository.createTripRequest({
        passengerId: passenger.id,
        municipalityId: MUNICIPALITY_ID,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        pickupLat: 0.2,
        pickupLng: 0.2,
        dropoffLat: 0.3,
        dropoffLng: 0.3,
        distanceKm: 1,
        fareTotal: 8000,
        commission: 640,
      });
      await expect(attempt).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      await expect(attempt).rejects.toMatchObject({ code: 'P2002' });
    });

    it('simultaneous requests from the same passenger -> exactly one 201, the rest 409 with the winner, never a 500', async () => {
      const passenger = await newPassenger();
      const body = await createBody();

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_REQUESTS }, () =>
          request(app.getHttpServer()).post('/trips').set('Authorization', passenger.auth).send(body),
        ),
      );

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, ...Array(CONCURRENT_REQUESTS - 1).fill(409)]);
      const winner = responses.find((r) => r.status === 201);
      for (const loser of responses.filter((r) => r.status === 409)) {
        expect(loser.body.code).toBe('ACTIVE_TRIP_REQUEST_EXISTS');
        expect(loser.body.active_trip).toEqual({
          trip_request_id: winner?.body.trip_request_id,
          status: 'pending_assignment',
        });
      }

      const activeRows = await prisma.tripRequest.count({
        where: { passengerId: passenger.id, status: { in: [...ACTIVE_TRIP_STATUSES] } },
      });
      expect(activeRows).toBe(1);
    });
  });
});
