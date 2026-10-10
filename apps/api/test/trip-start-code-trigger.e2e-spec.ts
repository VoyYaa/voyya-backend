import type { PrismaClient } from '@prisma/client';
import { START_CODE_MAX_FAILED_ATTEMPTS } from '@voyyaa/shared';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import {
  type World,
  bootWorld,
  createCoveredMunicipality,
  createDriver,
  createOffer,
  createOperatingCompany,
  createPendingTrip,
  ownerClient,
} from './support/dispatch-world';
import { createFreshPassenger } from './support/fresh-passenger';
import { purgeMunicipalitiesByNamePrefix } from './support/purge-test-fixtures';

const url = process.env.PG_TEST_URL;
const ownerUrl = process.env.PG_TEST_OWNER_URL;
const suite = url ? describe : describe.skip;
const ownerIt = ownerUrl ? it : it.skip;

const PREFIX = '_StartCode';
const CENTER = { lat: 12.35, lng: -69.35 };

jest.setTimeout(90_000);

interface StartCodeRow {
  status: string;
  start_code: string | null;
  start_code_failed_attempts: number;
  start_code_blocked_at: Date | null;
  start_code_exempt: boolean;
}

async function rejection(promise: Promise<unknown>): Promise<{ message: string; sqlState: string }> {
  try {
    await promise;
  } catch (error) {
    const meta = (error as { meta?: { code?: string } }).meta;
    return {
      message: error instanceof Error ? error.message : String(error),
      sqlState: meta?.code ?? '',
    };
  }
  return { message: '', sqlState: '' };
}

suite('ADR-033 start code: trigger and constraints against real Postgres as app_voyya', () => {
  let world: World;
  let municipalityId: number;
  let companyId: number;
  let owner: PrismaClient | null = null;

  const startRow = async (tripRequestId: number): Promise<StartCodeRow> => {
    const rows = await world.prisma.$queryRaw<StartCodeRow[]>`
      SELECT status::text AS status, start_code, start_code_failed_attempts::int AS start_code_failed_attempts,
             start_code_blocked_at, start_code_exempt
        FROM trips.trip_request WHERE trip_request_id = ${tripRequestId}`;
    const row = rows[0];
    if (!row) throw new Error('trip not found');
    return row;
  };

  const setStatus = (tripRequestId: number, status: string) =>
    world.prisma.$executeRaw`
      UPDATE trips.trip_request SET status = ${status}::trips."TripStatus" WHERE trip_request_id = ${tripRequestId}`;

  const addAttempts = (tripRequestId: number, attempts: number) =>
    world.prisma.$executeRaw`
      UPDATE trips.trip_request
         SET start_code_failed_attempts = ${attempts},
             start_code_blocked_at = CASE WHEN ${attempts} >= 5 THEN now() AT TIME ZONE 'UTC' END,
             start_code = CASE WHEN ${attempts} >= 5 THEN NULL ELSE start_code END
       WHERE trip_request_id = ${tripRequestId}`;

  const tripIn = async (status: 'assigned' | 'driver_en_route') =>
    (await createPendingTrip(world.prisma, municipalityId, CENTER, { status, companyId })).tripRequestId;

  beforeAll(async () => {
    world = await bootWorld();
    owner = ownerClient();
    municipalityId = await createCoveredMunicipality(world.prisma, PREFIX, CENTER);
    companyId = await createOperatingCompany(world.prisma, municipalityId);
  });

  afterAll(async () => {
    await owner?.$disconnect();
    if (world) {
      await purgeMunicipalitiesByNamePrefix(world.prisma, PREFIX);
      await world.app.close();
    }
  });

  describe('generation by the database', () => {
    it.each(['assigned', 'driver_en_route'] as const)('a trip inserted as %s gets a four digit code', async (status) => {
      const row = await startRow(await tripIn(status));

      expect(row.start_code).toMatch(/^[0-9]{4}$/);
      expect(row.start_code_failed_attempts).toBe(0);
      expect(row.start_code_blocked_at).toBeNull();
      expect(row.start_code_exempt).toBe(false);
    });

    it('a trip inserted as pending_assignment has no code', async () => {
      const { tripRequestId } = await createPendingTrip(world.prisma, municipalityId, CENTER);

      expect((await startRow(tripRequestId)).start_code).toBeNull();
    });

    it('the real take writes the code in the same statement that assigns the trip', async () => {
      const driver = await createDriver(world.prisma, companyId, CENTER);
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);
      const repository = world.moduleRef.get(AssignmentRepository);

      const took = await world.prisma.runInTenant(companyId, (tx) =>
        repository.markTripRequestAssigned(tx, {
          tripRequestId: trip.tripRequestId,
          assignmentId: offerId,
          driverId: driver.driverId,
          companyId,
        }),
      );

      expect(took).toBe(true);
      const row = await startRow(trip.tripRequestId);
      expect(row.status).toBe('assigned');
      expect(row.start_code).toMatch(/^[0-9]{4}$/);
    });

    it('the take freezes the distance from the driver to the pickup point in meters', async () => {
      const driver = await createDriver(world.prisma, companyId, { lat: CENTER.lat + 0.01, lng: CENTER.lng });
      const trip = await createPendingTrip(world.prisma, municipalityId, CENTER);
      const offerId = await createOffer(world.prisma, trip.tripRequestId, driver, companyId);

      await world.prisma.runInTenant(companyId, (tx) =>
        world.moduleRef.get(AssignmentRepository).markTripRequestAssigned(tx, {
          tripRequestId: trip.tripRequestId,
          assignmentId: offerId,
          driverId: driver.driverId,
          companyId,
        }),
      );

      const rows = await world.prisma.$queryRaw<Array<{ meters: number | null }>>`
        SELECT pickup_distance_at_assignment_m AS meters FROM trips.trip_request
         WHERE trip_request_id = ${trip.tripRequestId}`;
      expect(rows[0]?.meters).toBeGreaterThan(1050);
      expect(rows[0]?.meters).toBeLessThan(1170);
    });

    it('a code sent by the application is rejected on update', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      const current = (await startRow(tripRequestId)).start_code as string;
      const other = current === '1234' ? '4321' : '1234';

      const outcome = await rejection(
        world.prisma
          .$executeRaw`UPDATE trips.trip_request SET start_code = ${other} WHERE trip_request_id = ${tripRequestId}`,
      );

      expect(outcome.sqlState).toBe('23514');
      expect(outcome.message).toContain('ADR-033');
      expect((await startRow(tripRequestId)).start_code).toBe(current);
    });

    it('a code sent by the application is replaced on insert', async () => {
      const { tripRequestId } = await createPendingTrip(world.prisma, municipalityId, CENTER, {
        status: 'assigned',
        companyId,
      });
      const generated = (await startRow(tripRequestId)).start_code as string;
      const forced = generated === '0000' ? '1111' : '0000';
      const otherPassenger = await createFreshPassenger(world.prisma);

      const rows = await world.prisma.$queryRaw<Array<{ start_code: string | null }>>`
        INSERT INTO trips.trip_request
          (passenger_id, municipality_id, service_type, payment_method, status, fare, commission, company_id,
           start_code, updated_at, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, pickup_address, dropoff_address)
        SELECT ${otherPassenger}::int, municipality_id, service_type, payment_method, 'assigned'::trips."TripStatus",
               fare, commission, company_id, ${forced}, now() AT TIME ZONE 'UTC', pickup_lat, pickup_lng,
               dropoff_lat, dropoff_lng, pickup_address, dropoff_address
          FROM trips.trip_request WHERE trip_request_id = ${tripRequestId}
        RETURNING start_code`;

      expect(rows[0]?.start_code).toMatch(/^[0-9]{4}$/);
    });

    it('the database regenerates the code when a trip comes back into the window', async () => {
      const tripRequestId = await tripIn('assigned');
      await setStatus(tripRequestId, 'pending_assignment');
      expect((await startRow(tripRequestId)).start_code).toBeNull();

      await setStatus(tripRequestId, 'assigned');

      const row = await startRow(tripRequestId);
      expect(row.start_code).toMatch(/^[0-9]{4}$/);
      expect(row.start_code_failed_attempts).toBe(0);
    });

    it('repeated takes produce independent codes with the counter at zero each time (MD-18)', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 12; i += 1) {
        const tripRequestId = await tripIn('assigned');
        await setStatus(tripRequestId, 'pending_assignment');
        await setStatus(tripRequestId, 'assigned');
        const row = await startRow(tripRequestId);
        codes.add(row.start_code as string);
        expect(row.start_code_failed_attempts).toBe(0);
      }
      expect(codes.size).toBeGreaterThan(1);
    });
  });

  describe('the code disappears as soon as it stops being useful', () => {
    it.each(['in_progress', 'cancelled_by_passenger', 'cancelled_by_driver', 'no_show'])(
      'leaving the window for %s erases the code and keeps the history of attempts',
      async (status) => {
        const tripRequestId = await tripIn('driver_en_route');
        await addAttempts(tripRequestId, 2);

        await setStatus(tripRequestId, status);

        const row = await startRow(tripRequestId);
        expect(row.start_code).toBeNull();
        expect(row.start_code_failed_attempts).toBe(2);
      },
    );

    it('reopening an assigned trip without attempts clears the code', async () => {
      const tripRequestId = await tripIn('assigned');

      await setStatus(tripRequestId, 'pending_assignment');

      const row = await startRow(tripRequestId);
      expect(row.start_code).toBeNull();
      expect(row.start_code_failed_attempts).toBe(0);
    });
  });

  describe('no manual unlock: attempts, block and exemption cannot be undone', () => {
    it('the counter cannot go down', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      await addAttempts(tripRequestId, 3);

      const outcome = await rejection(addAttempts(tripRequestId, 1));

      expect(outcome.sqlState).toBe('23514');
      expect((await startRow(tripRequestId)).start_code_failed_attempts).toBe(3);
    });

    it('a blocked trip cannot be unblocked', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      await addAttempts(tripRequestId, 5);

      const outcome = await rejection(
        world.prisma
          .$executeRaw`UPDATE trips.trip_request SET start_code_blocked_at = NULL, start_code_failed_attempts = 4 WHERE trip_request_id = ${tripRequestId}`,
      );

      expect(outcome.sqlState).toBe('23514');
      const row = await startRow(tripRequestId);
      expect(row.start_code_blocked_at).not.toBeNull();
      expect(row.start_code_failed_attempts).toBe(5);
    });

    it('a trip cannot be marked exempt after the migration', async () => {
      const tripRequestId = await tripIn('driver_en_route');

      const outcome = await rejection(
        world.prisma
          .$executeRaw`UPDATE trips.trip_request SET start_code_exempt = true, start_code = NULL WHERE trip_request_id = ${tripRequestId}`,
      );

      expect(outcome.sqlState).toBe('23514');
      expect((await startRow(tripRequestId)).start_code_exempt).toBe(false);
    });

    it('C-1: a blocked trip in driver_en_route cannot go back to pending_assignment', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      await addAttempts(tripRequestId, 5);

      const outcome = await rejection(setStatus(tripRequestId, 'pending_assignment'));

      expect(outcome.sqlState).toBe('23514');
      expect(outcome.message).toContain('cannot be reopened');
      const row = await startRow(tripRequestId);
      expect(row.status).toBe('driver_en_route');
      expect(row.start_code_failed_attempts).toBe(5);
      expect(row.start_code_blocked_at).not.toBeNull();
    });

    it('C-1: a blocked trip that went to no_show cannot come back to assigned', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      await addAttempts(tripRequestId, 5);
      await setStatus(tripRequestId, 'no_show');

      const outcome = await rejection(setStatus(tripRequestId, 'assigned'));

      expect(outcome.sqlState).toBe('23514');
      const row = await startRow(tripRequestId);
      expect(row.status).toBe('no_show');
      expect(row.start_code_failed_attempts).toBe(5);
      expect(row.start_code_blocked_at).not.toBeNull();
    });

    it('C-1: a trip with some failed attempts that was closed cannot re-enter the window either', async () => {
      const tripRequestId = await tripIn('driver_en_route');
      await addAttempts(tripRequestId, 2);
      await setStatus(tripRequestId, 'no_show');

      const outcome = await rejection(setStatus(tripRequestId, 'driver_en_route'));

      expect(outcome.sqlState).toBe('23514');
      expect((await startRow(tripRequestId)).start_code_failed_attempts).toBe(2);
    });

    it('a trip with attempts can still move inside the window', async () => {
      const tripRequestId = await tripIn('assigned');
      await addAttempts(tripRequestId, 1);

      await setStatus(tripRequestId, 'driver_en_route');

      const row = await startRow(tripRequestId);
      expect(row.status).toBe('driver_en_route');
      expect(row.start_code_failed_attempts).toBe(1);
      expect(row.start_code).toMatch(/^[0-9]{4}$/);
    });
  });

  describe('the five CHECK constraints are the safety net (the trigger is bypassed as owner)', () => {
    async function asReplica(statement: string, tripRequestId: number): Promise<string> {
      class RolledBack extends Error {}
      let message = '';
      try {
        await (owner as PrismaClient).$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
          try {
            await tx.$executeRawUnsafe(statement.replace(':id', String(tripRequestId)));
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          throw new RolledBack('rollback');
        });
      } catch (error) {
        if (!(error instanceof RolledBack)) throw error;
      }
      return message;
    }

    ownerIt.each([
      [
        'trip_request_start_code_format',
        "UPDATE trips.trip_request SET start_code = '12a4' WHERE trip_request_id = :id",
      ],
      [
        'trip_request_start_code_attempts',
        'UPDATE trips.trip_request SET start_code_failed_attempts = 6 WHERE trip_request_id = :id',
      ],
      [
        'trip_request_start_code_blocked',
        'UPDATE trips.trip_request SET start_code_failed_attempts = 5 WHERE trip_request_id = :id',
      ],
      [
        'trip_request_start_code_window',
        "UPDATE trips.trip_request SET status = 'in_progress' WHERE trip_request_id = :id",
      ],
      [
        'trip_request_start_code_present',
        'UPDATE trips.trip_request SET start_code = NULL WHERE trip_request_id = :id',
      ],
    ])('%s rejects its violation', async (constraint, statement) => {
      const tripRequestId = await tripIn('driver_en_route');

      expect(await asReplica(statement, tripRequestId)).toContain(constraint);
    });
  });

  describe('the attempts constant matches the CHECK', () => {
    it('START_CODE_MAX_FAILED_ATTEMPTS is the number the constraint allows', async () => {
      const rows = await world.prisma.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conname = 'trip_request_start_code_attempts'`;

      expect(rows[0]?.definition).toContain(`${START_CODE_MAX_FAILED_ATTEMPTS}`);
    });
  });
});
