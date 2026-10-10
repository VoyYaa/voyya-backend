import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  type World,
  bootWorld,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  driverAuth,
  ownerClient,
  passengerAuth,
} from './support/dispatch-world';
import { grantLocationConsent } from './support/grant-location-consent';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';
import {
  type WindowTrip,
  createAcceptedTrip,
  createEnRouteTrip,
  readStartState,
  wrongCodeFor,
} from './support/window-trip';

const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = url ? describe : describe.skip;
const ownerIt = ownerUrl ? it : it.skip;

const PREFIX = '_StartHttp';
const CENTER = { lat: 12.45, lng: -69.45 };

jest.setTimeout(120_000);

suite('ADR-033 POST /trips/:id/start with the start code against the real API and Postgres', () => {
  let world: World;
  let http: ReturnType<typeof request>;
  let municipalityId: number;
  let companyId: number;
  let otherCompanyId: number;
  let owner: PrismaClient | null = null;

  const newTrip = (kind: 'accepted' | 'enRoute' = 'enRoute'): Promise<WindowTrip> =>
    (kind === 'enRoute' ? createEnRouteTrip : createAcceptedTrip)(world, {
      municipalityId,
      companyId,
      pickup: CENTER,
    });

  const start = (trip: WindowTrip, body?: Record<string, unknown>, driverId = trip.driver.driverId) => {
    const call = http
      .post(`/trips/${trip.tripRequestId}/start`)
      .set('Authorization', driverAuth(world.jwt, driverId, trip.companyId));
    return body === undefined ? call.send() : call.send(body);
  };

  const codeOf = async (trip: WindowTrip): Promise<string> => {
    const code = (await readStartState(world, trip.tripRequestId)).startCode;
    if (code === null) throw new Error('the trip has no code');
    return code;
  };

  beforeAll(async () => {
    world = await bootWorld();
    http = request(world.app.getHttpServer());
    owner = ownerClient();
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyId = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Alfa Taxis' });
    otherCompanyId = await createOperatingCompany(world.prisma, municipalityId, { publicName: 'Beta Taxis' });
  });

  afterAll(async () => {
    await owner?.$disconnect();
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  describe('the happy path and the backdoor', () => {
    it('the right code starts the trip, stamps started_at and erases the code', async () => {
      const trip = await newTrip();
      const code = await codeOf(trip);

      const response = await start(trip, { start_code: code });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ trip_request_id: trip.tripRequestId, status: 'in_progress', idempotent: false });
      const state = await readStartState(world, trip.tripRequestId);
      expect(state.status).toBe('in_progress');
      expect(state.startedAt).not.toBeNull();
      expect(state.startCode).toBeNull();
      expect(state.attempts).toBe(0);
    });

    it('the backdoor is closed: the code is required with or without having marked the arrival', async () => {
      const withoutArrival = await newTrip();
      const withArrival = await newTrip();
      await http
        .post(`/trips/${withArrival.tripRequestId}/arrived`)
        .set('Authorization', driverAuth(world.jwt, withArrival.driver.driverId, companyId))
        .send({})
        .expect(200);

      for (const trip of [withoutArrival, withArrival]) {
        const response = await start(trip);
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('START_CODE_REQUIRED');
        expect((await readStartState(world, trip.tripRequestId)).status).toBe('driver_en_route');
      }
    });

    it('starting twice is idempotent whatever the second request carries', async () => {
      const trip = await newTrip();
      await start(trip, { start_code: await codeOf(trip) }).expect(200);

      const again = await start(trip, { start_code: '0000' });
      const withoutCode = await start(trip);

      expect(again.status).toBe(200);
      expect(again.body.idempotent).toBe(true);
      expect(withoutCode.status).toBe(200);
      expect(withoutCode.body.idempotent).toBe(true);
    });
  });

  describe('the order of the validations never spends an attempt', () => {
    it('a code with the wrong format is a 400 and spends nothing', async () => {
      const trip = await newTrip();

      for (const bad of ['12a4', '12345', '', 1234]) {
        const response = await start(trip, { start_code: bad });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('INVALID_DATA');
        expect(JSON.stringify(response.body)).not.toContain('12345');
      }
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });

    it('a request without a code is a 422 and spends nothing', async () => {
      const trip = await newTrip();

      const response = await start(trip);

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('START_CODE_REQUIRED');
      expect(response.body.message).toContain('pídele el código al pasajero');
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });

    it('a trip that is still assigned (no en-route) answers 409 and spends nothing, even with a wrong code', async () => {
      const trip = await newTrip('accepted');

      const response = await start(trip, { start_code: wrongCodeFor(await codeOf(trip)) });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('INVALID_TRIP_TRANSITION');
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });

    it('another driver gets 403 and spends nothing, and never learns anything about the code', async () => {
      const trip = await newTrip();
      const stranger = await createDriver(world.prisma, companyId, CENTER);

      const response = await start(trip, { start_code: wrongCodeFor(await codeOf(trip)) }, stranger.driverId);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('NOT_THE_DRIVER');
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });

    it('a driver of another company gets 403 and spends nothing', async () => {
      const trip = await newTrip();
      const foreign = await createDriver(world.prisma, otherCompanyId, CENTER);

      const response = await http
        .post(`/trips/${trip.tripRequestId}/start`)
        .set('Authorization', driverAuth(world.jwt, foreign.driverId, otherCompanyId))
        .send({ start_code: wrongCodeFor(await codeOf(trip)) });

      expect(response.status).toBe(403);
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });
  });

  describe('the rate limit answers before the controller (C-3)', () => {
    it('the eleventh request in a minute is a 429 and does not spend an attempt, even with a wrong code', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));
      for (let i = 0; i < 10; i += 1) await start(trip).expect(422);

      const limited = await start(trip, { start_code: wrong });

      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect((await readStartState(world, trip.tripRequestId)).attempts).toBe(0);
    });

    it('another driver behind the same IP is not limited', async () => {
      const busy = await newTrip();
      const other = await newTrip();
      for (let i = 0; i < 10; i += 1) await start(busy);

      expect((await start(busy)).status).toBe(429);
      expect((await start(other)).status).toBe(422);
    });
  });

  describe('the failed attempt survives the error (the rule that matters most)', () => {
    it('each wrong code is persisted: the row is read again after the 422', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));

      for (let failed = 1; failed <= 4; failed += 1) {
        const response = await start(trip, { start_code: wrong });

        expect(response.status).toBe(422);
        expect(response.body.code).toBe('START_CODE_INVALID');
        expect(response.body.attempts_remaining).toBe(5 - failed);
        const state = await readStartState(world, trip.tripRequestId);
        expect(state.attempts).toBe(failed);
        expect(state.status).toBe('driver_en_route');
        expect(state.blockedAt).toBeNull();
      }
    });

    it('the fifth wrong code blocks the start for good, with the correct code too, and the code is erased', async () => {
      const trip = await newTrip();
      const code = await codeOf(trip);
      const wrong = wrongCodeFor(code);
      for (let i = 0; i < 4; i += 1) await start(trip, { start_code: wrong }).expect(422);

      const fifth = await start(trip, { start_code: wrong });

      expect(fifth.status).toBe(409);
      expect(fifth.body.code).toBe('START_CODE_BLOCKED');
      expect(typeof fifth.body.blocked_at).toBe('string');
      const blocked = await readStartState(world, trip.tripRequestId);
      expect(blocked.attempts).toBe(5);
      expect(blocked.blockedAt).not.toBeNull();
      expect(blocked.startCode).toBeNull();
      expect(blocked.status).toBe('driver_en_route');

      const afterwards = await start(trip, { start_code: code });
      expect(afterwards.status).toBe(409);
      expect(afterwards.body.code).toBe('START_CODE_BLOCKED');
      expect(afterwards.body.blocked_at).toBe(fifth.body.blocked_at);
      const final = await readStartState(world, trip.tripRequestId);
      expect(final.status).toBe('driver_en_route');
      expect(final.attempts).toBe(5);
    });

    it('a blocked trip still lets the driver mark the arrival, so the no-show grace can run', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));
      for (let i = 0; i < 5; i += 1) await start(trip, { start_code: wrong });

      const arrived = await http
        .post(`/trips/${trip.tripRequestId}/arrived`)
        .set('Authorization', driverAuth(world.jwt, trip.driver.driverId, companyId))
        .send({});

      expect(arrived.status).toBe(200);
    });
  });

  describe('concurrency on the same row', () => {
    it('eight wrong codes at the same time count exactly five and block once', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));

      const responses = await Promise.all(Array.from({ length: 8 }, () => start(trip, { start_code: wrong })));

      const invalid = responses.filter((r) => r.status === 422);
      const blocked = responses.filter((r) => r.status === 409);
      expect(invalid).toHaveLength(4);
      expect(blocked).toHaveLength(4);
      expect(invalid.map((r) => r.body.attempts_remaining).sort()).toEqual([1, 2, 3, 4]);
      expect(new Set(blocked.map((r) => r.body.blocked_at)).size).toBe(1);
      const state = await readStartState(world, trip.tripRequestId);
      expect(state.attempts).toBe(5);
      expect(state.blockedAt).not.toBeNull();
    });

    it('three wrong codes at the same time with four failures already: five in total and a single block', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));
      for (let i = 0; i < 4; i += 1) await start(trip, { start_code: wrong }).expect(422);

      const responses = await Promise.all(Array.from({ length: 3 }, () => start(trip, { start_code: wrong })));

      expect(responses.map((r) => r.status)).toEqual([409, 409, 409]);
      expect(new Set(responses.map((r) => r.body.blocked_at)).size).toBe(1);
      const state = await readStartState(world, trip.tripRequestId);
      expect(state.attempts).toBe(5);
    });

    it('the right code and a fifth wrong one at the same time: it starts or it blocks, never both', async () => {
      const outcomes = new Set<string>();
      for (let round = 0; round < 10; round += 1) {
        const trip = await newTrip();
        const code = await codeOf(trip);
        const wrong = wrongCodeFor(code);
        for (let i = 0; i < 4; i += 1) await start(trip, { start_code: wrong }).expect(422);

        const [correct, incorrect] = await Promise.all([start(trip, { start_code: code }), start(trip, { start_code: wrong })]);

        const state = await readStartState(world, trip.tripRequestId);
        if (state.status === 'in_progress') {
          outcomes.add('started');
          expect(correct.status).toBe(200);
          expect(incorrect.status).toBe(200);
          expect(incorrect.body.idempotent).toBe(true);
          expect(state.blockedAt).toBeNull();
          expect(state.attempts).toBe(4);
        } else {
          outcomes.add('blocked');
          expect(state.status).toBe('driver_en_route');
          expect(state.blockedAt).not.toBeNull();
          expect(state.attempts).toBe(5);
          expect(correct.status).toBe(409);
          expect(correct.body.code).toBe('START_CODE_BLOCKED');
          expect(incorrect.status).toBe(409);
        }
      }
      expect(outcomes.size).toBeGreaterThan(0);
    });

    it('two simultaneous takes of the same trip produce a single code', async () => {
      const driverA = await createDriver(world.prisma, companyId, CENTER);
      const driverB = await createDriver(world.prisma, companyId, CENTER);
      await grantLocationConsent(world.prisma, driverA.driverId);
      await grantLocationConsent(world.prisma, driverB.driverId);
      const { createPendingTrip } = await import('./support/dispatch-world');
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerA = await createOffer(world.prisma, trip.tripRequestId, driverA, companyId);
      const offerB = await createOffer(world.prisma, trip.tripRequestId, driverB, companyId);

      const [a, b] = await Promise.all([
        http
          .post(`/assignments/${offerA}/accept`)
          .set('Authorization', driverAuth(world.jwt, driverA.driverId, companyId))
          .send({}),
        http
          .post(`/assignments/${offerB}/accept`)
          .set('Authorization', driverAuth(world.jwt, driverB.driverId, companyId))
          .send({}),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const state = await readStartState(world, trip.tripRequestId);
      expect(state.status).toBe('assigned');
      expect(state.startCode).toMatch(/^[0-9]{4}$/);
      expect(state.attempts).toBe(0);
    });
  });

  describe('reassignment (MD-18) and inherited trips', () => {
    it('when the first driver cancels in assigned, the next driver gets a new code with the counter at zero', async () => {
      const trip = await newTrip('accepted');
      const first = await codeOf(trip);
      await http
        .post(`/assignments/${trip.assignmentId}/cancel`)
        .set('Authorization', driverAuth(world.jwt, trip.driver.driverId, companyId))
        .send({ reason: 'Se me dañó el carro' })
        .expect(200);
      expect((await readStartState(world, trip.tripRequestId)).startCode).toBeNull();

      const next = await createDriver(world.prisma, companyId, CENTER);
      await grantLocationConsent(world.prisma, next.driverId);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, next, companyId);
      await http
        .post(`/assignments/${offerId}/accept`)
        .set('Authorization', driverAuth(world.jwt, next.driverId, companyId))
        .send({})
        .expect(200);

      const state = await readStartState(world, trip.tripRequestId);
      expect(state.status).toBe('assigned');
      expect(state.startCode).toMatch(/^[0-9]{4}$/);
      expect(state.attempts).toBe(0);
      expect(typeof first).toBe('string');
    });

    ownerIt('an inherited (exempt) trip starts without a code and ignores a wrong one', async () => {
      const withoutCode = await newTrip();
      const withWrongCode = await newTrip();
      for (const trip of [withoutCode, withWrongCode]) {
        await (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
          await tx.$executeRawUnsafe(
            `UPDATE trips.trip_request SET start_code = NULL, start_code_exempt = true WHERE trip_request_id = ${trip.tripRequestId}`,
          );
        });
      }

      const first = await start(withoutCode);
      const second = await start(withWrongCode, { start_code: '9999' });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await readStartState(world, withWrongCode.tripRequestId)).attempts).toBe(0);
    });

    ownerIt('an inherited trip that is reopened asks for a code from the next driver', async () => {
      const trip = await newTrip('accepted');
      await (owner as PrismaClient).$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe(
          `UPDATE trips.trip_request SET start_code = NULL, start_code_exempt = true WHERE trip_request_id = ${trip.tripRequestId}`,
        );
      });
      await http
        .post(`/assignments/${trip.assignmentId}/cancel`)
        .set('Authorization', driverAuth(world.jwt, trip.driver.driverId, companyId))
        .send({ reason: 'Se me dañó el carro' })
        .expect(200);
      const next = await createDriver(world.prisma, companyId, CENTER);
      await grantLocationConsent(world.prisma, next.driverId);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, next, companyId);
      await http
        .post(`/assignments/${offerId}/accept`)
        .set('Authorization', driverAuth(world.jwt, next.driverId, companyId))
        .send({})
        .expect(200);

      const state = await readStartState(world, trip.tripRequestId);

      expect(state.exempt).toBe(false);
      expect(state.startCode).toMatch(/^[0-9]{4}$/);
    });
  });

  describe('cancellation by the passenger with the start blocked (P-CI-06)', () => {
    async function ageAssignment(trip: WindowTrip): Promise<void> {
      await world.prisma.$executeRaw`
        UPDATE trips.trip_request SET assigned_at = (now() AT TIME ZONE 'UTC') - interval '30 minutes'
         WHERE trip_request_id = ${trip.tripRequestId}`;
    }

    it('without a block, cancelling after the free window records the penalty (control)', async () => {
      const trip = await newTrip();
      await ageAssignment(trip);

      const response = await http
        .post(`/trips/${trip.tripRequestId}/cancel`)
        .set('Authorization', passengerAuth(world.jwt, trip.passengerId))
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.penalty_recorded).toBe(true);
      expect(response.body.free_of_charge).toBe(false);
    });

    it('with the start blocked, the same cancellation is free and records no penalty', async () => {
      const trip = await newTrip();
      const wrong = wrongCodeFor(await codeOf(trip));
      for (let i = 0; i < 5; i += 1) await start(trip, { start_code: wrong });
      await ageAssignment(trip);

      const response = await http
        .post(`/trips/${trip.tripRequestId}/cancel`)
        .set('Authorization', passengerAuth(world.jwt, trip.passengerId))
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.penalty_recorded).toBe(false);
      expect(response.body.free_of_charge).toBe(true);
      const rows = await world.prisma.$queryRaw<Array<{ penalty_recorded: boolean }>>`
        SELECT penalty_recorded FROM trips.trip_request WHERE trip_request_id = ${trip.tripRequestId}`;
      expect(rows[0]?.penalty_recorded).toBe(false);
    });
  });
});
