import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface RefreshRotado {
  id_usuario: number;
  refresh_token: string;
}

const MS_POR_DIA = 86_400_000;

/**
 * Ciclo de vida del refresh token (ADR-005 §1/§4). Token OPACO de 256 bits; en DB se
 * guarda SOLO su hash SHA-256 (aleatorio → indexable O(1), sin fuerza bruta que frenar).
 * Rotación en cada uso + detección de reúso (revoca la familia). Global al usuario
 * (sin tenant/RLS).
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  private hashear(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private nuevoToken(): { token: string; hash: string; expira: Date } {
    const token = randomBytes(32).toString('base64url');
    const expira = new Date(Date.now() + this.env.get('JWT_REFRESH_TTL_DAYS') * MS_POR_DIA);
    return { token, hash: this.hashear(token), expira };
  }

  async emitir(idUsuario: number, userAgent?: string): Promise<string> {
    const { token, hash, expira } = this.nuevoToken();
    await this.prisma.refreshToken.create({
      data: { id_usuario: idUsuario, token_hash: hash, expira_en: expira, user_agent: userAgent ?? null },
    });
    return token;
  }

  /** Rotación + detección de reúso. Devuelve id_usuario + refresh NUEVO. */
  async rotar(token: string, userAgent?: string): Promise<RefreshRotado> {
    const fila = await this.prisma.refreshToken.findUnique({
      where: { token_hash: this.hashear(token) },
    });
    if (!fila) {
      throw new UnauthorizedException({ codigo: 'REFRESH_INVALIDO', mensaje: 'Refresh inválido' });
    }
    if (fila.revocado) {
      // Reúso de un token ya revocado ⇒ posible robo ⇒ revocar TODA la familia.
      await this.revocarTodosDeUsuario(fila.id_usuario);
      throw new UnauthorizedException({ codigo: 'REFRESH_REVOCADO', mensaje: 'Sesión revocada' });
    }
    if (fila.expira_en.getTime() < Date.now()) {
      throw new UnauthorizedException({ codigo: 'REFRESH_EXPIRADO', mensaje: 'Refresh expirado' });
    }

    // A-09: CAS atómico — revoca ESTA fila solo si sigue viva. count!==1 ⇒ otra
    // request la rotó primero (carrera/reúso) ⇒ revoca la familia y rechaza.
    const cas = await this.prisma.refreshToken.updateMany({
      where: { id: fila.id, revocado: false },
      data: { revocado: true },
    });
    if (cas.count !== 1) {
      await this.revocarTodosDeUsuario(fila.id_usuario);
      throw new UnauthorizedException({ codigo: 'REFRESH_REVOCADO', mensaje: 'Sesión revocada' });
    }

    const nuevo = this.nuevoToken();
    await this.prisma.refreshToken.create({
      data: {
        id_usuario: fila.id_usuario,
        token_hash: nuevo.hash,
        expira_en: nuevo.expira,
        user_agent: userAgent ?? null,
      },
    });
    return { id_usuario: fila.id_usuario, refresh_token: nuevo.token };
  }

  /** Logout: revoca la fila si existe (IDEMPOTENTE — no falla si no existe/ya revocada). */
  async revocar(token: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { token_hash: this.hashear(token), revocado: false },
      data: { revocado: true },
    });
  }

  /** Revoca todas las sesiones vivas del usuario (logout-all / suspensión — HU-AUTH-05). */
  async revocarTodosDeUsuario(idUsuario: number): Promise<number> {
    const r = await this.prisma.refreshToken.updateMany({
      where: { id_usuario: idUsuario, revocado: false },
      data: { revocado: true },
    });
    return r.count;
  }
}
