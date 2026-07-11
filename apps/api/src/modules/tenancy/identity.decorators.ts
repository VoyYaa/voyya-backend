import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestConTenant } from './tenant-request';

/** id_empresa del tenant (requiere TenantGuard antes en la cadena). */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const req = ctx.switchToHttp().getRequest<RequestConTenant>();
    const idEmpresa = req.tenant?.idEmpresa;
    if (idEmpresa === undefined) {
      throw new InternalServerErrorException('TenantGuard no se ejecutó antes de @CurrentTenant');
    }
    return idEmpresa;
  },
);

/**
 * id del usuario autenticado desde `req.user` (lo puebla el AuthGuard global desde el
 * JWT). Ya NO lee cabeceras: el fallback de dev está centralizado y gated en el AuthGuard.
 */
function idUsuarioAutenticado(ctx: ExecutionContext): number {
  const req = ctx.switchToHttp().getRequest<RequestConTenant>();
  const id = req.user?.id_usuario;
  if (id === undefined) {
    throw new UnauthorizedException({ codigo: 'SESION_REQUERIDA', mensaje: 'Sesión requerida' });
  }
  return id;
}

/** id del pasajero (el rol lo garantiza el RolesGuard). */
export const CurrentPasajero = createParamDecorator((_d: unknown, ctx: ExecutionContext): number =>
  idUsuarioAutenticado(ctx),
);

/** id del conductor (el rol lo garantiza el RolesGuard). */
export const CurrentConductor = createParamDecorator((_d: unknown, ctx: ExecutionContext): number =>
  idUsuarioAutenticado(ctx),
);
