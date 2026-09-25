import type { Request } from 'express';

export function toRoutePattern(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) ? ':id' : segment))
    .join('/');
}

export function resolveRoute(req: Request): string {
  const path = req.route?.path as string | undefined;
  if (path) return `${req.baseUrl}${path}`;
  return toRoutePattern(req.path);
}
