import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Rol } from '@voyya/shared';
import type { RequestConTenant, UsuarioAutenticado } from '../../tenancy/tenant-request';
import { RolesGuard } from './roles.guard';

function contexto(user?: UsuarioAutenticado): ExecutionContext {
  const req = { user } as RequestConTenant;
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function guardCon(roles: Rol[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: () => roles } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  it('sin @Roles → permite', () => {
    const guard = guardCon(undefined);
    expect(guard.canActivate(contexto({ id_usuario: 1, rol: 'pasajero' }))).toBe(true);
  });

  it('rol coincide → permite', () => {
    const guard = guardCon(['conductor']);
    expect(guard.canActivate(contexto({ id_usuario: 1, rol: 'conductor', id_empresa: 2 }))).toBe(true);
  });

  it('rol no autorizado → 403 PROHIBIDO', () => {
    const guard = guardCon(['conductor']);
    expect(() => guard.canActivate(contexto({ id_usuario: 1, rol: 'pasajero' }))).toThrow(
      ForbiddenException,
    );
  });

  it('sin usuario → 403', () => {
    const guard = guardCon(['admin']);
    expect(() => guard.canActivate(contexto(undefined))).toThrow(ForbiddenException);
  });
});
