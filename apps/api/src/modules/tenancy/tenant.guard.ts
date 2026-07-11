import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { RequestConTenant } from './tenant-request';

/**
 * TenantGuard — garantiza que las rutas TENANT-scoped (p.ej. asignación) llevan un
 * `id_empresa` válido y lo fija en `req.tenant` para `@CurrentTenant()`.
 *
 * El tenant se toma EXCLUSIVAMENTE de `req.user.id_empresa` (del JWT firmado, puesto
 * por el AuthGuard). Ya NO hay fallback a la cabecera `x-empresa-id` (ADR-005 · C-1).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestConTenant>();
    const idEmpresa = req.user?.id_empresa;

    if (idEmpresa === undefined || !Number.isInteger(idEmpresa) || idEmpresa <= 0) {
      throw new ForbiddenException({
        codigo: 'FUERA_DE_TENANT',
        mensaje: 'Tenant (id_empresa) ausente o inválido',
      });
    }

    req.tenant = { idEmpresa };
    return true;
  }
}
