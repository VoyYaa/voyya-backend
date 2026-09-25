import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AssignmentRepository } from '../src/modules/assignment/assignment.repository';
import { TripClosingService } from '../src/modules/assignment/trip-closing.service';
import type { AssignmentService } from '../src/modules/assignment/assignment.service';
import type { EnvService } from '../src/config/env.service';
import type { HolidaysProvider } from '../src/modules/trips/holidays/holidays.provider';
import type { QuoteTokenService } from '../src/modules/trips/quote-token.service';
import { ActiveCompanyResolver } from '../src/modules/tenancy/active-company.resolver';
import { TripsRepository } from '../src/modules/trips/trips.repository';
import { TripsService } from '../src/modules/trips/trips.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { RequestContextService } from '../src/infrastructure/observability/request-context.service';

const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite('V-03 · assigned_at timestamp is not 5h off with the session in America/Bogota (real Postgres)', () => {
  let raw: PrismaClient;
  let prismaService: PrismaService;
  let assignmentRepo: AssignmentRepository;
  let tripClosing: TripClosingService;
  let tripsRepo: TripsRepository;
  let tripsService: TripsService;
  let companyId: number;
  let municipalityId: number;
  let passengerId: number;

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
          await tx.$executeRaw`SET TIME ZONE 'America/Bogota'`;
          await tx.$executeRaw`SELECT set_config('app.current_company', ${String(cId)}, true)`;
          return fn(tx);
        }),
    } as unknown as PrismaService;

    assignmentRepo = new AssignmentRepository(prismaService);
    const activeCompanyResolver = new ActiveCompanyResolver(prismaService);
    tripClosing = new TripClosingService(prismaService, assignmentRepo, activeCompanyResolver);
    tripsRepo = new TripsRepository(raw as unknown as PrismaService);

    const fakeEnv = { get: (k: string) => (k === 'CANCELLATION_WINDOW_MIN' ? 2 : undefined) } as unknown as EnvService;
    const fakeQuoteToken = {} as unknown as QuoteTokenService;
    const fakeEmitter = { emit: () => true } as unknown as EventEmitter2;
    const fakeHolidays: HolidaysProvider = { isHoliday: () => false };
    const fakeAssignment = {} as unknown as AssignmentService;

    tripsService = new TripsService(
      tripsRepo,
      fakeQuoteToken,
      fakeEnv,
      fakeEmitter,
      fakeHolidays,
      fakeAssignment,
      tripClosing,
      activeCompanyResolver,
      new RequestContextService(),
    );

    const municipality = await raw.municipality.upsert({
      where: { municipalityId: 9003 },
      update: {},
      create: {
        municipalityId: 9003,
        name: '_V03TestMuni',
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
      where: { taxId: '_v03-timezone-penalty-test' },
      update: { status: 'active' },
      create: {
        legalName: '_V03TestCo',
        taxId: '_v03-timezone-penalty-test',
        type: 'cooperative',
        municipalityId,
        status: 'active',
      },
    });
    companyId = company.companyId;

    const passengerUser = await raw.user.upsert({
      where: { phone: '_9990000201' },
      update: {},
      create: { firstName: '_V03', lastName: 'Passenger', phone: '_9990000201', role: 'passenger' },
    });
    await raw.passenger.upsert({
      where: { passengerId: passengerUser.userId },
      update: {},
      create: { passengerId: passengerUser.userId },
    });
    passengerId = passengerUser.userId;
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

  it('markTripRequestAssigned writes assigned_at as the real current instant, not 5h in the past', async () => {
    const tripRequestId = await makePendingTrip();

    const before = Date.now();
    await prismaService.runInTenant(companyId, (tx) =>
      assignmentRepo.markTripRequestAssigned(tx, tripRequestId),
    );
    const after = Date.now();

    const t = await raw.tripRequest.findUnique({ where: { tripRequestId } });
    expect(t?.assignedAt).not.toBeNull();
    const assignedAtMs = t?.assignedAt?.getTime() ?? 0;

    expect(assignedAtMs).toBeGreaterThanOrEqual(before - 5_000);
    expect(assignedAtMs).toBeLessThanOrEqual(after + 5_000);
  });

  it('cancelling immediately after assignment, with the session in America/Bogota, does NOT record a penalty', async () => {
    const tripRequestId = await makePendingTrip();

    await prismaService.runInTenant(companyId, (tx) =>
      assignmentRepo.markTripRequestAssigned(tx, tripRequestId),
    );

    const result = await tripsService.cancel(tripRequestId, passengerId, {});

    expect(result.free_of_charge).toBe(true);
    expect(result.penalty_recorded).toBe(false);

    const t = await raw.tripRequest.findUnique({ where: { tripRequestId } });
    expect(t?.penaltyRecorded).toBe(false);
  });
});
