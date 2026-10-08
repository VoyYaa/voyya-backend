import type { Role } from '@voyyaa/shared';
import type { Request } from 'express';

export interface AuthenticatedUser {
  userId: number;
  role: Role;
  companyId?: number;
}

export interface RequestWithTenant extends Request {
  user?: AuthenticatedUser;
  tenant?: { companyId: number };
}
