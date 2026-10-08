import type { EnvService } from '../../config/env.service';
import type { Hasher } from '../auth/hasher.service';
import type { CompanyCommissionReader } from '../service-config/company-commission.reader';
import type { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import type { ServiceCatalog } from '../service-config/service-catalog';
import type { ServiceConfigProvisioner } from '../service-config/service-config-provisioner';
import type { CompanyProvisioningService } from '../tenancy/company-provisioning.service';
import type { AffiliationLinkService } from './affiliation-link.service';
import type { DocumentDownloadTokenService } from './document-download-token.service';
import type { EmailProvider } from './ports/email-provider.port';
import type {
  CompanyDocumentRow,
  CompanyReviewRow,
  PlatformCompanyDetailRow,
} from './platform-company.repository';
import { PlatformCompanyRepository } from './platform-company.repository';
import { PlatformCompanyService } from './platform-company.service';

const COMPANY_ID = 3;
const PLATFORM_ADMIN_USER_ID = 900;

const detailRow: PlatformCompanyDetailRow = {
  companyId: COMPANY_ID,
  legalName: 'Cootrayal',
  taxId: '900123456-1',
  status: 'pending',
  municipalityId: 1,
  municipalityName: 'Yarumal',
  municipalityAlreadyCovered: false,
  municipalityDaneCode: '05887',
  municipalityCoverageActive: true,
  publicName: null,
  serviceTypes: ['taxi'],
  otherActiveCompanies: [],
  vehicleCount: 10,
  contactEmail: 'contacto@cootrayal.test',
  submittedAt: new Date('2026-01-01T00:00:00.000Z'),
  legalForm: 'cooperative',
  municipalityDepartment: 'Antioquia',
  contactFirstName: 'Ana',
  contactLastName: 'Pérez',
  contactPhone: '3001234567',
};

const documentRow: CompanyDocumentRow = {
  companyDocumentId: 55,
  type: 'chamber_of_commerce',
  storageKey: 'companies/3/chamber_of_commerce/uuid.pdf',
  fileName: 'chamber_of_commerce-3.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1024,
  verification: 'pending',
  reviewNote: null,
  issuedAt: null,
  expiresAt: null,
  uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
  verifiedAt: null,
};

function create(overrides: { otherActive?: Array<{ companyId: number; legalName: string }> } = {}) {
  const repo = {
    getDetail: jest.fn().mockResolvedValue({ ...detailRow, otherActiveCompanies: overrides.otherActive ?? [] }),
    runAsPlatform: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
    findApprovalDates: jest.fn().mockResolvedValue(new Map()),
    setTenantSession: jest.fn().mockResolvedValue(undefined),
    listDocuments: jest.fn().mockResolvedValue([documentRow]),
    listReviews: jest.fn().mockResolvedValue([] as CompanyReviewRow[]),
  };
  const fares = { getCurrent: jest.fn().mockResolvedValue(null) };
  const commissions = { getCurrent: jest.fn().mockResolvedValue(null) };
  const downloadTokens = {
    buildUrl: jest.fn((companyDocumentId: number, companyId: number, _mintedBy: number) =>
      `https://api.voyya.test/documents/token-${companyId}-${companyDocumentId}`,
    ),
  };
  const env: EnvService = { get: () => 600 } as unknown as EnvService;

  const service = new PlatformCompanyService(
    repo as unknown as PlatformCompanyRepository,
    {} as CompanyProvisioningService,
    {} as ServiceConfigProvisioner,
    {} as ServiceCatalog,
    fares as unknown as MunicipalityFareReader,
    commissions as unknown as CompanyCommissionReader,
    {} as AffiliationLinkService,
    downloadTokens as unknown as DocumentDownloadTokenService,
    env,
    {} as EmailProvider,
    {} as Hasher,
  );

  return { service, repo, fares, commissions, downloadTokens };
}

describe('PlatformCompanyService.detail', () => {
  it('builds download_url from the token service, without touching any storage provider', async () => {
    const { service, downloadTokens } = create();

    const result = await service.detail(COMPANY_ID, PLATFORM_ADMIN_USER_ID);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.download_url).toBe(
      'https://api.voyya.test/documents/token-3-55',
    );
    expect(downloadTokens.buildUrl).toHaveBeenCalledWith(55, COMPANY_ID, PLATFORM_ADMIN_USER_ID);
    expect(downloadTokens.buildUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps working when documents are declared even if the storage layer would be unreachable', async () => {
    const { service, repo } = create();

    const result = await service.detail(COMPANY_ID, PLATFORM_ADMIN_USER_ID);

    expect(result.company_id).toBe(COMPANY_ID);
    expect(repo.getDetail).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('lists the other active companies of the municipality without blocking anything', async () => {
    const { service } = create({ otherActive: [{ companyId: 9, legalName: 'Otra Empresa' }] });

    const result = await service.detail(COMPANY_ID, PLATFORM_ADMIN_USER_ID);

    expect(result.municipality_active_companies).toEqual([{ company_id: 9, legal_name: 'Otra Empresa' }]);
    expect(result.municipality_active_company_name).toBe('Otra Empresa');
  });

  it('shows the current municipality fare per declared service and null when there is none', async () => {
    const { service, fares } = create();

    const result = await service.detail(COMPANY_ID, PLATFORM_ADMIN_USER_ID);

    expect(fares.getCurrent).toHaveBeenCalledWith(1, 'taxi', expect.anything());
    expect(result.municipality_fares).toEqual([{ service_type: 'taxi', fare: null }]);
    expect(result.commission).toBeNull();
  });
});
