import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAccessPayload } from '@voyya/shared';
import type { Request } from 'express';
import { EnvService } from '../../../config/env.service';
import type { RequestConTenant, UsuarioAutenticado } from '../../tenancy/tenant-request';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * AuthGuard GLOBAL (ADR-005 §7). Salta rutas `@Public()`; en el resto exige
 * `Authorization: Bearer <access_token>`, verifica firma+expiración y puebla
 * `req.user`. El FALLBACK de cabeceras de dev está CENTRALIZADO aquí y GATED:
 * solo si `AUTH_DEV_HEADERS===true` Y `NODE_ENV!=='production'` (ADR-005 §8 · C-1).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly env: EnvService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<RequestConTenant>();

    const token = extraerBearer(req);
    if (token) {
      const user = this.verificar(token);
      if (!user) throw sesionRequerida();
      req.user = user;
      return true;
    }

    if (this.devHeadersHabilitado()) {
      const user = usuarioDesdeHeaders(req);
      if (user) {
        req.user = user;
        return true;
      }
    }

    throw sesionRequerida();
  }

  private verificar(token: string): UsuarioAutenticado | null {
    let decoded: unknown;
    try {
      decoded = this.jwt.verify(token);
    } catch {
      return null; // firma inválida o expirado
    }
    const parsed = JwtAccessPayload.safeParse(decoded);
    if (!parsed.success || parsed.data.type !== 'access') return null;
    return {
      id_usuario: parsed.data.sub,
      rol: parsed.data.rol,
      id_empresa: parsed.data.id_empresa,
    };
  }

  private devHeadersHabilitado(): boolean {
    return this.env.get('AUTH_DEV_HEADERS') === true && this.env.get('NODE_ENV') !== 'production';
  }
}

function sesionRequerida(): UnauthorizedException {
  return new UnauthorizedException({ codigo: 'SESION_REQUERIDA', mensaje: 'Sesión requerida' });
}

function extraerBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const [tipo, valor] = h.split(' ');
  return tipo === 'Bearer' && valor ? valor : null;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : undefined;
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Identidad desde cabeceras de dev (solo cuando el gate está activo). */
function usuarioDesdeHeaders(req: RequestConTenant): UsuarioAutenticado | null {
  const idConductor = num(req.headers['x-conductor-id']);
  if (idConductor !== undefined) {
    return { id_usuario: idConductor, rol: 'conductor', id_empresa: num(req.headers['x-empresa-id']) };
  }
  const idCliente = num(req.headers['x-cliente-id']);
  if (idCliente !== undefined) return { id_usuario: idCliente, rol: 'pasajero' };
  return null;
}
