import { Logger } from '@nestjs/common';
import { canonicalLocationNoticeText, hasLegalPlaceholders, LOCATION_NOTICE_VERSION, NoticeAudience } from '@voyyaa/shared';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ConsentNoticeRegistry, noticeFingerprint } from './consent-notice.registry';

interface AudienceKey {
  where: { purpose_noticeVersion_audience: { audience: string } };
}

function fakeTable(seed: Record<string, string> = {}, bodies: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  const storedBodies = new Map(Object.entries(bodies));
  return {
    rows,
    createMany: jest.fn(
      async ({ data }: { data: Array<{ audience: string; sha256: string; body: string }> }) => {
        for (const row of data) {
          if (rows.has(row.audience)) continue;
          rows.set(row.audience, row.sha256);
          storedBodies.set(row.audience, row.body);
        }
      },
    ),
    findUniqueOrThrow: jest.fn(async ({ where }: AudienceKey) => {
      const audience = where.purpose_noticeVersion_audience.audience;
      return {
        sha256: rows.get(audience),
        body: storedBodies.get(audience) ?? canonicalLocationNoticeText(audience as 'driver'),
      };
    }),
    findUnique: jest.fn(async ({ where }: AudienceKey) =>
      rows.has(where.purpose_noticeVersion_audience.audience) ? { noticeVersion: 'registered' } : null,
    ),
  };
}

const MARKED_NOTICE = 'Responsable: [NIT]. Política: [URL DE LA POLÍTICA].';

class MarkedNoticeRegistry extends ConsentNoticeRegistry {
  protected override noticeBody(): string {
    return MARKED_NOTICE;
  }
}

function build(
  table: ReturnType<typeof fakeTable>,
  nodeEnv: string,
  registryClass: typeof ConsentNoticeRegistry = ConsentNoticeRegistry,
): ConsentNoticeRegistry {
  const prisma = { consentNotice: table } as unknown as PrismaService;
  const env = { get: () => nodeEnv } as unknown as EnvService;
  return new registryClass(prisma, env);
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

  it.each(NoticeAudience.options)('the real %s notice has no legal placeholders', (audience) => {
    expect(hasLegalPlaceholders(canonicalLocationNoticeText(audience))).toBe(false);
  });

  it('boots in production with the real notice (no markers)', async () => {
    const table = fakeTable();
    await expect(build(table, 'production').register()).resolves.toBeUndefined();
    expect(table.rows.size).toBe(2);
  });

  it('fails the startup in production while the notice has legal placeholders, naming each marker', async () => {
    const table = fakeTable();
    await expect(build(table, 'production', MarkedNoticeRegistry).register()).rejects.toThrow(
      /\[URL DE LA POLÍTICA\].*no es apto para producción/,
    );
    await expect(build(table, 'production', MarkedNoticeRegistry).register()).rejects.toThrow('[NIT]');
  });

  it('does not write the notice to the ledger when it refuses to start in production', async () => {
    const table = fakeTable();
    await expect(build(table, 'production', MarkedNoticeRegistry).register()).rejects.toThrow();
    expect(table.createMany).not.toHaveBeenCalled();
  });

  it('only warns about legal placeholders outside production', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const table = fakeTable();
    await expect(build(table, 'development', MarkedNoticeRegistry).register()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[URL DE LA POLÍTICA]'));
    expect(table.rows.size).toBe(2);
  });

  it('fails when the stored body no longer matches the stored hash', async () => {
    const table = fakeTable(
      { driver: noticeFingerprint(canonicalLocationNoticeText('driver')) },
      { driver: 'texto reescrito' },
    );
    await expect(build(table, 'test').register()).rejects.toThrow(
      `${LOCATION_NOTICE_VERSION} (driver) no coincide con su huella`,
    );
  });

  it('isKnown reflects the registered versions', async () => {
    const registry = build(fakeTable({ driver: 'a'.repeat(64) }), 'test');
    await expect(registry.isKnown('location', LOCATION_NOTICE_VERSION, 'driver')).resolves.toBe(true);
    await expect(registry.isKnown('location', LOCATION_NOTICE_VERSION, 'passenger')).resolves.toBe(false);
  });
});
