import { UnauthorizedException } from '@nestjs/common';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';

interface Row {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: Date;
  revoked: boolean;
}

function fakePrisma(): { prisma: PrismaService; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const matches = (r: Row, where: Partial<Row>): boolean =>
    (where.id === undefined || r.id === where.id) &&
    (where.userId === undefined || r.userId === where.userId) &&
    (where.tokenHash === undefined || r.tokenHash === where.tokenHash) &&
    (where.revoked === undefined || r.revoked === where.revoked);

  const refreshToken = {
    create: async ({ data }: { data: Omit<Row, 'id' | 'revoked'> & { revoked?: boolean } }): Promise<Row> => {
      const row: Row = {
        id: ++seq,
        userId: data.userId,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        revoked: data.revoked ?? false,
      };
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { tokenHash: string } }): Promise<Row | null> =>
      rows.find((r) => r.tokenHash === where.tokenHash) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Partial<Row> }): Promise<Row | undefined> => {
      const r = rows.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }): Promise<{ count: number }> => {
      let count = 0;
      for (const r of rows) {
        if (matches(r, where)) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    },
  };
  const prisma = {
    refreshToken,
    $transaction: async (ops: Promise<unknown>[]): Promise<unknown[]> => Promise.all(ops),
  };
  return { prisma: prisma as unknown as PrismaService, rows };
}

function fakeEnv(): EnvService {
  return { get: (k: string) => (k === 'JWT_REFRESH_TTL_DAYS' ? 30 : undefined) } as unknown as EnvService;
}

function code(e: unknown): string {
  if (e instanceof UnauthorizedException) {
    const r = e.getResponse();
    if (typeof r === 'object' && r !== null && 'code' in r) return String((r as { code: unknown }).code);
  }
  return '';
}

describe('RefreshTokenService', () => {
  it('issue creates a row and returns an opaque token', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.issue(5);
    expect(token.length).toBeGreaterThan(20);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked).toBe(false);
  });

  it('rotate: revokes the current one and issues a new one', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.issue(5);

    const r = await svc.rotate(token);
    expect(r.userId).toBe(5);
    expect(r.refreshToken).not.toBe(token);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revoked).toBe(true);
    expect(rows[1]?.revoked).toBe(false);
  });

  it('REUSE of an already-revoked refresh -> revokes the WHOLE family and 401 REFRESH_REVOKED', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.issue(5);
    await svc.rotate(token);

    let err: unknown;
    try {
      await svc.rotate(token);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe('REFRESH_REVOKED');
    expect(rows.every((r) => r.revoked)).toBe(true);
  });

  it('non-existent token -> 401 REFRESH_INVALID', async () => {
    const { prisma } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    await expect(svc.rotate('does-not-exist')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('expired token -> 401 REFRESH_EXPIRED', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.issue(5);
    const row = rows[0];
    if (row) row.expiresAt = new Date(Date.now() - 1000);
    let err: unknown;
    try {
      await svc.rotate(token);
    } catch (e) {
      err = e;
    }
    expect(code(err)).toBe('REFRESH_EXPIRED');
  });

  it('logout is idempotent (revoking twice does not fail)', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.issue(5);
    await svc.revoke(token);
    await svc.revoke(token);
    expect(rows[0]?.revoked).toBe(true);
  });

  it('revokeAllForUser revokes all live sessions', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    await svc.issue(5);
    await svc.issue(5);
    const n = await svc.revokeAllForUser(5);
    expect(n).toBe(2);
    expect(rows.every((r) => r.revoked)).toBe(true);
  });
});
