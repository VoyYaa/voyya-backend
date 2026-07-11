import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface RotatedRefresh {
  userId: number;
  refreshToken: string;
}

const MS_PER_DAY = 86_400_000;

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private newToken(): { token: string; hash: string; expires: Date } {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.env.get('JWT_REFRESH_TTL_DAYS') * MS_PER_DAY);
    return { token, hash: this.hashToken(token), expires };
  }

  async issue(userId: number, userAgent?: string): Promise<string> {
    const { token, hash, expires } = this.newToken();
    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: hash, expiresAt: expires, userAgent: userAgent ?? null },
    });
    return token;
  }

  async rotate(token: string, userAgent?: string): Promise<RotatedRefresh> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(token) },
    });
    if (!row) {
      throw new UnauthorizedException({ code: 'REFRESH_INVALID', message: 'Refresh inválido' });
    }
    if (row.revoked) {
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException({ code: 'REFRESH_REVOKED', message: 'Sesión revocada' });
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({ code: 'REFRESH_EXPIRED', message: 'Refresh expirado' });
    }

    const cas = await this.prisma.refreshToken.updateMany({
      where: { id: row.id, revoked: false },
      data: { revoked: true },
    });
    if (cas.count !== 1) {
      await this.revokeAllForUser(row.userId);
      throw new UnauthorizedException({ code: 'REFRESH_REVOKED', message: 'Sesión revocada' });
    }

    const next = this.newToken();
    await this.prisma.refreshToken.create({
      data: {
        userId: row.userId,
        tokenHash: next.hash,
        expiresAt: next.expires,
        userAgent: userAgent ?? null,
      },
    });
    return { userId: row.userId, refreshToken: next.token };
  }

  async revoke(token: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(token), revoked: false },
      data: { revoked: true },
    });
  }

  async revokeAllForUser(userId: number): Promise<number> {
    const r = await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
    return r.count;
  }
}
