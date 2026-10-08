import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ServiceType } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { MunicipalityFareRepository } from './municipality-fare.repository';
import type { MunicipalityFareRow } from './service-config.types';

@Injectable()
export class MunicipalityFareReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MunicipalityFareRepository,
  ) {}

  getCurrent(
    municipalityId: number,
    serviceType: ServiceType,
    tx?: Prisma.TransactionClient,
  ): Promise<MunicipalityFareRow | null> {
    return this.repo.findCurrent(tx ?? this.prisma, municipalityId, serviceType);
  }

  getById(municipalityFareId: number, tx?: Prisma.TransactionClient): Promise<MunicipalityFareRow | null> {
    return this.repo.findById(tx ?? this.prisma, municipalityFareId);
  }
}
