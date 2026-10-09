import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { TRIPS_EVENTS } from '@voyyaa/shared';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { AssignmentService } from '../../src/modules/assignment/assignment.service';
import { AllExceptionsFilter } from '../../src/shared/all-exceptions.filter';
import { createFreshPassenger } from './fresh-passenger';
import { createCompany, seedCommission, seedOpenFare, uniqueSuffix } from './platform-fixtures';

export interface World {
  app: INestApplication;
  moduleRef: TestingModule;
  prisma: PrismaService;
  jwt: JwtService;
  assignment: AssignmentService;
}

export async function bootWorld(options: { keepChainListener?: boolean } = {}): Promise<World> {
  process.env.DATABASE_URL = process.env.PG_TEST_URL;
  const { AppModule } = await import('../../src/app.module');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();
  if (options.keepChainListener !== true) {
    moduleRef.get(EventEmitter2).removeAllListeners(TRIPS_EVENTS.TRIP_REQUEST_CREATED);
  }
  return {
    app,
    moduleRef,
    prisma: moduleRef.get(PrismaService),
    jwt: moduleRef.get(JwtService, { strict: false }),
    assignment: moduleRef.get(AssignmentService),
  };
}

export function squareAround(lat: number, lng: number, half = 0.05): object {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lng - half, lat - half],
        [lng - half, lat + half],
        [lng + half, lat + half],
        [lng + half, lat - half],
        [lng - half, lat - half],
      ],
    ],
  };
}

export async function createCoveredMunicipality(
  prisma: PrismaService,
  namePrefix: string,
  center: { lat: number; lng: number },
  options: { fare?: boolean; half?: number } = {},
): Promise<number> {
  const municipality = await prisma.municipality.create({
    data: {
      name: `${namePrefix}-${uniqueSuffix()}`,
      department: 'Test',
      status: 'active',
      coveragePolygon: squareAround(center.lat, center.lng, options.half),
    },
  });
  if (options.fare !== false) await seedOpenFare(prisma, municipality.municipalityId, 'taxi', 8000);
  return municipality.municipalityId;
}

export interface CompanyOptions {
  commissionPct?: number | null;
  status?: 'pending' | 'active' | 'suspended' | 'rejected';
  publicName?: string | null;
}

export async function createOperatingCompany(
  prisma: PrismaService,
  municipalityId: number,
  options: CompanyOptions = {},
): Promise<number> {
  const companyId = await createCompany(prisma, municipalityId, {
    status: options.status ?? 'active',
    ...(options.publicName !== undefined ? { publicName: options.publicName } : {}),
  });
  if (options.commissionPct !== null) {
    await seedCommission(prisma, companyId, options.commissionPct ?? 8);
  }
  return companyId;
}

export interface DriverFixture {
  driverId: number;
  vehicleId: number;
}

export async function createDriver(
  prisma: PrismaService,
  companyId: number,
  position: { lat: number; lng: number } | null,
  status: 'available' | 'off_shift' | 'on_trip' = 'available',
): Promise<DriverFixture> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      firstName: '_Fx',
      lastName: 'Driver',
      phone: `_fxd-${suffix}`,
      role: 'driver',
      companyId,
    },
  });
  const vehicle = await prisma.runInTenant(companyId, (tx) =>
    tx.vehicle.create({
      data: { plate: `_${randomInt(100_000, 999_999)}${randomInt(10, 99)}`, companyId, status: 'active' },
    }),
  );
  await prisma.runInTenant(companyId, (tx) =>
    tx.driver.create({
      data: {
        driverId: user.userId,
        companyId,
        nationalId: `_fxd-${suffix}`,
        pin: 'x',
        pinMustChange: false,
        status,
        currentVehicleId: vehicle.vehicleId,
        ...(position
          ? { currentLat: position.lat, currentLng: position.lng, locationUpdatedAt: new Date() }
          : {}),
      },
    }),
  );
  return { driverId: user.userId, vehicleId: vehicle.vehicleId };
}

export function driverAuth(jwt: JwtService, driverId: number, companyId: number): string {
  return `Bearer ${jwt.sign({ sub: driverId, role: 'driver', type: 'access', company_id: companyId })}`;
}

export function passengerAuth(jwt: JwtService, passengerId: number): string {
  return `Bearer ${jwt.sign({ sub: passengerId, role: 'passenger', type: 'access' })}`;
}

export function adminAuth(jwt: JwtService, userId: number, companyId: number): string {
  return `Bearer ${jwt.sign({ sub: userId, role: 'admin', type: 'access', company_id: companyId })}`;
}

export async function createAdminUser(prisma: PrismaService, companyId: number): Promise<number> {
  const user = await prisma.user.create({
    data: { firstName: '_Fx', lastName: 'Admin', phone: `_fxa-${randomUUID()}`, role: 'admin', companyId },
  });
  return user.userId;
}

export interface TripFixtureOptions {
  passengerId?: number;
  requestedCompanyId?: number | null;
  fare?: number;
  status?: 'pending_assignment' | 'assigned' | 'driver_en_route' | 'in_progress' | 'completed';
  companyId?: number | null;
}

export async function createPendingTrip(
  prisma: PrismaService,
  municipalityId: number,
  pickup: { lat: number; lng: number },
  options: TripFixtureOptions = {},
): Promise<{ tripRequestId: number; passengerId: number }> {
  const passengerId = options.passengerId ?? (await createFreshPassenger(prisma));
  const trip = await prisma.tripRequest.create({
    data: {
      passengerId,
      municipalityId,
      serviceType: 'taxi',
      paymentMethod: 'cash',
      pickupAddress: 'Origen',
      dropoffAddress: 'Destino',
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      dropoffLat: pickup.lat + 0.005,
      dropoffLng: pickup.lng + 0.005,
      fare: options.fare ?? 8000,
      commission: 0,
      status: options.status ?? 'pending_assignment',
      requestedCompanyId: options.requestedCompanyId ?? null,
      companyId: options.companyId ?? null,
    },
  });
  return { tripRequestId: trip.tripRequestId, passengerId };
}

export interface OfferOptions {
  status?: 'notified' | 'accepted' | 'rejected' | 'timeout' | 'cancelled';
  expiresInSec?: number;
}

export async function createOffer(
  prisma: PrismaService,
  tripRequestId: number,
  driver: DriverFixture,
  companyId: number,
  options: OfferOptions = {},
): Promise<number> {
  const assignment = await prisma.runInTenant(companyId, (tx) =>
    tx.assignment.create({
      data: {
        tripRequestId,
        driverId: driver.driverId,
        vehicleId: driver.vehicleId,
        companyId,
        status: options.status ?? 'notified',
        assignedBy: 'system',
        notifiedAt: new Date(),
        expiresAt: new Date(Date.now() + (options.expiresInSec ?? 60) * 1000),
      },
    }),
  );
  return assignment.assignmentId;
}

export async function tripRow(prisma: PrismaService, tripRequestId: number) {
  return prisma.tripRequest.findUniqueOrThrow({ where: { tripRequestId } });
}

export async function driverStatus(
  prisma: PrismaService,
  companyId: number,
  driverId: number,
): Promise<string> {
  const driver = await prisma.runInTenant(companyId, (tx) =>
    tx.driver.findFirst({ where: { driverId } }),
  );
  return driver?.status ?? 'MISSING';
}

export async function assignmentStatus(
  prisma: PrismaService,
  companyId: number,
  assignmentId: number,
): Promise<string> {
  const assignment = await prisma.runInTenant(companyId, (tx) =>
    tx.assignment.findFirst({ where: { assignmentId } }),
  );
  return assignment?.status ?? 'MISSING';
}

export async function offersOfTrip(
  prisma: PrismaService,
  companyId: number,
  tripRequestId: number,
) {
  return prisma.runInTenant(companyId, (tx) =>
    tx.assignment.findMany({ where: { tripRequestId }, orderBy: { assignmentId: 'asc' } }),
  );
}

export function ownerClient(): PrismaClient | null {
  const url = process.env.PG_TEST_OWNER_URL;
  return url ? new PrismaClient({ datasourceUrl: url }) : null;
}

export async function waitForLockWaiters(
  owner: PrismaClient,
  count: number,
  queryFragment: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await owner.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
         AND query LIKE ${`%${queryFragment}%`}`;
    if (Number(rows[0]?.waiting ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${count} lock waiters on ${queryFragment}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
