import { HttpException } from '@nestjs/common';
import type { EnvService } from '../../config/env.service';
import { DocumentStagingService } from './document-staging.service';
import type { FileStorageProvider } from './ports/file-storage.port';

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

function fakeEnv(overrides: Record<string, unknown> = {}): EnvService {
  const values: Record<string, unknown> = {
    DOCUMENT_MAX_BYTES: 5 * 1024 * 1024,
    DOCUMENT_STORAGE_MIN_FREE_BYTES: undefined,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as EnvService;
}

function fakeStorage(overrides: Partial<FileStorageProvider> = {}): FileStorageProvider {
  return {
    put: jest.fn().mockResolvedValue({
      storageKey: 'staging/2026/01/01/uuid.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
    }),
    stat: jest.fn(),
    move: jest.fn(),
    read: jest.fn(),
    remove: jest.fn(),
    listOlderThan: jest.fn(),
    freeBytes: jest.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
    ...overrides,
  };
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

describe('DocumentStagingService.stage', () => {
  it('stages a valid PDF when there is enough free space', async () => {
    const storage = fakeStorage();
    const service = new DocumentStagingService(storage, fakeEnv());

    const result = await service.stage({ buffer: PDF_BYTES, size: PDF_BYTES.length });

    expect(result.storage_key).toBe('staging/2026/01/01/uuid.pdf');
    expect(storage.put).toHaveBeenCalledTimes(1);
  });

  it('rejects with 503 DOCUMENT_STORAGE_UNAVAILABLE when free space is below the default threshold (C-16a)', async () => {
    const maxBytes = 5 * 1024 * 1024;
    const storage = fakeStorage({ freeBytes: jest.fn().mockResolvedValue(49 * maxBytes) });
    const service = new DocumentStagingService(storage, fakeEnv({ DOCUMENT_MAX_BYTES: maxBytes }));

    const e = await capture(service.stage({ buffer: PDF_BYTES, size: PDF_BYTES.length }));

    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toMatchObject({ code: 'DOCUMENT_STORAGE_UNAVAILABLE' });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('honors an explicit DOCUMENT_STORAGE_MIN_FREE_BYTES override instead of the 50x default', async () => {
    const storage = fakeStorage({ freeBytes: jest.fn().mockResolvedValue(2_000) });
    const service = new DocumentStagingService(
      storage,
      fakeEnv({ DOCUMENT_STORAGE_MIN_FREE_BYTES: 1_000 }),
    );

    const result = await service.stage({ buffer: PDF_BYTES, size: PDF_BYTES.length });

    expect(result.storage_key).toBe('staging/2026/01/01/uuid.pdf');
  });

  it('still rejects an oversized file before ever checking free space', async () => {
    const storage = fakeStorage();
    const service = new DocumentStagingService(storage, fakeEnv({ DOCUMENT_MAX_BYTES: 4 }));

    const e = await capture(service.stage({ buffer: PDF_BYTES, size: PDF_BYTES.length }));

    expect(e.getResponse()).toMatchObject({ code: 'DOCUMENT_TOO_LARGE' });
    expect(storage.freeBytes).not.toHaveBeenCalled();
  });
});
