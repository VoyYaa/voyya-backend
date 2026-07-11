import { UnauthorizedException } from '@nestjs/common';
import type { EnvService } from '../../config/env.service';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RefreshTokenService } from './refresh-token.service';

interface Row {
  id: number;
  id_usuario: number;
  token_hash: string;
  expira_en: Date;
  revocado: boolean;
}

function fakePrisma(): { prisma: PrismaService; rows: Row[] } {
  const rows: Row[] = [];
  let seq = 0;
  const coincide = (r: Row, where: Partial<Row>): boolean =>
    (where.id === undefined || r.id === where.id) &&
    (where.id_usuario === undefined || r.id_usuario === where.id_usuario) &&
    (where.token_hash === undefined || r.token_hash === where.token_hash) &&
    (where.revocado === undefined || r.revocado === where.revocado);

  const refreshToken = {
    create: async ({ data }: { data: Omit<Row, 'id' | 'revocado'> & { revocado?: boolean } }): Promise<Row> => {
      const row: Row = {
        id: ++seq,
        id_usuario: data.id_usuario,
        token_hash: data.token_hash,
        expira_en: data.expira_en,
        revocado: data.revocado ?? false,
      };
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { token_hash: string } }): Promise<Row | null> =>
      rows.find((r) => r.token_hash === where.token_hash) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Partial<Row> }): Promise<Row | undefined> => {
      const r = rows.find((x) => x.id === where.id);
      if (r) Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }): Promise<{ count: number }> => {
      let count = 0;
      for (const r of rows) {
        if (coincide(r, where)) {
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

function codigo(e: unknown): string {
  if (e instanceof UnauthorizedException) {
    const r = e.getResponse();
    if (typeof r === 'object' && r !== null && 'codigo' in r) return String((r as { codigo: unknown }).codigo);
  }
  return '';
}

describe('RefreshTokenService', () => {
  it('emitir crea una fila y devuelve un token opaco', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.emitir(5);
    expect(token.length).toBeGreaterThan(20);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revocado).toBe(false);
  });

  it('rotar: revoca el actual y emite uno nuevo (rotación)', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.emitir(5);

    const r = await svc.rotar(token);
    expect(r.id_usuario).toBe(5);
    expect(r.refresh_token).not.toBe(token);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revocado).toBe(true); // el viejo quedó revocado
    expect(rows[1]?.revocado).toBe(false); // el nuevo vive
  });

  it('REÚSO de un refresh ya revocado → revoca TODA la familia y 401 REFRESH_REVOCADO', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.emitir(5);
    await svc.rotar(token); // primera rotación: `token` queda revocado

    let err: unknown;
    try {
      await svc.rotar(token); // reúso del token viejo
    } catch (e) {
      err = e;
    }
    expect(codigo(err)).toBe('REFRESH_REVOCADO');
    // La familia entera quedó revocada (incluido el token nuevo emitido antes).
    expect(rows.every((r) => r.revocado)).toBe(true);
  });

  it('token inexistente → 401 REFRESH_INVALIDO', async () => {
    const { prisma } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    await expect(svc.rotar('no-existe')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('token expirado → 401 REFRESH_EXPIRADO', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.emitir(5);
    const fila = rows[0];
    if (fila) fila.expira_en = new Date(Date.now() - 1000);
    let err: unknown;
    try {
      await svc.rotar(token);
    } catch (e) {
      err = e;
    }
    expect(codigo(err)).toBe('REFRESH_EXPIRADO');
  });

  it('logout es idempotente (revocar dos veces no falla)', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    const token = await svc.emitir(5);
    await svc.revocar(token);
    await svc.revocar(token); // no debe lanzar
    expect(rows[0]?.revocado).toBe(true);
  });

  it('revocarTodosDeUsuario revoca todas las sesiones vivas', async () => {
    const { prisma, rows } = fakePrisma();
    const svc = new RefreshTokenService(prisma, fakeEnv());
    await svc.emitir(5);
    await svc.emitir(5);
    const n = await svc.revocarTodosDeUsuario(5);
    expect(n).toBe(2);
    expect(rows.every((r) => r.revocado)).toBe(true);
  });
});
