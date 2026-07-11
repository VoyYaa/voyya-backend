import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@voyyaa/shared';
import type { RequestWithTenant } from '../../tenancy/tenant-request';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestWithTenant>();
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'No autorizado para este recurso' });
    }
    return true;
  }
}
