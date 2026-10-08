import { NotFoundException } from '@nestjs/common';
import type { OpsDriverQuery, OpsQueueQuery } from '@voyyaa/shared';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { OperationalParamsService } from '../assignment/operational-params.service';
import { CompanyMunicipalityResolver } from './company-municipality.resolver';
import { OpsConsoleRepository } from './ops-console.repository';
import { OpsConsoleService } from './ops-console.service';

const COMPANY_ID = 1;
const MUNICIPALITY_ID = 10;

function fakePrisma(): PrismaService {
  return {
    runInTenant: jest.fn((_companyId: number, fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PrismaService;
}

function create(locationStaleMin = 15) {
  const repo = {
    listTripRequests: jest.fn().mockResolvedValue([]),
    getTripRequest: jest.fn().mockResolvedValue(null),
    listDrivers: jest.fn().mockResolvedValue([]),
    getDriver: jest.fn().mockResolvedValue(null),
  };
  const companyMunicipality = { resolve: jest.fn().mockResolvedValue(MUNICIPALITY_ID) };
  const params = { get: jest.fn().mockResolvedValue({ locationStaleMin }) };
  const service = new OpsConsoleService(
    fakePrisma(),
    repo as unknown as OpsConsoleRepository,
    companyMunicipality as unknown as CompanyMunicipalityResolver,
    params as unknown as OperationalParamsService,
  );
  return { service, repo, companyMunicipality, params };
}

describe('OpsConsoleService.listTripRequests', () => {
  it('maps rows and stamps server_time', async () => {
    const { service, repo } = create();
    repo.listTripRequests.mockResolvedValue([
      {
        tripRequestId: 1,
        status: 'pending_assignment',
        requestedAt: new Date('2026-01-01T00:00:00.000Z'),
        statusSince: new Date('2026-01-01T00:00:00.000Z'),
        passengerName: 'Ana Pérez',
        pickupAddress: 'A',
        dropoffAddress: 'B',
        fareTotal: 10000,
        driver: null,
      },
    ]);

    const query: OpsQueueQuery = { status: 'all', limit: 100 };
    const result = await service.listTripRequests(COMPANY_ID, query);

    expect(result.server_time).toEqual(expect.any(String));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      trip_request_id: 1,
      passenger_name: 'Ana Pérez',
      fare_total: 10000,
      driver: null,
    });
  });

  it('translates the status filter chip into the underlying TripStatus set', async () => {
    const { service, repo } = create();

    await service.listTripRequests(COMPANY_ID, { status: 'no_driver', limit: 100 });

    expect(repo.listTripRequests).toHaveBeenCalledWith(
      expect.anything(),
      MUNICIPALITY_ID,
      ['no_driver', 'expired'],
      100,
      60,
    );
  });

  it('"all" passes a null status filter (no restriction beyond the terminal window)', async () => {
    const { service, repo } = create();

    await service.listTripRequests(COMPANY_ID, { status: 'all', limit: 100 });

    expect(repo.listTripRequests).toHaveBeenCalledWith(
      expect.anything(),
      MUNICIPALITY_ID,
      null,
      100,
      60,
    );
  });
});

describe('OpsConsoleService.getTripRequest', () => {
  it('masks the passenger phone and never leaks it raw', async () => {
    const { service, repo } = create();
    repo.getTripRequest.mockResolvedValue({
      tripRequestId: 1,
      status: 'completed',
      statusSince: new Date(),
      pickupAddress: 'A',
      dropoffAddress: 'B',
      fareTotal: 10000,
      commission: 800,
      passengerName: 'Ana Pérez',
      passengerPhone: '3001234567',
      driver: null,
      requestedAt: new Date(),
      assignedAt: null,
      arrivedAt: null,
      finishedAt: null,
      cashCollectedAt: null,
    });

    const result = await service.getTripRequest(COMPANY_ID, 1);

    expect(result.passenger_phone_masked).toBe('***4567');
    expect(JSON.stringify(result)).not.toContain('3001234567');
  });

  it('trip request not found -> 404 TRIP_REQUEST_NOT_FOUND', async () => {
    const { service } = create();
    await expect(service.getTripRequest(COMPANY_ID, 999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('OpsConsoleService.listDrivers / getDriver — location_stale', () => {
  it('a driver whose location was updated inside the window is not stale', async () => {
    const { service, repo } = create(15);
    repo.listDrivers.mockResolvedValue([
      driverRow({ locationUpdatedAt: new Date(Date.now() - 5 * 60_000) }),
    ]);

    const query: OpsDriverQuery = { limit: 100 };
    const result = await service.listDrivers(COMPANY_ID, query);

    expect(result.rows[0]?.location_stale).toBe(false);
  });

  it('a driver whose location is older than location_stale_min is stale', async () => {
    const { service, repo } = create(15);
    repo.listDrivers.mockResolvedValue([
      driverRow({ locationUpdatedAt: new Date(Date.now() - 30 * 60_000) }),
    ]);

    const result = await service.listDrivers(COMPANY_ID, { limit: 100 });

    expect(result.rows[0]?.location_stale).toBe(true);
  });

  it('location_stale_min=0 disables the staleness check entirely', async () => {
    const { service, repo } = create(0);
    repo.listDrivers.mockResolvedValue([driverRow({ locationUpdatedAt: null })]);

    const result = await service.listDrivers(COMPANY_ID, { limit: 100 });

    expect(result.rows[0]?.location_stale).toBe(false);
  });

  it('a driver who never reported a location is stale (when the parameter is enabled)', async () => {
    const { service, repo } = create(15);
    repo.listDrivers.mockResolvedValue([driverRow({ locationUpdatedAt: null })]);

    const result = await service.listDrivers(COMPANY_ID, { limit: 100 });

    expect(result.rows[0]?.location_stale).toBe(true);
  });

  it('never exposes current_lat/current_lng in the roster response', async () => {
    const { service, repo } = create();
    repo.listDrivers.mockResolvedValue([driverRow({})]);

    const result = await service.listDrivers(COMPANY_ID, { limit: 100 });

    expect(JSON.stringify(result)).not.toMatch(/current_lat|current_lng/);
  });

  it('getDriver: not found -> 404 DRIVER_NOT_FOUND', async () => {
    const { service } = create();
    await expect(service.getDriver(COMPANY_ID, 999)).rejects.toBeInstanceOf(NotFoundException);
  });
});

function driverRow(overrides: Partial<{ locationUpdatedAt: Date | null }>) {
  return {
    driverId: 1,
    firstName: 'Juan',
    lastName: 'Conductor',
    nationalId: '71000099',
    phone: '3009998877',
    status: 'available' as const,
    vehicle: { vehicleId: 1, plate: 'ABC123', model: 'Renault Logan' },
    locationUpdatedAt: null,
    pinDeliveredAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}
