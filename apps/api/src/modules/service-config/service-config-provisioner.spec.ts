import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CompanyCommissionRepository } from './company-commission.repository';
import type { MunicipalityFareRepository } from './municipality-fare.repository';
import type { OperationalParamsRepository } from './operational-params.repository';
import { ServiceConfigProvisioner } from './service-config-provisioner';
import type { EnsureForApprovalInput } from './service-config-provisioner';

const TX = { marker: 'tx' } as unknown as Prisma.TransactionClient;

function existingFare(id: number) {
  return { municipalityFareId: id };
}

function create(options: { currentFare?: unknown; insertedFareId?: number | null; currentCommission?: unknown } = {}) {
  const fares = {
    findCurrent: jest.fn().mockResolvedValue(options.currentFare ?? null),
    insertIfNoOpenVersion: jest.fn().mockResolvedValue(options.insertedFareId === undefined ? 50 : options.insertedFareId),
  };
  const params = { insertIfNoOpenVersion: jest.fn().mockResolvedValue(70) };
  const commissions = {
    findCurrent: jest.fn().mockResolvedValue(options.currentCommission ?? null),
    insertIfNoOpenVersion: jest.fn().mockResolvedValue(90),
    replaceOpenVersion: jest.fn().mockResolvedValue(91),
  };
  const provisioner = new ServiceConfigProvisioner(
    fares as unknown as MunicipalityFareRepository,
    params as unknown as OperationalParamsRepository,
    commissions as unknown as CompanyCommissionRepository,
  );
  return { provisioner, fares, params, commissions };
}

function input(overrides: Partial<EnsureForApprovalInput> = {}): EnsureForApprovalInput {
  return {
    companyId: 3,
    municipalityId: 4,
    serviceTypes: ['taxi'],
    initialFare: { baseFare: 9000 },
    commissionPct: 8,
    createdBy: 900,
    ...overrides,
  };
}

describe('ServiceConfigProvisioner.ensureForApproval (ADR-032 §10.2)', () => {
  it('creates the initial fare, flagged as not official and from the approval, with the default surcharges', async () => {
    const { provisioner, fares } = create();

    const result = await provisioner.ensureForApproval(TX, input());

    expect(fares.insertIfNoOpenVersion).toHaveBeenCalledWith(TX, {
      municipalityId: 4,
      serviceType: 'taxi',
      baseFare: 9000,
      nightSurchargePct: 20,
      holidaySurchargePct: 15,
      isOfficial: false,
      officialReference: null,
      origin: 'company_approval',
      originCompanyId: 3,
      createdBy: 900,
    });
    expect(result.municipalityFares).toEqual([{ serviceType: 'taxi', municipalityFareId: 50, created: true }]);
  });

  it('uses the surcharges of the initial fare when they are sent', async () => {
    const { provisioner, fares } = create();

    await provisioner.ensureForApproval(
      TX,
      input({ initialFare: { baseFare: 9000, nightSurchargePct: 30, holidaySurchargePct: 0 } }),
    );

    expect(fares.insertIfNoOpenVersion).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ nightSurchargePct: 30, holidaySurchargePct: 0 }),
    );
  });

  it('does not touch a fare that already exists and ignores the initial fare', async () => {
    const { provisioner, fares } = create({ currentFare: existingFare(12) });

    const result = await provisioner.ensureForApproval(TX, input());

    expect(fares.insertIfNoOpenVersion).not.toHaveBeenCalled();
    expect(result.municipalityFares).toEqual([{ serviceType: 'taxi', municipalityFareId: 12, created: false }]);
  });

  it('answers 409 MUNICIPALITY_FARE_REQUIRED when there is no fare and no initial fare', async () => {
    const { provisioner, commissions } = create();

    const error = await provisioner.ensureForApproval(TX, input({ initialFare: null })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'MUNICIPALITY_FARE_REQUIRED' });
    expect(commissions.insertIfNoOpenVersion).not.toHaveBeenCalled();
  });

  it('when another approval wins the insert it reuses the winning fare and reports created: false', async () => {
    const { provisioner, fares } = create({ insertedFareId: null });
    fares.findCurrent.mockResolvedValueOnce(null).mockResolvedValueOnce(existingFare(77));

    const result = await provisioner.ensureForApproval(TX, input());

    expect(result.municipalityFares).toEqual([{ serviceType: 'taxi', municipalityFareId: 77, created: false }]);
  });

  it('creates the parameters of the municipality with every value null, meaning the platform default', async () => {
    const { provisioner, params } = create();

    await provisioner.ensureForApproval(TX, input());

    const created = params.insertIfNoOpenVersion.mock.calls[0]?.[1];
    expect(created).toMatchObject({ municipalityId: 4, serviceType: 'taxi', origin: 'company_approval' });
    expect(Object.values(created.values).every((value) => value === null)).toBe(true);
    expect(Object.keys(created.values)).toHaveLength(9);
  });

  it('writes the first commission with the mandatory value, and a 0 is a real value', async () => {
    const { provisioner, commissions } = create();

    const result = await provisioner.ensureForApproval(TX, input({ commissionPct: 0 }));

    expect(commissions.insertIfNoOpenVersion).toHaveBeenCalledWith(TX, {
      companyId: 3,
      commissionPct: 0,
      origin: 'company_approval',
      createdBy: 900,
    });
    expect(result.companyCommissionId).toBe(90);
  });

  it('replaces an open commission instead of leaving two', async () => {
    const { provisioner, commissions } = create({ currentCommission: { companyCommissionId: 31 } });

    const result = await provisioner.ensureForApproval(TX, input());

    expect(commissions.replaceOpenVersion).toHaveBeenCalledWith(TX, 31, expect.objectContaining({ commissionPct: 8 }));
    expect(commissions.insertIfNoOpenVersion).not.toHaveBeenCalled();
    expect(result.companyCommissionId).toBe(91);
  });

  it('handles the services in a fixed order so that two approvals never wait on each other in opposite order', async () => {
    const { provisioner, fares } = create();

    await provisioner.ensureForApproval(TX, input({ serviceTypes: ['taxi', 'comfort', 'delivery'] }));

    expect(fares.insertIfNoOpenVersion.mock.calls.map((call) => call[1].serviceType)).toEqual([
      'comfort',
      'delivery',
      'taxi',
    ]);
  });
});
