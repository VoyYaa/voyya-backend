import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAccessPayload } from '@voyyaa/shared';
import type { Request } from 'express';
import { EnvService } from '../../../config/env.service';
import type { RequestWithTenant, AuthenticatedUser } from '../../tenancy/tenant-request';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

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

    const req = context.switchToHttp().getRequest<RequestWithTenant>();

    const token = extractBearer(req);
    if (token) {
      const user = this.verify(token);
      if (!user) throw sessionRequired();
      req.user = user;
      return true;
    }

    if (this.devHeadersEnabled()) {
      const user = userFromHeaders(req);
      if (user) {
        req.user = user;
        return true;
      }
    }

    throw sessionRequired();
  }

  private verify(token: string): AuthenticatedUser | null {
    let decoded: unknown;
    try {
      decoded = this.jwt.verify(token);
    } catch {
      return null;
    }
    const parsed = JwtAccessPayload.safeParse(decoded);
    if (!parsed.success || parsed.data.type !== 'access') return null;
    return {
      userId: parsed.data.sub,
      role: parsed.data.role,
      companyId: parsed.data.company_id,
    };
  }

  private devHeadersEnabled(): boolean {
    return this.env.get('AUTH_DEV_HEADERS') === true && this.env.get('NODE_ENV') !== 'production';
  }
}

function sessionRequired(): UnauthorizedException {
  return new UnauthorizedException({ code: 'SESSION_REQUIRED', message: 'Sesión requerida' });
}

function extractBearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const [type, value] = h.split(' ');
  return type === 'Bearer' && value ? value : null;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : undefined;
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

function userFromHeaders(req: RequestWithTenant): AuthenticatedUser | null {
  const driverId = num(req.headers['x-driver-id']);
  if (driverId !== undefined) {
    return { userId: driverId, role: 'driver', companyId: num(req.headers['x-company-id']) };
  }
  const passengerId = num(req.headers['x-passenger-id']);
  if (passengerId !== undefined) return { userId: passengerId, role: 'passenger' };
  return null;
}
