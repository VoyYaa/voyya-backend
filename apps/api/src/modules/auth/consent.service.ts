import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CONSENT_EVENTS,
  type ConsentRevokedEvent,
  type ConsentStatus,
  type ConsentStatusListResponse,
  type GrantConsentDTO,
  type NoticeAudience,
  type RevokeConsentDTO,
  type Role,
} from '@voyyaa/shared';
import type { AuthenticatedUser } from '../tenancy/tenant-request';
import { ConsentNoticeRegistry } from './consent-notice.registry';
import { ConsentRepository } from './consent.repository';

const AUDIENCE_BY_ROLE: Partial<Record<Role, NoticeAudience>> = {
  passenger: 'passenger',
  driver: 'driver',
};

@Injectable()
export class ConsentService {
  constructor(
    private readonly repo: ConsentRepository,
    private readonly notices: ConsentNoticeRegistry,
    private readonly emitter: EventEmitter2,
  ) {}

  async grant(user: AuthenticatedUser, dto: GrantConsentDTO): Promise<ConsentStatus> {
    const audience = audienceFor(user.role);
    const known = await this.notices.isKnown(dto.purpose, dto.notice_version, audience);
    if (!known) {
      throw new UnprocessableEntityException({
        code: 'NOTICE_VERSION_UNKNOWN',
        message: 'Esa versión del aviso ya no es válida. Actualiza la app para ver el aviso vigente.',
      });
    }
    return this.repo.grant(user.userId, dto.purpose, dto.notice_version, audience);
  }

  async revoke(user: AuthenticatedUser, dto: RevokeConsentDTO): Promise<ConsentStatus> {
    audienceFor(user.role);
    const status = await this.repo.revoke(user.userId, dto.purpose);
    if (user.role === 'driver') {
      const event: ConsentRevokedEvent = {
        user_id: user.userId,
        role: user.role,
        company_id: user.companyId ?? null,
        purpose: dto.purpose,
        occurred_at: new Date().toISOString(),
      };
      await this.emitter.emitAsync(CONSENT_EVENTS.CONSENT_REVOKED, event);
    }
    return status;
  }

  async list(user: AuthenticatedUser): Promise<ConsentStatusListResponse> {
    audienceFor(user.role);
    return this.repo.list(user.userId);
  }
}

function audienceFor(role: Role): NoticeAudience {
  const audience = AUDIENCE_BY_ROLE[role];
  if (audience === undefined) {
    throw new ForbiddenException({
      code: 'NOTICE_AUDIENCE_NOT_ALLOWED',
      message: 'Este aviso no aplica a tu rol.',
    });
  }
  return audience;
}
