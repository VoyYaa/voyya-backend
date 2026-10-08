import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface ActiveCompany {
  companyId: number;
}

export interface ResolveActiveCompanyOptions {
  tx?: Prisma.TransactionClient;
  excludeCompanyId?: number;
}

const MULTIPLE_ACTIVE_WARN_WINDOW_MS = 60 * 60_000;

@Injectable()
export class ActiveCompanyResolver {
  private readonly logger = new Logger(ActiveCompanyResolver.name);
  private readonly lastWarnedAt = new Map<number, number>();

  constructor(private readonly prisma: PrismaService) {}

  async resolve(municipalityId: number, options?: ResolveActiveCompanyOptions): Promise<number | null> {
    const client = options?.tx ?? this.prisma;
    const companies = await client.company.findMany({
      where: {
        municipalityId,
        status: 'active',
        ...(options?.excludeCompanyId !== undefined
          ? { companyId: { not: options.excludeCompanyId } }
          : {}),
      },
      orderBy: { companyId: 'asc' },
      select: { companyId: true },
      take: 2,
    });
    if (companies.length > 1) {
      this.warnOncePerWindow(municipalityId, companies.map((c) => c.companyId));
    }
    return companies[0]?.companyId ?? null;
  }

  private warnOncePerWindow(municipalityId: number, companyIds: number[]): void {
    const now = Date.now();
    const last = this.lastWarnedAt.get(municipalityId);
    if (last !== undefined && now - last < MULTIPLE_ACTIVE_WARN_WINDOW_MS) return;
    this.lastWarnedAt.set(municipalityId, now);
    this.logger.warn(
      `Multiple active companies in municipality=${municipalityId}: ${companyIds.join(',')}`,
    );
  }
}
