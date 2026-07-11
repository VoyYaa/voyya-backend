import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Role } from '@voyyaa/shared';
import type { AuthenticatedUser, RequestWithTenant } from '../../tenancy/tenant-request';
import { RolesGuard } from './roles.guard';

function context(user?: AuthenticatedUser): ExecutionContext {
  const req = { user } as RequestWithTenant;
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function guardWith(roles: Role[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('no @Roles -> allows', () => {
    const guard = guardWith(undefined);
    expect(guard.canActivate(context({ userId: 1, role: 'passenger' }))).toBe(true);
  });

  it('role matches -> allows', () => {
    const guard = guardWith(['driver']);
    expect(guard.canActivate(context({ userId: 1, role: 'driver', companyId: 2 }))).toBe(true);
  });

  it('role not authorized -> 403 FORBIDDEN', () => {
    const guard = guardWith(['driver']);
    expect(() => guard.canActivate(context({ userId: 1, role: 'passenger' }))).toThrow(
      ForbiddenException,
    );
  });

  it('no user -> 403', () => {
    const guard = guardWith(['admin']);
    expect(() => guard.canActivate(context(undefined))).toThrow(ForbiddenException);
  });
});
