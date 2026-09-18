import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import { AssignmentService } from '../src/modules/assignment/assignment.service';
import type { CandidateRepository } from '../src/modules/assignment/candidate.repository';
import type { OperationalParamsService } from '../src/modules/assignment/operational-params.service';
import type { PushProvider } from '../src/modules/assignment/ports/push-provider.port';
import { TripClosingService } from '../src/modules/assignment/trip-closing.service';
import { TripLifecycleService } from '../src/modules/trips/trip-lifecycle.service';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import type { ActiveCompanyResolver } from '../src/modules/tenancy/active-company.resolver';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('V-01 · a driver cannot hijack another driver\'s trip after cancelling (real Postgres)', () => {
  let raw: PrismaClient;
  let prismaService: PrismaService;
  let assignmentRepo: AssignmentRepository;
  let assignmentService: AssignmentService;
  let tripClosing: TripClosingService;
  let tripLifecycle: TripLifecycleService;
  let companyId: number;
  let municipalityId: number;
  let passengerId: number;
  let driverAId: number;
  let driverBId: number;
  let vehicleAId: number;
  let vehicleBId: number;

  async function withTenant<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return raw.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company', ${String(companyId)}, true)`;
      return fn(tx);
    });
  }

  beforeAll(async () => {
    const { PrismaClient: Client } = await import('@prisma/client');
    raw = new Client({ datasources: { db: { url } } });
    await raw.$connect();

    prismaService = {
      ...raw,
      runInTenant: async <T>(
        cId: number,
        fn: (tx: Prisma.TransactionClient) => Promise<T>,
      ): Promise<T> =>
        raw.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_company', ${String(cId)}, true)`;
          return fn(tx);
        }),
    } as unknown as PrismaService;

    assignmentRepo = new AssignmentRepository(prismaService);
    const activeCompanyResolver = {
      async resolve() {
        return companyId;
      },
    } as unknown as ActiveCompanyResolver;
    tripClosing = new TripClosingService(prismaService, assignmentRepo, activeCompanyResolver);

    const candidateRepo = {} as unknown as CandidateRepository;
    const push = { async sendAssignment() {} } as unknown as PushProvider;
    const params = {
      async get() {
        return { noShowGraceMin: 5 } as never;
      },
    } as unknown as OperationalParamsService;
    const emitter = new EventEmitter2();

    assignmentService = new AssignmentService(
      prismaService,
      candidateRepo,
      assignmentRepo,
      params,
      emitter,
      push,
      tripClosing,
      activeCompanyResolver,
    );

    const tripsRepo = new TripsRepository(raw as unknown as PrismaService);
    tripLifecycle = new TripLifecycleService(tripsRepo, assignmentService, tripClosing, params, emitter);

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9002 },
      update: {},
      create: {
        municipalityId: 9002,
        name: '_V01TestMuni',
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
    municipalityId = municipality.municipalityId;

    const company = await raw.company.upsert({
      where: { taxId: '_v01-driver-ownership-test' },
      update: { status: 'active' },
      create: {
        legalName: '_V01TestCo',
        taxId: '_v01-driver-ownership-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await raw.user.upsert({
      where: { phone: '_9990000101' },
      update: {},
      create: { firstName: '_V01', lastName: 'Passenger', phone: '_9990000101', role: 'passenger' },
    });
    await raw.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;

    const vehicleA = await withTenant((tx) =>
      tx.vehicle.upsert({
        where: { plate: '_V01A01' },
        update: { status: 'active', companyId },
        create: { plate: '_V01A01', companyId, status: 'active' },
      }),
    );
    vehicleAId = vehicleA.vehicleId;

    const vehicleB = await withTenant((tx) =>
      tx.vehicle.upsert({
        where: { plate: '_V01B01' },
        update: { status: 'active', companyId },
        create: { plate: '_V01B01', companyId, status: 'active' },
      }),
    );
    vehicleBId = vehicleB.vehicleId;

    const driverAUser = await raw.user.upsert({
      where: { phone: '_9990000102' },
      update: {},
      create: { firstName: '_V01', lastName: 'DriverA', phone: '_9990000102', role: 'driver' },
    });
    driverAId = driverAUser.userId;

    const driverBUser = await raw.user.upsert({
      where: { phone: '_9990000103' },
      update: {},
      create: { firstName: '_V01', lastName: 'DriverB', phone: '_9990000103', role: 'driver' },
    });
    driverBId = driverBUser.userId;

    await withTenant((tx) =>
      tx.driver.upsert({
        where: { driverId: driverAId },
        update: { companyId, status: 'available', currentVehicleId: vehicleAId, pin: 'x' },
        create: {
          driverId: driverAId,
          companyId,
          nationalId: '_V01-DRV-A',
          pin: 'x',
          status: 'available',
          currentVehicleId: vehicleAId,
        },
      }),
    );

    await withTenant((tx) =>
      tx.driver.upsert({
        where: { driverId: driverBId },
        update: { companyId, status: 'available', currentVehicleId: vehicleBId, pin: 'x' },
        create: {
          driverId: driverBId,
          companyId,
          nationalId: '_V01-DRV-B',
          pin: 'x',
          status: 'available',
          currentVehicleId: vehicleBId,
        },
      }),
    );
  });

  afterAll(async () => {
    if (raw) await raw.$disconnect();
  });

  async function makePendingTrip(): Promise<number> {
    const trip = await raw.tripRequest.create({
      data: {
        passengerId,
        municipalityId,
        serviceType: 'taxi',
        paymentMethod: 'cash',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        pickupLat: 0.1,
        pickupLng: 0.1,
        dropoffLat: 0.2,
        dropoffLng: 0.2,
        fare: 10000,
        commission: 800,
        status: 'pending_assignment',
      },
    });
    return trip.tripRequestId;
  }

  async function notifyDriver(tripRequestId: number, driverId: number, vehicleId: number): Promise<number> {
    const assignment = await withTenant((tx) =>
      tx.assignment.create({
        data: {
          tripRequestId,
          driverId,
          vehicleId,
          companyId,
          status: 'notified',
          assignedBy: 'system',
          notifiedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
    return assignment.assignmentId;
  }

  async function getTripStatus(tripRequestId: number): Promise<string> {
    const t = await raw.tripRequest.findUnique({ where: { tripRequestId } });
    return t?.status ?? 'MISSING';
  }

  async function getDriverStatus(driverId: number): Promise<string> {
    const d = await withTenant((tx) => tx.driver.findFirst({ where: { driverId } }));
    return d?.status ?? 'MISSING';
  }

  it('reproduces the attack: A accepts, A cancels, B accepts, then A cannot act on any of the 6 lifecycle transitions', async () => {
    const tripRequestId = await makePendingTrip();

    const assignmentAId = await notifyDriver(tripRequestId, driverAId, vehicleAId);
    const acceptA = await assignmentService.accept(assignmentAId, driverAId, companyId, {});
    expect(acceptA.result).toBe('accepted');
    expect(await getTripStatus(tripRequestId)).toBe('assigned');
    expect(await getDriverStatus(driverAId)).toBe('on_trip');

    const cancelA = await assignmentService.cancelByDriver(assignmentAId, driverAId, companyId, {
      reason: 'no puedo tomar el viaje',
    });
    expect(cancelA.trip_request_status).toBe('pending_assignment');
    expect(await getDriverStatus(driverAId)).toBe('available');

    const assignmentBId = await notifyDriver(tripRequestId, driverBId, vehicleBId);
    const acceptB = await assignmentService.accept(assignmentBId, driverBId, companyId, {});
    expect(acceptB.result).toBe('accepted');
    expect(await getTripStatus(tripRequestId)).toBe('assigned');
    expect(await getDriverStatus(driverBId)).toBe('on_trip');

    await tripLifecycle.markEnRoute(tripRequestId, driverBId, companyId);
    await tripLifecycle.markArrived(tripRequestId, driverBId, companyId);
    await tripLifecycle.markStarted(tripRequestId, driverBId, companyId);
    expect(await getTripStatus(tripRequestId)).toBe('in_progress');

    await expect(tripLifecycle.markEnRoute(tripRequestId, driverAId, companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(tripLifecycle.markArrived(tripRequestId, driverAId, companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(tripLifecycle.markStarted(tripRequestId, driverAId, companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(tripLifecycle.declareNoShow(tripRequestId, driverAId, companyId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const attempt = await capture(
      tripLifecycle.complete(tripRequestId, driverAId, companyId, { cash_collected: true }),
    );
    expect(attempt).toBeInstanceOf(ForbiddenException);
    expect(attempt.getResponse()).toMatchObject({ code: 'NOT_THE_DRIVER' });

    expect(await getTripStatus(tripRequestId)).toBe('in_progress');
    expect(await getDriverStatus(driverBId)).toBe('on_trip');

    const completeB = await tripLifecycle.complete(tripRequestId, driverBId, companyId, {
      cash_collected: true,
    });
    expect(completeB.status).toBe('completed');
    expect(await getTripStatus(tripRequestId)).toBe('completed');
    expect(await getDriverStatus(driverBId)).toBe('available');

    await expect(
      tripLifecycle.confirmCashCollected(tripRequestId, driverAId, companyId),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const cashCollectedB = await tripLifecycle.confirmCashCollected(tripRequestId, driverBId, companyId);
    expect(cashCollectedB.status).toBe('completed');
  });
});

async function capture(p: Promise<unknown>): Promise<ForbiddenException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ForbiddenException) return e;
    throw e;
  }
  throw new Error('Expected a ForbiddenException to be thrown');
}
