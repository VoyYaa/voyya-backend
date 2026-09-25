import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { resolveRoute } from '../infrastructure/observability/route-pattern';
import { requestContext } from '../infrastructure/observability/request-context.service';
import { captureError } from '../infrastructure/observability/sentry';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      if (status >= 500) {
        this.logger.error({
          msg: 'unhandled_http_exception',
          status,
          route: resolveRoute(req),
          stack: exception.stack,
        });
        captureError(exception);
      } else {
        this.logger.warn({
          msg: 'http_exception',
          status,
          code: extractCode(body),
          route: resolveRoute(req),
        });
      }

      res.status(status).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error({ msg: 'unhandled_error', route: resolveRoute(req), stack });
    captureError(exception);

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor',
      request_id: requestContext.get()?.requestId,
    });
  }
}

function extractCode(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
