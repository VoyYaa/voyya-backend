import { HttpException } from '@nestjs/common';
import type { CreateAffiliationApplicationDTO, ReplaceAffiliationDocumentDTO } from '@voyyaa/shared';
import { REQUIRED_COMPANY_DOCUMENT_TYPES } from '@voyyaa/shared';
import type { AffiliationLinkService } from './affiliation-link.service';
import { AffiliationRepository } from './affiliation.repository';
import { AffiliationService } from './affiliation.service';
import type { FileStorageProvider } from './ports/file-storage.port';

const STATED_STAT = {
  contentType: 'application/pdf',
  sizeBytes: 1024,
} as const;

function dto(overrides: Partial<CreateAffiliationApplicationDTO> = {}): CreateAffiliationApplicationDTO {
  return {
    legal_name: 'Cootrayal',
    tax_id: '900123456-1',
    legal_form: 'cooperative',
    municipality_id: 1,
    vehicle_count: 10,
    contact_first_name: 'Ana',
    contact_last_name: 'Pérez',
    contact_email: 'contacto@cootrayal.test',
    contact_phone: '3001234567',
    documents: REQUIRED_COMPANY_DOCUMENT_TYPES.map((type) => ({
      type,
      storage_key: `staging/2026/01/01/${type}-uuid.pdf`,
    })),
    ...overrides,
  };
}

function fakeStorage(overrides: Partial<FileStorageProvider> = {}): FileStorageProvider {
  return {
    put: jest.fn(),
    stat: jest.fn().mockResolvedValue(STATED_STAT),
    move: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    listOlderThan: jest.fn(),
    freeBytes: jest.fn(),
    ...overrides,
  };
}

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    getMunicipality: jest.fn().mockResolvedValue({ municipalityId: 1, name: 'Yarumal', status: 'active' }),
    findUserByPhone: jest.fn().mockResolvedValue(null),
    findUserByEmail: jest.fn().mockResolvedValue(null),
    findCompanyByTaxId: jest.fn().mockResolvedValue(null),
    runTransaction: jest.fn((fn: (tx: unknown) => unknown) => fn({})),
    upsertPendingCompany: jest.fn().mockResolvedValue({
      companyId: 3,
      legalName: 'Cootrayal',
      taxId: '900123456-1',
      status: 'pending',
      municipalityId: 1,
      contactEmail: 'contacto@cootrayal.test',
      registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    setTenantSession: jest.fn().mockResolvedValue(undefined),
    replaceCompanyDocuments: jest.fn().mockResolvedValue(undefined),
    findPendingCompany: jest.fn().mockResolvedValue({ companyId: 3, status: 'pending' }),
    replaceSingleCompanyDocument: jest.fn().mockResolvedValue({
      companyDocumentId: 55,
      uploadedAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    ...overrides,
  };
}

function fakeLinks(overrides: Record<string, unknown> = {}): AffiliationLinkService {
  return {
    verify: jest.fn().mockReturnValue({ ok: true, payload: { companyId: 3 } }),
    sign: jest.fn(),
    ...overrides,
  } as unknown as AffiliationLinkService;
}

async function capture(p: Promise<unknown>): Promise<HttpException> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) return e;
    throw e;
  }
  throw new Error('No exception thrown');
}

describe('AffiliationService.submitApplication — promote-before-transaction (C-16b)', () => {
  it('happy path: promotes every staged document before opening the transaction, then writes the rows', async () => {
    const repo = fakeRepo();
    const storage = fakeStorage();
    const service = new AffiliationService(
      repo as unknown as AffiliationRepository,
      fakeLinks(),
      storage,
    );

    const result = await service.submitApplication(dto());

    expect(result.company_id).toBe(3);
    expect(storage.move).toHaveBeenCalledTimes(REQUIRED_COMPANY_DOCUMENT_TYPES.length);
    expect(repo.replaceCompanyDocuments).toHaveBeenCalledTimes(1);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('a move failure mid-batch aborts with 503 DOCUMENT_STORAGE_UNAVAILABLE, rolls back what was already promoted, and never opens the transaction', async () => {
    const repo = fakeRepo();
    const storage = fakeStorage({
      move: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('ENOSPC')),
    });
    const service = new AffiliationService(
      repo as unknown as AffiliationRepository,
      fakeLinks(),
      storage,
    );

    const e = await capture(service.submitApplication(dto()));

    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({ code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expect(repo.runTransaction).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect((storage.remove as jest.Mock).mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('a transaction failure after a full promotion rolls back the promoted files and rethrows the original error', async () => {
    const boom = new Error('unique constraint violation');
    const repo = fakeRepo({
      runTransaction: jest.fn().mockRejectedValue(boom),
    });
    const storage = fakeStorage();
    const service = new AffiliationService(
      repo as unknown as AffiliationRepository,
      fakeLinks(),
      storage,
    );

    await expect(service.submitApplication(dto())).rejects.toBe(boom);
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect((storage.remove as jest.Mock).mock.calls[0]?.[0]).toHaveLength(
      REQUIRED_COMPANY_DOCUMENT_TYPES.length,
    );
  });
});

describe('AffiliationService.replaceDocument — promote-before-transaction (C-16b)', () => {
  const replaceDto: ReplaceAffiliationDocumentDTO = {
    type: 'chamber_of_commerce',
    storage_key: 'staging/2026/01/01/chamber_of_commerce-uuid.pdf',
  };

  it('a move failure aborts with 503 DOCUMENT_STORAGE_UNAVAILABLE and never opens the transaction', async () => {
    const repo = fakeRepo();
    const storage = fakeStorage({ move: jest.fn().mockRejectedValue(new Error('ENOSPC')) });
    const service = new AffiliationService(
      repo as unknown as AffiliationRepository,
      fakeLinks(),
      storage,
    );

    const e = await capture(service.replaceDocument('token', 3, replaceDto));

    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({ code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expect(repo.runTransaction).not.toHaveBeenCalled();
  });

  it('a transaction failure after promotion rolls back the promoted file and rethrows the original error', async () => {
    const repo = fakeRepo({
      runTransaction: jest.fn(async (fn: (tx: unknown) => unknown) => {
        return fn({});
      }),
      findPendingCompany: jest.fn().mockResolvedValue({ companyId: 3, status: 'rejected' }),
    });
    const storage = fakeStorage();
    const service = new AffiliationService(
      repo as unknown as AffiliationRepository,
      fakeLinks(),
      storage,
    );

    const e = await capture(service.replaceDocument('token', 3, replaceDto));

    expect(e.getResponse()).toMatchObject({ code: 'APPLICATION_NOT_PENDING' });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect((storage.remove as jest.Mock).mock.calls[0]?.[0]).toHaveLength(1);
  });
});
