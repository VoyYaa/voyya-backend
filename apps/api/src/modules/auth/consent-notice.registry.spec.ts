import { Logger } from '@nestjs/common';
import { canonicalLocationNoticeText, LOCATION_NOTICE_VERSION } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ConsentNoticeRegistry, noticeFingerprint } from './consent-notice.registry';

interface AudienceKey {
  where: { purpose_noticeVersion_audience: { audience: string } };
}

function fakeTable(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    createMany: jest.fn(async ({ data }: { data: Array<{ audience: string; sha256: string }> }) => {
      for (const row of data) if (!rows.has(row.audience)) rows.set(row.audience, row.sha256);
    }),
    findUniqueOrThrow: jest.fn(async ({ where }: AudienceKey) => ({
      sha256: rows.get(where.purpose_noticeVersion_audience.audience),
    })),
    findUnique: jest.fn(async ({ where }: AudienceKey) =>
      rows.has(where.purpose_noticeVersion_audience.audience) ? { noticeVersion: 'registered' } : null,
    ),
  };
}

function build(table: ReturnType<typeof fakeTable>, nodeEnv: string): ConsentNoticeRegistry {
  const prisma = { consentNotice: table } as unknown as PrismaService;
  const env = { get: () => nodeEnv } as unknown as EnvService;
  return new ConsentNoticeRegistry(prisma, env);
}

describe('ConsentNoticeRegistry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('registers the canonical text hash of each audience', async () => {
    const table = fakeTable();
    await build(table, 'test').register();

    expect(table.rows.get('driver')).toBe(noticeFingerprint(canonicalLocationNoticeText('driver')));
    expect(table.rows.get('passenger')).toBe(noticeFingerprint(canonicalLocationNoticeText('passenger')));
  });

  it('is idempotent when the stored hash matches', async () => {
    const registry = build(fakeTable(), 'test');
    await registry.register();
    await expect(registry.register()).resolves.toBeUndefined();
  });

  it('fails when the same version was registered with a different hash', async () => {
    const table = fakeTable({ driver: 'f'.repeat(64) });
    await expect(build(table, 'test').register()).rejects.toThrow(
      `${LOCATION_NOTICE_VERSION} (driver) cambió sin subir la versión`,
    );
  });

  it('logs an error about legal placeholders in production without failing', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await expect(build(fakeTable(), 'production').register()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('marcadores legales'));
  });

  it('does not log the placeholder error outside production', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await build(fakeTable(), 'test').register();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('isKnown reflects the registered versions', async () => {
    const registry = build(fakeTable({ driver: 'a'.repeat(64) }), 'test');
    await expect(registry.isKnown('location', LOCATION_NOTICE_VERSION, 'driver')).resolves.toBe(true);
    await expect(registry.isKnown('location', LOCATION_NOTICE_VERSION, 'passenger')).resolves.toBe(false);
  });
});
