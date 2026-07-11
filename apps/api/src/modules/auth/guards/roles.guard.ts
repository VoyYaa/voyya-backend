import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Rol } from '@voyya/shared';
import type { RequestConTenant } from '../../tenancy/tenant-request';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * RolesGuard GLOBAL (tras el AuthGuard). Si la ruta declara `@Roles(...)`, exige que
 * `req.user.rol` esté entre ellos → 403 PROHIBIDO. Sin `@Roles` no restringe.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Rol[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestConTenant>();
    const rol = req.user?.rol;
    if (!rol || !roles.includes(rol)) {
      throw new ForbiddenException({ codigo: 'PROHIBIDO', mensaje: 'No autorizado para este recurso' });
    }
    return true;
  }
}
