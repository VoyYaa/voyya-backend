import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuthenticatedUser, RequestWithTenant } from '../../tenancy/tenant-request';
import { ALLOW_PENDING_PIN_CHANGE_KEY } from '../decorators/allow-pending-pin-change.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PinChangeGuard } from './pin-change.guard';

function context(user?: AuthenticatedUser): ExecutionContext {
  const req = { user } as RequestWithTenant;
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function guardWith(metadata: Record<string, boolean>): PinChangeGuard {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  return new PinChangeGuard(reflector);
}

const pendingDriver: AuthenticatedUser = {
  userId: 1,
  role: 'driver',
  companyId: 2,
  pinChangeRequired: true,
};

describe('PinChangeGuard', () => {
  it('lets a driver without the claim through', () => {
    const guard = guardWith({});
    expect(guard.canActivate(context({ userId: 1, role: 'driver', companyId: 2 }))).toBe(true);
  });

  it('rejects a pending driver with PIN_CHANGE_REQUIRED', () => {
    const guard = guardWith({});
    try {
      guard.canActivate(context(pendingDriver));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'PIN_CHANGE_REQUIRED',
      });
    }
  });

  it('lets a pending driver through on a route marked as allowing pending PIN change', () => {
    const guard = guardWith({ [ALLOW_PENDING_PIN_CHANGE_KEY]: true });
    expect(guard.canActivate(context(pendingDriver))).toBe(true);
  });

  it('lets public routes through', () => {
    const guard = guardWith({ [IS_PUBLIC_KEY]: true });
    expect(guard.canActivate(context(pendingDriver))).toBe(true);
  });

  it('ignores the claim on non-driver roles', () => {
    const guard = guardWith({});
    expect(guard.canActivate(context({ ...pendingDriver, role: 'passenger' }))).toBe(true);
  });

  it('lets requests without a user through (the JWT guard decides)', () => {
    const guard = guardWith({});
    expect(guard.canActivate(context(undefined))).toBe(true);
  });
});
