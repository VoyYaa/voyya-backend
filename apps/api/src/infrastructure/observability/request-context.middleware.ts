import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { resolveRoute } from './route-pattern';
import type { RequestContextService } from './request-context.service';

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UNLOGGED_PATHS = new Set(['/health', '/health/db']);

const accessLog = new Logger('AccessLog');

function resolveRequestId(req: Request): string {
  const header = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  if (typeof candidate === 'string' && VALID_REQUEST_ID.test(candidate)) return candidate;
  return randomUUID();
}

export function createRequestContextMiddleware(requestContext: RequestContextService) {
  return function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
    const requestId = resolveRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    requestContext.run({ requestId }, () => {
      const start = process.hrtime.bigint();

      res.on('finish', () => {
        if (UNLOGGED_PATHS.has(req.path) && res.statusCode < 400) return;

        const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        const context = requestContext.get();
        const line = {
          msg: 'http',
          method: req.method,
          route: resolveRoute(req),
          status: res.statusCode,
          duration_ms: Math.round(durationMs),
          request_id: context?.requestId ?? requestId,
          user_id: context?.userId,
        };

        if (res.statusCode >= 500) accessLog.error(line);
        else if (res.statusCode >= 400) accessLog.warn(line);
        else accessLog.log(line);
      });

      next();
    });
  };
}
