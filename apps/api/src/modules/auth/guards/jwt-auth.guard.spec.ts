import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { EnvService } from '../../../config/env.service';
import type { RequestWithTenant } from '../../tenancy/tenant-request';
import { JwtAuthGuard } from './jwt-auth.guard';

interface Options {
  isPublic?: boolean;
  headers?: Record<string, string>;
  jwtPayload?: unknown;
  jwtThrows?: boolean;
  devHeaders?: boolean;
  nodeEnv?: string;
}

function context(req: RequestWithTenant): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function createGuard(o: Options): { guard: JwtAuthGuard; req: RequestWithTenant } {
  const reflector = { getAllAndOverride: () => o.isPublic ?? false } as unknown as Reflector;
  const jwt = {
    verify: () => {
      if (o.jwtThrows) throw new Error('invalid');
      return o.jwtPayload;
    },
  } as unknown as JwtService;
  const env = {
    get: (k: string) =>
      k === 'AUTH_DEV_HEADERS'
        ? (o.devHeaders ?? false)
        : k === 'NODE_ENV'
          ? (o.nodeEnv ?? 'development')
          : undefined,
  } as unknown as EnvService;
  const req = { headers: o.headers ?? {} } as unknown as RequestWithTenant;
  return { guard: new JwtAuthGuard(reflector, jwt, env), req };
}

describe('JwtAuthGuard', () => {
  it('@Public route -> passes without token', () => {
    const { guard, req } = createGuard({ isPublic: true });
    expect(guard.canActivate(context(req))).toBe(true);
  });

  it('no token -> 401 SESSION_REQUIRED', () => {
    const { guard, req } = createGuard({});
    expect(() => guard.canActivate(context(req))).toThrow(UnauthorizedException);
  });

  it('valid Bearer -> populates req.user from the JWT', () => {
    const { guard, req } = createGuard({
      headers: { authorization: 'Bearer abc' },
      jwtPayload: { sub: 5, role: 'driver', company_id: 2, type: 'access' },
    });
    expect(guard.canActivate(context(req))).toBe(true);
    expect(req.user).toEqual({ userId: 5, role: 'driver', companyId: 2 });
  });

  it('invalid/expired token -> 401', () => {
    const { guard, req } = createGuard({ headers: { authorization: 'Bearer x' }, jwtThrows: true });
    expect(() => guard.canActivate(context(req))).toThrow(UnauthorizedException);
  });

  it('token with type != access -> 401', () => {
    const { guard, req } = createGuard({
      headers: { authorization: 'Bearer x' },
      jwtPayload: { sub: 5, role: 'driver', type: 'refresh' },
    });
    expect(() => guard.canActivate(context(req))).toThrow(UnauthorizedException);
  });

  it('dev gate ON (non-prod) -> accepts x-* headers and populates req.user', () => {
    const { guard, req } = createGuard({
      devHeaders: true,
      nodeEnv: 'development',
      headers: { 'x-driver-id': '5', 'x-company-id': '2' },
    });
    expect(guard.canActivate(context(req))).toBe(true);
    expect(req.user).toEqual({ userId: 5, role: 'driver', companyId: 2 });
  });

  it('dev gate OFF -> ignores x-* headers -> 401', () => {
    const { guard, req } = createGuard({
      devHeaders: false,
      headers: { 'x-driver-id': '5' },
    });
    expect(() => guard.canActivate(context(req))).toThrow(UnauthorizedException);
  });

  it('in PRODUCTION x-* headers are ignored even if the flag is ON', () => {
    const { guard, req } = createGuard({
      devHeaders: true,
      nodeEnv: 'production',
      headers: { 'x-driver-id': '5' },
    });
    expect(() => guard.canActivate(context(req))).toThrow(UnauthorizedException);
  });
});
