import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CandidateRepository } from './candidate.repository';

@Injectable()
export class DriverAvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidateRepo: CandidateRepository,
  ) {}

  hasAvailableDrivers(companyId: number, locationStaleMin: number): Promise<boolean> {
    return this.prisma.runInTenant(companyId, (tx) =>
      this.candidateRepo.hasAvailableDrivers(tx, companyId, locationStaleMin),
    );
  }
}
