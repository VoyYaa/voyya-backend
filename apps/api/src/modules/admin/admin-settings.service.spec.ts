import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { CompanyCommissionReader } from '../service-config/company-commission.reader';
import type { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import type { OperationalParamsService } from '../service-config/operational-params.service';
import type { MunicipalityFareRow, OperationalParamsRow } from '../service-config/service-config.types';
import type { CompanyMunicipalityResolver } from './company-municipality.resolver';
import { AdminSettingsService } from './admin-settings.service';

const COMPANY_ID = 1;
const MUNICIPALITY_ID = 10;

const fare: MunicipalityFareRow = {
  municipalityFareId: 100,
  municipalityId: MUNICIPALITY_ID,
  serviceType: 'taxi',
  baseFare: 8000,
  nightSurchargePct: 20,
  holidaySurchargePct: 15,
  isOfficial: true,
  officialReference: 'Decreto 12 de 2026',
  origin: 'platform_edit',
  originCompanyName: null,
  validFrom: new Date('2026-01-01T00:00:00.000Z'),
  validTo: null,
  createdBy: null,
};

const paramsRow: OperationalParamsRow = {
  operationalParamsId: 7,
  municipalityId: MUNICIPALITY_ID,
  serviceType: 'taxi',
  values: {
    search_radius_km: 2,
    expansion_radius_km: 6,
    acceptance_timeout_sec: 15,
    max_auto_retries: 3,
    tiebreak_window_hours: 4,
    location_stale_min: 15,
    avg_speed_kmh: 30,
    cancellation_window_min: null,
    no_show_grace_min: 5,
  },
  origin: 'platform_edit',
  originCompanyName: null,
  validFrom: new Date('2026-01-02T00:00:00.000Z'),
  validTo: null,
  createdBy: null,
};

const snapshot = {
  params: {},
  values: {
    search_radius_km: 2,
    expansion_radius_km: 6,
    acceptance_timeout_sec: 15,
    max_auto_retries: 3,
    tiebreak_window_hours: 4,
    location_stale_min: 15,
    avg_speed_kmh: 30,
    cancellation_window_min: 2,
    no_show_grace_min: 5,
  },
  platformDefaultKeys: ['cancellation_window_min'],
  row: paramsRow,
};

function create(options: { fare?: MunicipalityFareRow | null } = {}) {
  const prisma = {
    runInTenant: jest.fn((_companyId: number, fn: (tx: unknown) => unknown) => fn({})),
  } as unknown as PrismaService;
  const scopes = {
    resolve: jest.fn().mockResolvedValue({ municipalityId: MUNICIPALITY_ID, serviceType: 'taxi' }),
  };
  const fares = { getCurrent: jest.fn().mockResolvedValue(options.fare === undefined ? fare : options.fare) };
  const params = { snapshot: jest.fn().mockResolvedValue(snapshot) };
  const commissions = { getCurrent: jest.fn().mockResolvedValue({ commissionPct: 8 }) };
  const service = new AdminSettingsService(
    prisma,
    scopes as unknown as CompanyMunicipalityResolver,
    fares as unknown as MunicipalityFareReader,
    params as unknown as OperationalParamsService,
    commissions as unknown as CompanyCommissionReader,
  );
  return { service, fares, params, commissions };
}

describe('AdminSettingsService.get (read-only, ADR-032 section 7.4)', () => {
  it('composes the municipality fare, the nine parameters and the own commission', async () => {
    const { service } = create();

    const settings = await service.get(COMPANY_ID);

    expect(settings).toMatchObject({
      version: 'mf:100|op:7',
      base_fare: 8000,
      night_surcharge_pct: 20,
      holiday_surcharge_pct: 15,
      commission_pct: 8,
      read_only: true,
      service_type: 'taxi',
      fare_is_official: true,
      fare_official_reference: 'Decreto 12 de 2026',
      fare_valid_from: '2026-01-01T00:00:00.000Z',
      cancellation_window_min: 2,
      no_show_grace_min: 5,
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('reads the fare of the municipality and service of the company', async () => {
    const { service, fares } = create();
    await service.get(COMPANY_ID);
    expect(fares.getCurrent).toHaveBeenCalledWith(MUNICIPALITY_ID, 'taxi', expect.anything());
  });

  it('answers 404 when the municipality has no current fare', async () => {
    const { service } = create({ fare: null });
    await expect(service.get(COMPANY_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AdminSettingsService.rejectUpdate', () => {
  it('answers 403 SETTINGS_MANAGED_BY_PLATFORM', () => {
    const { service } = create();
    let thrown: HttpException | undefined;
    try {
      service.rejectUpdate();
    } catch (error) {
      thrown = error as HttpException;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(thrown?.getResponse()).toMatchObject({ code: 'SETTINGS_MANAGED_BY_PLATFORM' });
  });
});
