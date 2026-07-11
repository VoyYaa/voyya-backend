import { SetMetadata } from '@nestjs/common';
import type { Rol } from '@voyya/shared';

export const ROLES_KEY = 'roles';

/** Restringe una ruta a los roles indicados (RolesGuard global — ADR-005 §7). */
export const Roles = (...roles: Rol[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
