import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  type DriverFixture,
  type World,
  createDriver,
  createOffer,
  createPendingTrip,
  driverAuth,
} from './dispatch-world';
import { grantLocationConsent } from './grant-location-consent';

export interface WindowTrip {
  tripRequestId: number;
  passengerId: number;
  driver: DriverFixture;
  assignmentId: number;
  companyId: number;
}

export interface WindowTripOptions {
  municipalityId: number;
  companyId: number;
  pickup: { lat: number; lng: number };
  driverPosition?: { lat: number; lng: number } | null;
  passengerId?: number;
  consent?: boolean;
}

export async function createAcceptedTrip(world: World, options: WindowTripOptions): Promise<WindowTrip> {
  const driver = await createDriver(
    world.prisma,
    options.companyId,
    options.driverPosition === undefined ? options.pickup : options.driverPosition,
  );
  if (options.consent !== false) await grantLocationConsent(world.prisma, driver.driverId);
  const trip = await createPendingTrip(world.prisma, options.municipalityId, options.pickup, {
    passengerId: options.passengerId,
  });
  const assignmentId = await createOffer(world.prisma, trip.tripRequestId, driver, options.companyId);
  const accepted = await request(world.app.getHttpServer())
    .post(`/assignments/${assignmentId}/accept`)
    .set('Authorization', driverAuth(world.jwt, driver.driverId, options.companyId))
    .send({});
  if (accepted.status !== 200) throw new Error(`accept failed with ${accepted.status}`);
  return {
    tripRequestId: trip.tripRequestId,
    passengerId: trip.passengerId,
    driver,
    assignmentId,
    companyId: options.companyId,
  };
}

export async function createEnRouteTrip(world: World, options: WindowTripOptions): Promise<WindowTrip> {
  const trip = await createAcceptedTrip(world, options);
  const response = await request(world.app.getHttpServer())
    .post(`/trips/${trip.tripRequestId}/en-route`)
    .set('Authorization', driverAuth(world.jwt, trip.driver.driverId, trip.companyId))
    .send({});
  if (response.status !== 200) throw new Error(`en-route failed with ${response.status}`);
  return trip;
}

export interface StartCodeState {
  status: string;
  startCode: string | null;
  attempts: number;
  blockedAt: Date | null;
  startedAt: Date | null;
  exempt: boolean;
}

export async function readStartState(world: World, tripRequestId: number): Promise<StartCodeState> {
  const rows = await world.prisma.$queryRaw<
    Array<{
      status: string;
      start_code: string | null;
      attempts: number;
      blocked_at: Date | null;
      started_at: Date | null;
      exempt: boolean;
    }>
  >`
    SELECT status::text AS status, start_code, start_code_failed_attempts::int AS attempts,
           start_code_blocked_at AS blocked_at, started_at, start_code_exempt AS exempt
      FROM trips.trip_request WHERE trip_request_id = ${tripRequestId}`;
  const row = rows[0];
  if (!row) throw new Error('trip not found');
  return {
    status: row.status,
    startCode: row.start_code,
    attempts: row.attempts,
    blockedAt: row.blocked_at,
    startedAt: row.started_at,
    exempt: row.exempt,
  };
}

export async function startCodeOf(
  client: Pick<PrismaClient, '$queryRaw'>,
  tripRequestId: number,
): Promise<string> {
  const rows = await client.$queryRaw<Array<{ start_code: string | null }>>`
    SELECT start_code FROM trips.trip_request WHERE trip_request_id = ${tripRequestId}`;
  const code = rows[0]?.start_code;
  if (!code) throw new Error('the trip has no start code');
  return code;
}

export function wrongCodeFor(code: string): string {
  return code === '0000' ? '0001' : '0000';
}
