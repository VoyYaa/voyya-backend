import type { Rol } from '@voyya/shared';
import type { Request } from 'express';

/**
 * Identidad autenticada colocada por el AuthGuard en `req.user` (desde el JWT, o —
 * SOLO en dev y gated— desde cabeceras x-*, centralizado en el AuthGuard). `id_empresa`
 * presente para conductor/empresa. `tenant` lo fija el TenantGuard leyendo de `req.user`.
 */
export interface UsuarioAutenticado {
  id_usuario: number;
  rol: Rol;
  id_empresa?: number;
}

export interface RequestConTenant extends Request {
  user?: UsuarioAutenticado;
  tenant?: { idEmpresa: number };
}
