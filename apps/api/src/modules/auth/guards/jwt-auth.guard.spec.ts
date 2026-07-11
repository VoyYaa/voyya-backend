import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { EnvService } from '../../../config/env.service';
import type { RequestConTenant } from '../../tenancy/tenant-request';
import { JwtAuthGuard } from './jwt-auth.guard';

interface Opciones {
  isPublic?: boolean;
  headers?: Record<string, string>;
  jwtPayload?: unknown;
  jwtThrows?: boolean;
  devHeaders?: boolean;
  nodeEnv?: string;
}

function contexto(req: RequestConTenant): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function crearGuard(o: Opciones): { guard: JwtAuthGuard; req: RequestConTenant } {
  const reflector = { getAllAndOverride: () => o.isPublic ?? false } as unknown as Reflector;
  const jwt = {
    verify: () => {
      if (o.jwtThrows) throw new Error('invalid');
      return o.jwtPayload;
    },
  } as unknown as JwtService;
  const env = {
    get: (k: string) =>
      k === 'AUTH_DEV_HEADERS' ? (o.devHeaders ?? false) : k === 'NODE_ENV' ? (o.nodeEnv ?? 'development') : undefined,
  } as unknown as EnvService;
  const req = { headers: o.headers ?? {} } as unknown as RequestConTenant;
  return { guard: new JwtAuthGuard(reflector, jwt, env), req };
}

describe('JwtAuthGuard', () => {
  it('ruta @Public → pasa sin token', () => {
    const { guard, req } = crearGuard({ isPublic: true });
    expect(guard.canActivate(contexto(req))).toBe(true);
  });

  it('sin token → 401 SESION_REQUERIDA', () => {
    const { guard, req } = crearGuard({});
    expect(() => guard.canActivate(contexto(req))).toThrow(UnauthorizedException);
  });

  it('Bearer válido → puebla req.user desde el JWT', () => {
    const { guard, req } = crearGuard({
      headers: { authorization: 'Bearer abc' },
      jwtPayload: { sub: 5, rol: 'conductor', id_empresa: 2, type: 'access' },
    });
    expect(guard.canActivate(contexto(req))).toBe(true);
    expect(req.user).toEqual({ id_usuario: 5, rol: 'conductor', id_empresa: 2 });
  });

  it('token inválido/expirado → 401', () => {
    const { guard, req } = crearGuard({ headers: { authorization: 'Bearer x' }, jwtThrows: true });
    expect(() => guard.canActivate(contexto(req))).toThrow(UnauthorizedException);
  });

  it('token con type != access → 401', () => {
    const { guard, req } = crearGuard({
      headers: { authorization: 'Bearer x' },
      jwtPayload: { sub: 5, rol: 'conductor', type: 'refresh' },
    });
    expect(() => guard.canActivate(contexto(req))).toThrow(UnauthorizedException);
  });

  it('gate dev ON (no-prod) → acepta cabeceras x-* y puebla req.user', () => {
    const { guard, req } = crearGuard({
      devHeaders: true,
      nodeEnv: 'development',
      headers: { 'x-conductor-id': '5', 'x-empresa-id': '2' },
    });
    expect(guard.canActivate(contexto(req))).toBe(true);
    expect(req.user).toEqual({ id_usuario: 5, rol: 'conductor', id_empresa: 2 });
  });

  it('gate dev OFF → ignora cabeceras x-* → 401', () => {
    const { guard, req } = crearGuard({
      devHeaders: false,
      headers: { 'x-conductor-id': '5' },
    });
    expect(() => guard.canActivate(contexto(req))).toThrow(UnauthorizedException);
  });

  it('en PRODUCCIÓN las cabeceras x-* se ignoran aunque el flag esté ON (C-1)', () => {
    const { guard, req } = crearGuard({
      devHeaders: true,
      nodeEnv: 'production',
      headers: { 'x-conductor-id': '5' },
    });
    expect(() => guard.canActivate(contexto(req))).toThrow(UnauthorizedException);
  });
});
