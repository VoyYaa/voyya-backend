import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { CONSENT_EVENTS, type ConsentStatus } from '@voyyaa/shared';
import type { AuthenticatedUser } from '../tenancy/tenant-request';
import type { ConsentNoticeRegistry } from './consent-notice.registry';
import type { ConsentRepository } from './consent.repository';
import { ConsentService } from './consent.service';

const STATUS: ConsentStatus = {
  purpose: 'location',
  state: 'granted',
  notice_version: 'location-notice-v2',
  granted_at: '2026-10-08T10:00:00.000Z',
  revoked_at: null,
  current_notice_version: 'location-notice-v2',
  requires_acceptance: false,
};

function build(known = true) {
  const repo = {
    grant: jest.fn().mockResolvedValue(STATUS),
    revoke: jest.fn().mockResolvedValue(STATUS),
    list: jest.fn().mockResolvedValue([STATUS]),
  };
  const notices = { isKnown: jest.fn().mockResolvedValue(known) };
  const emitter = { emitAsync: jest.fn().mockResolvedValue([]) };
  const service = new ConsentService(
    repo as unknown as ConsentRepository,
    notices as unknown as ConsentNoticeRegistry,
    emitter as unknown as EventEmitter2,
  );
  return { service, repo, notices, emitter };
}

const driver: AuthenticatedUser = { userId: 5, role: 'driver', companyId: 3 };
const passenger: AuthenticatedUser = { userId: 6, role: 'passenger' };
const admin: AuthenticatedUser = { userId: 1, role: 'admin', companyId: 3 };
const grantDto = { purpose: 'location', notice_version: 'location-notice-v2' } as const;

describe('ConsentService', () => {
  it('derives the audience from the role when granting', async () => {
    const { service, repo, notices } = build();
    await service.grant(driver, grantDto);
    expect(notices.isKnown).toHaveBeenCalledWith('location', 'location-notice-v2', 'driver');
    expect(repo.grant).toHaveBeenCalledWith(5, 'location', 'location-notice-v2', 'driver');
  });

  it('rejects an unknown version with 422 NOTICE_VERSION_UNKNOWN and writes nothing', async () => {
    const { service, repo } = build(false);
    const error = await service.grant(passenger, grantDto).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'NOTICE_VERSION_UNKNOWN',
    });
    expect(repo.grant).not.toHaveBeenCalled();
  });

  it('rejects staff roles with 403 NOTICE_AUDIENCE_NOT_ALLOWED on every operation', async () => {
    const { service } = build();
    for (const call of [
      () => service.grant(admin, grantDto),
      () => service.revoke(admin, { purpose: 'location' }),
      () => service.list(admin),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'NOTICE_AUDIENCE_NOT_ALLOWED',
      });
    }
  });

  it('emits ConsentRevokedEvent with company_id when a driver revokes', async () => {
    const { service, emitter } = build();
    await service.revoke(driver, { purpose: 'location' });
    expect(emitter.emitAsync).toHaveBeenCalledWith(
      CONSENT_EVENTS.CONSENT_REVOKED,
      expect.objectContaining({ user_id: 5, role: 'driver', company_id: 3, purpose: 'location' }),
    );
  });

  it('records a passenger revocation without emitting any event', async () => {
    const { service, repo, emitter } = build();
    await service.revoke(passenger, { purpose: 'location' });
    expect(repo.revoke).toHaveBeenCalledWith(6, 'location');
    expect(emitter.emitAsync).not.toHaveBeenCalled();
  });

  it('propagates a listener failure so the request answers 500 and a retry re-emits', async () => {
    const { service, emitter } = build();
    emitter.emitAsync.mockRejectedValueOnce(new Error('db down'));
    await expect(service.revoke(driver, { purpose: 'location' })).rejects.toThrow('db down');
  });
});
