import type { EnvService } from '../../config/env.service';
import type { Hasher } from '../auth/hasher.service';
import type { ActiveCompanyResolver } from '../tenancy/active-company.resolver';
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

function create(overrides: { conflictCompanyId?: number | null } = {}) {
  const repo = {
    getDetail: jest.fn().mockResolvedValue(detailRow),
    runTransaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
    setTenantSession: jest.fn().mockResolvedValue(undefined),
    listDocuments: jest.fn().mockResolvedValue([documentRow]),
    listReviews: jest.fn().mockResolvedValue([] as CompanyReviewRow[]),
  };
  const activeCompanies = {
    resolve: jest.fn().mockResolvedValue(overrides.conflictCompanyId ?? null),
  };
  const downloadTokens = {
    buildUrl: jest.fn((companyDocumentId: number, companyId: number, _mintedBy: number) =>
      `https://api.voyya.test/documents/token-${companyId}-${companyDocumentId}`,
    ),
  };
  const env: EnvService = { get: () => 600 } as unknown as EnvService;

  const service = new PlatformCompanyService(
    repo as unknown as PlatformCompanyRepository,
    activeCompanies as unknown as ActiveCompanyResolver,
    {} as CompanyProvisioningService,
    {} as AffiliationLinkService,
    downloadTokens as unknown as DocumentDownloadTokenService,
    env,
    {} as EmailProvider,
    {} as Hasher,
  );

  return { service, repo, activeCompanies, downloadTokens };
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

  it('surfaces the disputed municipality by re-reading the conflicting company name', async () => {
    const { service, repo } = create({ conflictCompanyId: 9 });
    repo.getDetail.mockImplementation((id: number) =>
      Promise.resolve(id === 9 ? { ...detailRow, companyId: 9, legalName: 'Otra Empresa' } : detailRow),
    );

    const result = await service.detail(COMPANY_ID, PLATFORM_ADMIN_USER_ID);

    expect(result.municipality_active_company_name).toBe('Otra Empresa');
  });
});
