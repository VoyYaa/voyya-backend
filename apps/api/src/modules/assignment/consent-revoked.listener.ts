import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CONSENT_EVENTS, ConsentRevokedEvent } from '@voyyaa/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { DriverRepository } from './driver.repository';

@Injectable()
export class ConsentRevokedListener {
  private readonly logger = new Logger(ConsentRevokedListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly drivers: DriverRepository,
  ) {}

  @OnEvent(CONSENT_EVENTS.CONSENT_REVOKED, { suppressErrors: false })
  async onConsentRevoked(event: ConsentRevokedEvent): Promise<void> {
    if (event.role !== 'driver' || event.purpose !== 'location') return;
    if (event.company_id === null) {
      this.logger.warn('Consent revoked by a driver without company_id: nothing to clear');
      return;
    }
    const companyId = event.company_id;
    await this.prisma.runInTenant(companyId, (tx) =>
      this.drivers.clearLocationAfterConsentRevoked(tx, event.user_id, companyId),
    );
  }
}
