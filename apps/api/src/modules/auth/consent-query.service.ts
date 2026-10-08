import { Injectable } from '@nestjs/common';
import type { ConsentStatus } from '@voyyaa/shared';
import { ConsentRepository } from './consent.repository';

@Injectable()
export class ConsentQueryService {
  constructor(private readonly repo: ConsentRepository) {}

  locationStatus(userId: number): Promise<ConsentStatus> {
    return this.repo.current(userId, 'location');
  }
}
