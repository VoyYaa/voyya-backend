import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ConsentStatus } from '@voyyaa/shared';
import { ConsentRepository } from './consent.repository';

@Injectable()
export class ConsentQueryService {
  constructor(private readonly repo: ConsentRepository) {}

  locationStatus(userId: number): Promise<ConsentStatus> {
    return this.repo.current(userId, 'location');
  }

  locationStatusLocked(tx: Prisma.TransactionClient, userId: number): Promise<ConsentStatus> {
    return this.repo.currentLocked(tx, userId, 'location');
  }
}
